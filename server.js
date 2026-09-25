import http from "node:http";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "ink-stick-testing.json");
const port = Number(process.env.PORT || 3037);
const DB_VERSION = 2;
const seed = {
  "items": [
    {
      "code": "IS-001",
      "smokeSource": "黄山松烟",
      "glueRatio": "7.5%",
      "ageYears": 8,
      "storage": "恒湿柜B",
      "status": "已试磨",
      "logs": [
        {
          "at": "2026-06-11",
          "step": "试磨",
          "note": "宣纸20滴水，出墨快，评分86",
          "score": 86
        }
      ]
    },
    {
      "code": "IS-002",
      "smokeSource": "桐油烟",
      "glueRatio": "8%",
      "ageYears": 3,
      "storage": "试样盒C",
      "status": "待试磨",
      "logs": []
    }
  ]
};
const fields = [["code","墨锭编号","text"],["smokeSource","烟料来源","text"],["glueRatio","胶料比例","text"],["ageYears","存放年限","number"],["storage","存放位置","text"]];
const stages = ["待试磨","已试磨","重点观察"];
const statLabels = ["待试磨","已试磨","重点观察"];
const extraFields = [["paper","试磨纸张"],["water","加水量"],["speed","出墨速度"],["colorLayer","墨色层次"],["sediment","沉淀情况"],["score","评分"],["note","备注"]];
const editableFields = ["code","smokeSource","glueRatio","ageYears","storage","status"];

async function loadDb() {
  return JSON.parse(await readFile(dbPath, "utf8"));
}
async function saveDb(db) {
  const tmp = dbPath + ".tmp";
  await writeFile(tmp, JSON.stringify(db, null, 2));
  await rename(tmp, dbPath);
}
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function html(res, text) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(text);
}
function newId() { return "IS-" + Date.now(); }
let batchSeq = 0;
function newBatchId() { return "B-" + Date.now().toString(36) + "-" + (++batchSeq); }
function makeBatch(input, at) {
  return {
    id: newBatchId(),
    at: at || new Date().toISOString(),
    paper: input.paper || "",
    water: input.water || "",
    speed: input.speed || "",
    colorLayer: input.colorLayer || "",
    sediment: input.sediment || "",
    score: Number(input.score || 0),
    note: input.note || "",
    review: { status: "pending", by: null, at: null, reason: null, revision: 0, history: [] }
  };
}
function parseLegacyNote(note) {
  const out = { paper: "", water: "" };
  const m = String(note || "").match(/^([^\d，,]{1,10}?)(\d+滴)/);
  if (m) { out.paper = m[1]; out.water = m[2]; }
  return out;
}
// 旧数据升级：tests 数组和日志里的试磨记录转成待复核批次
function migrate(db) {
  if (db.version >= DB_VERSION) return false;
  for (const item of db.items || []) {
    item.logs ||= [];
    item.batches ||= [];
    const seen = new Set(item.batches.map(b => b.at + "|" + b.score));
    for (const t of item.tests || []) {
      const score = Number(t.score || 0);
      const key = t.at + "|" + score;
      if (seen.has(key)) continue;
      seen.add(key);
      item.batches.push(makeBatch({ ...t, score }, t.at));
    }
    for (const l of item.logs) {
      if (l.step !== "试磨" || typeof l.score !== "number") continue;
      const key = l.at + "|" + l.score;
      if (seen.has(key)) continue;
      seen.add(key);
      item.batches.push(makeBatch({ ...parseLegacyNote(l.note), score: l.score, note: l.note }, l.at));
    }
    delete item.tests;
    item.batches.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  }
  db.version = DB_VERSION;
  return true;
}
async function ensureDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  const db = await loadDb();
  if (migrate(db)) await saveDb(db);
}
// 写操作串行化：load→校验→save 作为一个整体，避免并发复核互相覆盖
let queue = Promise.resolve();
function mutate(fn) {
  const run = queue.then(fn);
  queue = run.then(() => {}, () => {});
  return run;
}
function findItem(db, key) {
  return db.items.find(x => x.id === key || x.code === key);
}
function confirmedBatches(item) {
  return (item.batches || [])
    .filter(b => b.review && b.review.status === "confirmed")
    .sort((a, b) => String(b.review.at).localeCompare(String(a.review.at)));
}
function computeStats(items) {
  const stats = Object.fromEntries(statLabels.map(label => [label, 0]));
  let pending = 0;
  for (const item of items) {
    if (stats[item.status] !== undefined) stats[item.status] += 1;
    pending += (item.batches || []).filter(b => b.review && b.review.status === "pending").length;
  }
  stats["待复核批次"] = pending;
  return stats;
}
function summarize(item) {
  const batches = item.batches || [];
  const confirmed = confirmedBatches(item);
  return {
    ...item,
    finalScore: confirmed.length ? confirmed[0].score : null,
    pendingCount: batches.filter(b => b.review && b.review.status === "pending").length,
    logCount: (item.logs || []).length
  };
}
async function createBatch(itemKey, input) {
  return mutate(async () => {
    const db = await loadDb();
    const item = findItem(db, itemKey);
    if (!item) return { status: 404, data: { error: "item_not_found" } };
    item.batches ||= [];
    item.logs ||= [];
    const batch = makeBatch(input);
    item.batches.push(batch);
    item.logs.push({ at: batch.at, step: "试磨", note: (batch.paper || "试纸") + "，评分" + batch.score + "（待复核）", score: batch.score });
    await saveDb(db);
    return { status: 201, data: summarize(item) };
  });
}
function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>墨锭试磨室</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:68px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; } button.secondary { background:#69736a; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:140px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:12px; } .card { display:grid; gap:8px; align-content:start; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:90px; overflow:auto; } .warn { color:var(--warn); font-weight:700; }
    .batches { display:grid; gap:8px; border-top:1px solid var(--line); padding-top:8px; }
    .batch { border:1px solid var(--line); border-radius:6px; padding:8px; display:grid; gap:6px; font-size:14px; }
    .batch .acts { display:flex; gap:8px; } .batch button { padding:6px 10px; }
    .history { border-top:1px dashed var(--line); padding-top:4px; display:grid; gap:2px; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header><div><h1>墨锭试磨室</h1><div class="meta">墨锭建档、试磨批次复核与评分统计</div></div><button id="reload">刷新</button></header>
  <main>
    <section>
      <form id="createForm"><h2>新增墨锭</h2><div id="fields"></div><label>初始状态</label><select name="status">${stages.map(s => '<option>'+s+'</option>').join('')}</select><button>保存墨锭</button></form>
      <form id="actionForm" style="margin-top:14px"><h2>提交试磨批次</h2><label>选择墨锭</label><select name="id" id="itemSelect"></select><div id="extraFields"></div><button>提交批次（待复核）</button></form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="toolbar"><select id="statusFilter"><option value="">全部状态</option>${stages.map(s => '<option>'+s+'</option>').join('')}</select><input id="search" placeholder="搜索编号或关键词"><input id="reviewer" placeholder="复核人姓名"></div>
      <div class="panel"><h2>每次试磨独立成批，需复核确认；退回需写明原因，可修改后重提。最终评分取最近确认批次。</h2><div class="grid" id="cards"></div></div>
    </section>
  </main>
  <script>
    const fields = [["code","墨锭编号","text"],["smokeSource","烟料来源","text"],["glueRatio","胶料比例","text"],["ageYears","存放年限","number"],["storage","存放位置","text"]];
    const stages = ["待试磨","已试磨","重点观察"];
    const extraFields = [["paper","试磨纸张"],["water","加水量"],["speed","出墨速度"],["colorLayer","墨色层次"],["sediment","沉淀情况"],["score","评分"],["note","备注"]];
    const reviewLabels = { pending:"待复核", confirmed:"已确认", returned:"已退回" };
    const actionLabels = { confirm:"确认", return:"退回", resubmit:"重提" };
    const createForm = document.querySelector('#createForm');
    const actionForm = document.querySelector('#actionForm');
    const cards = document.querySelector('#cards');
    const statsEl = document.querySelector('#stats');
    const itemSelect = document.querySelector('#itemSelect');
    const reviewerInput = document.querySelector('#reviewer');
    let items = [];
    function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
    function fmt(t) { return String(t || '').replace('T', ' ').slice(0, 16); }
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ 'Content-Type':'application/json' } } : options);
      const data = await res.json();
      if (!res.ok) { const err = new Error(data.error || '请求失败'); err.data = data; throw err; }
      return data;
    }
    function reviewer() { return (reviewerInput.value || '').trim() || '未署名'; }
    reviewerInput.value = localStorage.getItem('reviewer') || '';
    reviewerInput.oninput = () => localStorage.setItem('reviewer', reviewerInput.value);
    function renderForms() {
      document.querySelector('#fields').innerHTML = fields.map(([key,label,type]) => '<label>'+label+'</label><input name="'+key+'" type="'+type+'" '+(key==='code'?'required':'')+'>').join('');
      document.querySelector('#extraFields').innerHTML = extraFields.map(([key,label]) => '<label>'+label+'</label><input name="'+key+'" '+(key==='score'?'type="number"':'')+'>').join('');
    }
    function render() {
      itemSelect.innerHTML = items.map(item => '<option value="'+esc(item.id || item.code)+'">'+esc(item.code || item.id)+' · '+esc(item.smokeSource || '')+'</option>').join('');
      const stats = Object.fromEntries(stages.map(s => [s, items.filter(i => i.status === s).length]));
      stats['待复核批次'] = items.reduce((n, i) => n + (i.pendingCount || 0), 0);
      statsEl.innerHTML = Object.entries(stats).map(([k,v]) => '<div class="stat"><span>'+k+'</span><strong>'+v+'</strong></div>').join('');
      const status = document.querySelector('#statusFilter').value;
      const q = document.querySelector('#search').value.trim();
      const visible = items.filter(item => (!status || item.status === status) && (!q || JSON.stringify(item).includes(q)));
      cards.innerHTML = visible.map(item => cardHtml(item)).join('');
      document.querySelectorAll('[data-status]').forEach(sel => sel.onchange = async () => { await api('/api/items/'+sel.dataset.status, { method:'PATCH', body: JSON.stringify({ status: sel.value }) }); await load(); });
      document.querySelectorAll('[data-note]').forEach(btn => btn.onclick = async () => { const id = btn.dataset.note; const note = prompt('记录备注'); if (note) { await api('/api/items/'+id+'/logs', { method:'POST', body: JSON.stringify({ step:'备注', note }) }); await load(); } });
    }
    function batchHtml(item, batch) {
      const r = batch.review || { status:'pending', revision:0 };
      const itemId = item.id || item.code;
      const pairs = [['纸张',batch.paper],['水量',batch.water],['速度',batch.speed],['墨色',batch.colorLayer],['沉淀',batch.sediment]].filter(p => p[1]).map(p => p[0]+' '+esc(p[1])).join(' · ');
      let html = '<div class="batch"><div><span class="pill">'+(reviewLabels[r.status] || r.status)+'</span> <span class="meta">'+esc(batch.id)+' · '+fmt(batch.at)+'</span></div>';
      html += '<div>'+(pairs ? pairs+' · ' : '')+'评分 '+esc(batch.score)+'</div>';
      if (batch.note) html += '<div class="meta">备注：'+esc(batch.note)+'</div>';
      if (r.status === 'confirmed') html += '<div class="meta">复核：'+esc(r.by || '')+' 确认于 '+fmt(r.at)+'</div>';
      if (r.status === 'returned') html += '<div class="warn">退回原因：'+esc(r.reason || '')+'</div><div class="meta">复核：'+esc(r.by || '')+' 退回于 '+fmt(r.at)+'</div>';
      if (r.status === 'pending') html += '<div class="acts"><button data-act="confirm" data-item="'+esc(itemId)+'" data-batch="'+esc(batch.id)+'" data-rev="'+r.revision+'">确认</button><button class="secondary" data-act="return" data-item="'+esc(itemId)+'" data-batch="'+esc(batch.id)+'" data-rev="'+r.revision+'">退回</button></div>';
      if (r.status === 'returned') html += '<div class="acts"><button data-act="resubmit" data-item="'+esc(itemId)+'" data-batch="'+esc(batch.id)+'" data-rev="'+r.revision+'">修改后重提</button></div>';
      const history = (r.history || []).map(h => '<div class="meta">'+fmt(h.at)+' · '+esc(h.by || '')+' · '+(actionLabels[h.action] || h.action)+(h.reason ? '：'+esc(h.reason) : '')+'</div>').join('');
      if (history) html += '<div class="history">'+history+'</div>';
      return html + '</div>';
    }
    function cardHtml(item) {
      const main = fields.slice(0,4).map(([key,label]) => '<div><b>'+label+'</b> '+esc(item[key] ?? '')+'</div>').join('');
      const logs = (item.logs || []).slice(-4).map(l => '<div>'+esc(l.step)+'：'+esc(l.note)+'</div>').join('');
      const batches = (item.batches || []).slice().reverse();
      const finalScore = item.finalScore == null ? '暂无确认批次' : esc(item.finalScore)+' 分';
      return '<article class="card"><h3>'+esc(item.code || item.id)+'</h3><span class="pill">'+esc(item.status)+'</span>'+main+
        '<div><b>最终评分</b> '+finalScore+' <span class="meta">取最近确认批次</span></div>'+
        '<label>状态</label><select data-status="'+esc(item.id || item.code)+'">'+stages.map(s => '<option '+(s===item.status?'selected':'')+'>'+s+'</option>').join('')+'</select>'+
        '<button class="secondary" data-note="'+esc(item.id || item.code)+'">追加备注</button>'+
        '<div class="batches"><b>试磨批次（'+batches.length+'）</b>'+(batches.map(b => batchHtml(item, b)).join('') || '<div class="meta">暂无批次</div>')+'</div>'+
        '<div class="logs meta">'+(logs || '暂无记录')+'</div></article>';
    }
    cards.addEventListener('click', async event => {
      const btn = event.target.closest('[data-act]');
      if (!btn) return;
      const payload = { action: btn.dataset.act, by: reviewer(), expectedRevision: Number(btn.dataset.rev) };
      if (payload.action === 'return') {
        const reason = prompt('请输入退回原因（必填）');
        if (!reason || !reason.trim()) return;
        payload.reason = reason.trim();
      }
      try {
        await api('/api/items/'+btn.dataset.item+'/batches/'+btn.dataset.batch+'/review', { method:'POST', body: JSON.stringify(payload) });
      } catch (error) {
        if (error.data && error.data.error === 'batch_already_processed') {
          const r = error.data.review || {};
          alert('该批次已由 '+(r.by || '他人')+' 处理（'+(reviewLabels[r.status] || r.status)+'），未覆盖先前结论。');
        } else {
          alert(error.message);
        }
      }
      await load();
    });
    async function load() { items = await api('/api/items'); render(); }
    createForm.onsubmit = async event => { event.preventDefault(); await api('/api/items', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(createForm).entries())) }); createForm.reset(); await load(); };
    actionForm.onsubmit = async event => { event.preventDefault(); await api('/api/items/'+itemSelect.value+'/batches', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(actionForm).entries())) }); actionForm.reset(); await load(); };
    document.querySelector('#statusFilter').onchange = render; document.querySelector('#search').oninput = render; document.querySelector('#reload').onclick = load;
    renderForms(); load();
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/") return html(res, page());
    if (req.method === "GET" && url.pathname === "/api/items") {
      const db = await loadDb();
      return send(res, 200, db.items.map(summarize));
    }
    if (req.method === "GET" && url.pathname === "/api/stats") {
      const db = await loadDb();
      return send(res, 200, computeStats(db.items));
    }
    if (req.method === "POST" && url.pathname === "/api/items") {
      const input = await body(req);
      const result = await mutate(async () => {
        const db = await loadDb();
        const item = { id: newId(), logs: [{ at: new Date().toISOString(), step: "建档", note: "创建墨锭" }], batches: [] };
        for (const key of editableFields) if (key in input) item[key] = input[key];
        item.status ||= "待试磨";
        db.items.unshift(item);
        await saveDb(db);
        return { status: 201, data: summarize(item) };
      });
      return send(res, result.status, result.data);
    }
    const review = url.pathname.match(/^\/api\/items\/([^/]+)\/batches\/([^/]+)\/review$/);
    if (review && req.method === "POST") {
      const input = await body(req);
      const result = await mutate(async () => {
        const db = await loadDb();
        const item = findItem(db, review[1]);
        if (!item) return { status: 404, data: { error: "item_not_found" } };
        const batch = (item.batches || []).find(b => b.id === review[2]);
        if (!batch) return { status: 404, data: { error: "batch_not_found" } };
        const r = batch.review;
        if (input.expectedRevision !== undefined && Number(input.expectedRevision) !== r.revision) {
          return { status: 409, data: { error: "batch_already_processed", review: r } };
        }
        const by = String(input.by || "").trim() || "未署名";
        const now = new Date().toISOString();
        const act = input.action;
        item.logs ||= [];
        if (act === "confirm" || act === "return") {
          if (r.status !== "pending") return { status: 409, data: { error: "batch_already_processed", review: r } };
          if (act === "return") {
            const reason = String(input.reason || "").trim();
            if (!reason) return { status: 400, data: { error: "reason_required" } };
            r.status = "returned";
            r.reason = reason;
          } else {
            r.status = "confirmed";
            r.reason = null;
          }
          r.by = by;
          r.at = now;
          r.revision += 1;
          r.history.push({ action: act, by, at: now, reason: r.reason });
          item.logs.push({ at: now, step: act === "confirm" ? "复核确认" : "复核退回", note: "批次" + batch.id + "，复核人：" + by + (r.reason ? "，原因：" + r.reason : "") });
          const latest = confirmedBatches(item)[0];
          if (latest) item.status = latest.score >= 85 ? "已试磨" : "重点观察";
        } else if (act === "resubmit") {
          if (r.status !== "returned") return { status: 409, data: { error: "batch_already_processed", review: r } };
          r.status = "pending";
          r.revision += 1;
          r.history.push({ action: "resubmit", by, at: now, reason: null });
          item.logs.push({ at: now, step: "重新提交", note: "批次" + batch.id + "修改后重提，提交人：" + by });
        } else {
          return { status: 400, data: { error: "unknown_action" } };
        }
        await saveDb(db);
        return { status: 200, data: summarize(item) };
      });
      return send(res, result.status, result.data);
    }
    const batches = url.pathname.match(/^\/api\/items\/([^/]+)\/batches$/);
    if (batches && req.method === "POST") {
      const result = await createBatch(batches[1], await body(req));
      return send(res, result.status, result.data);
    }
    const action = url.pathname.match(/^\/api\/items\/([^/]+)\/action$/);
    if (action && req.method === "POST") {
      const result = await createBatch(action[1], await body(req));
      return send(res, result.status, result.data);
    }
    const patch = url.pathname.match(/^\/api\/items\/([^/]+)$/);
    if (patch && req.method === "PATCH") {
      const input = await body(req);
      const result = await mutate(async () => {
        const db = await loadDb();
        const item = findItem(db, patch[1]);
        if (!item) return { status: 404, data: { error: "item_not_found" } };
        for (const key of editableFields) if (key in input) item[key] = input[key];
        item.logs ||= [];
        item.logs.push({ at: new Date().toISOString(), step: "状态", note: "更新为" + item.status });
        await saveDb(db);
        return { status: 200, data: summarize(item) };
      });
      return send(res, result.status, result.data);
    }
    const log = url.pathname.match(/^\/api\/items\/([^/]+)\/logs$/);
    if (log && req.method === "POST") {
      const input = await body(req);
      const result = await mutate(async () => {
        const db = await loadDb();
        const item = findItem(db, log[1]);
        if (!item) return { status: 404, data: { error: "item_not_found" } };
        item.logs ||= [];
        item.logs.push({ at: new Date().toISOString(), step: input.step || "记录", note: input.note || "" });
        await saveDb(db);
        return { status: 201, data: summarize(item) };
      });
      return send(res, result.status, result.data);
    }
    send(res, 404, { error: "not_found" });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
});
ensureDb().then(() => {
  server.listen(port, () => console.log("墨锭试磨室 listening on http://localhost:" + port));
}).catch(error => {
  console.error("启动失败：", error);
  process.exit(1);
});
