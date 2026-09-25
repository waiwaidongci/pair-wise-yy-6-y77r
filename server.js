import http from "node:http";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "ink-stick-testing.json");
const port = Number(process.env.PORT || 3037);
const schemaVersion = 2;

const seed = {
  schemaVersion,
  "items": [
    {
      id: "IS-001",
      code: "IS-001",
      smokeSource: "黄山松烟",
      glueRatio: "7.5%",
      ageYears: 8,
      storage: "恒湿柜B",
      status: "已试磨",
      logs: [
        {
          at: "2026-06-11",
          step: "试磨",
          note: "宣纸20滴水，出墨快，评分86",
          score: 86
        }
      ],
      batches: [
        {
          id: "B-IS001-01",
          at: "2026-06-11T00:00:00.000Z",
          paper: "宣纸",
          water: "20滴",
          speed: "快",
          colorLayer: "",
          sediment: "",
          score: 86,
          note: "出墨快（旧记录升级）",
          legacy: true,
          status: "pending",
          review: null,
          history: [],
          version: 1
        }
      ]
    },
    {
      id: "IS-002",
      code: "IS-002",
      smokeSource: "桐油烟",
      glueRatio: "8%",
      ageYears: 3,
      storage: "试样盒C",
      status: "待试磨",
      logs: [],
      batches: []
    }
  ]
};
const fields = [["code","墨锭编号","text"],["smokeSource","烟料来源","text"],["glueRatio","胶料比例","text"],["ageYears","存放年限","number"],["storage","存放位置","text"]];
const stages = ["待试磨","已试磨","重点观察"];
const statLabels = ["待试磨","已试磨","重点观察"];
const extraFields = [["paper","试磨纸张"],["water","加水量"],["speed","出墨速度"],["colorLayer","墨色层次"],["sediment","沉淀情况"],["score","评分"]];

// 写操作串行化：两个复核请求同时到达时，后者在前者落盘后才读取，
// 从而看到批次已被处理，不会盖掉先前结论。
let chain = Promise.resolve();
function withLock(fn) {
  const result = chain.then(fn);
  chain = result.then(() => {}, () => {});
  return result;
}

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  if (migrate(db)) await saveDb(db);
  return db;
}
async function saveDb(db) {
  const tmp = dbPath + ".tmp";
  await writeFile(tmp, JSON.stringify(db, null, 2));
  await rename(tmp, dbPath);
}

// 旧数据升级：tests 与带评分的试磨日志各自独立成批，继续走复核流程。
function migrate(db) {
  let changed = false;
  if (db.schemaVersion !== schemaVersion) {
    db.schemaVersion = schemaVersion;
    changed = true;
    for (const item of db.items || []) {
      if (Array.isArray(item.batches)) continue;
      const batches = [];
      const knownAt = new Set();
      for (const t of item.tests || []) {
        batches.push({
          id: "B-legacy-" + (batches.length + 1) + "-" + Date.now().toString(36),
          at: t.at || new Date().toISOString(),
          paper: t.paper || "",
          water: t.water || "",
          speed: t.speed || "",
          colorLayer: t.colorLayer || "",
          sediment: t.sediment || "",
          score: Number(t.score || 0),
          note: "",
          legacy: true,
          status: "pending",
          review: null,
          history: [],
          version: 1
        });
        if (t.at) knownAt.add(t.at);
      }
      for (const l of item.logs || []) {
        if (l.step !== "试磨") continue;
        if (l.at && knownAt.has(l.at)) continue;
        batches.push({
          id: "B-legacy-" + (batches.length + 1) + "-" + Date.now().toString(36),
          at: l.at || new Date().toISOString(),
          paper: "",
          water: "",
          speed: "",
          colorLayer: "",
          sediment: "",
          score: Number(l.score || 0),
          note: l.note || "（旧试磨日志升级，结构化字段缺失）",
          legacy: true,
          status: "pending",
          review: null,
          history: [],
          version: 1
        });
      }
      item.batches = batches;
    }
  }
  return changed;
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
function newBatchId() {
  return "B-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function findItem(db, id) {
  return db.items.find(x => x.id === id || x.code === id);
}
function batchNo(item, batch) {
  return (item.batches || []).indexOf(batch) + 1;
}
// 最终评分：最近一次“已确认”批次的评分（按确认时间）。
function finalBatchOf(item) {
  let finalBatch = null;
  for (const b of item.batches || []) {
    if (b.status !== "confirmed") continue;
    const at = b.review?.at || b.at || "";
    if (!finalBatch || at > (finalBatch.review?.at || finalBatch.at || "")) finalBatch = b;
  }
  return finalBatch;
}
function computeStats(items) {
  const stats = Object.fromEntries(statLabels.map(label => [label, 0]));
  for (const item of items) {
    if (stats[item.status] !== undefined) stats[item.status] += 1;
  }
  return stats;
}
function summarize(item) {
  const batches = item.batches || [];
  const finalBatch = finalBatchOf(item);
  return {
    ...item,
    logCount: (item.logs || []).length,
    pendingCount: batches.filter(b => b.status === "pending").length,
    finalScore: finalBatch ? finalBatch.score : null,
    finalBatchId: finalBatch ? finalBatch.id : null
  };
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
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; } button.secondary { background:#69736a; } button.danger { background:var(--warn); } button.mini { padding:6px 10px; font-size:13px; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:160px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); gap:12px; } .card { display:grid; gap:8px; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:90px; overflow:auto; } .warn { color:var(--warn); font-weight:700; }
    .final { font-weight:700; color:var(--accent); }
    .batches { display:grid; gap:8px; border-top:1px solid var(--line); padding-top:8px; }
    .batch { border:1px solid var(--line); border-radius:6px; padding:8px 10px; background:#fafcf8; display:grid; gap:6px; }
    .batch-head { display:flex; gap:8px; align-items:center; flex-wrap:wrap; font-weight:700; font-size:13px; }
    .batch-fields { display:grid; grid-template-columns:repeat(2,1fr); gap:2px 12px; font-size:13px; }
    .bpill { border-radius:999px; padding:2px 8px; font-size:12px; border:1px solid var(--line); font-weight:400; }
    .bpill.pending { background:#fdf6e3; border-color:#e0c876; color:#8a6d1f; }
    .bpill.confirmed { background:#eef5e8; border-color:#9db88a; color:#3c5a2e; }
    .bpill.rejected { background:#f7ebe8; border-color:#cf988a; color:#8a3a26; }
    .trail { font-size:12px; color:var(--muted); display:grid; gap:2px; }
    .batch-actions { display:flex; gap:8px; flex-wrap:wrap; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header><div><h1>墨锭试磨室</h1><div class="meta">墨锭建档、批次试磨与复核评分</div></div><button id="reload">刷新</button></header>
  <main>
    <section>
      <div class="panel"><h2>当前复核人</h2><input id="reviewerName" placeholder="填写姓名，确认 / 退回 / 重提都会留名"></div>
      <form id="createForm" style="margin-top:14px"><h2>新增墨锭</h2><div id="fields"></div><label>初始状态</label><select name="status">${stages.map(s => '<option>'+s+'</option>').join('')}</select><button>保存墨锭</button></form>
      <form id="actionForm" style="margin-top:14px"><h2>新建试磨批次</h2><label>选择墨锭</label><select name="id" id="itemSelect"></select><div id="extraFields"></div><button>提交批次（待复核）</button></form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="toolbar"><select id="statusFilter"><option value="">全部状态</option>${stages.map(s => '<option>'+s+'</option>').join('')}</select><input id="search" placeholder="搜索编号或关键词"></div>
      <div class="panel"><h2>每次试磨独立成批；复核人可确认或退回（退回须填原因），退回后可重提。最终评分取最近确认批次。</h2><div class="grid" id="cards"></div></div>
    </section>
  </main>
  <script>
    const fields = [["code","墨锭编号","text"],["smokeSource","烟料来源","text"],["glueRatio","胶料比例","text"],["ageYears","存放年限","number"],["storage","存放位置","text"]];
    const stages = ["待试磨","已试磨","重点观察"];
    const extraFields = [["paper","试磨纸张"],["water","加水量"],["speed","出墨速度"],["colorLayer","墨色层次"],["sediment","沉淀情况"],["score","评分"]];
    const batchKeys = ["paper","water","speed","colorLayer","sediment","score"];
    const batchLabels = { paper:"纸张", water:"水量", speed:"速度", colorLayer:"墨色", sediment:"沉淀", score:"评分" };
    const statusMeta = { pending:["待复核","pending"], confirmed:["已确认","confirmed"], rejected:["已退回","rejected"] };
    const createForm = document.querySelector('#createForm');
    const actionForm = document.querySelector('#actionForm');
    const cards = document.querySelector('#cards');
    const statsEl = document.querySelector('#stats');
    const itemSelect = document.querySelector('#itemSelect');
    const reviewerInput = document.querySelector('#reviewerName');
    reviewerInput.value = localStorage.getItem('inkReviewer') || '';
    reviewerInput.oninput = () => localStorage.setItem('inkReviewer', reviewerInput.value.trim());
    let items = [];
    function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
    function fmt(at) { if (!at) return ''; const d = new Date(at); return isNaN(d) ? at : d.toLocaleString('zh-CN', { hour12:false }); }
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ 'Content-Type':'application/json' } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || '请求失败');
      return data;
    }
    function renderForms() {
      document.querySelector('#fields').innerHTML = fields.map(([key,label,type]) => '<label>'+label+'</label><input name="'+key+'" type="'+type+'" '+(key==='code'?'required':'')+'>').join('');
      document.querySelector('#extraFields').innerHTML = extraFields.map(([key,label]) => '<label>'+label+'</label><input name="'+key+'" '+(key==='score'?'type="number" min="0" max="100" required':'')+'>').join('');
    }
    function render() {
      itemSelect.innerHTML = items.map(item => '<option value="'+esc(item.id || item.code)+'">'+esc(item.code || item.id)+' · '+esc(item.smokeSource || '')+'</option>').join('');
      const stats = Object.fromEntries(stages.map(s => [s, items.filter(i => i.status === s).length]));
      statsEl.innerHTML = Object.entries(stats).map(([k,v]) => '<div class="stat"><span>'+k+'</span><strong>'+v+'</strong></div>').join('');
      const status = document.querySelector('#statusFilter').value;
      const q = document.querySelector('#search').value.trim();
      const visible = items.filter(item => (!status || item.status === status) && (!q || JSON.stringify(item).includes(q)));
      cards.innerHTML = visible.map(item => cardHtml(item)).join('');
      document.querySelectorAll('[data-status]').forEach(sel => sel.onchange = async () => { await api('/api/items/'+encodeURIComponent(sel.dataset.status), { method:'PATCH', body: JSON.stringify({ status: sel.value }) }); await load(); });
    }
    function trailHtml(b) {
      return (b.history || []).map(h => {
        const head = esc(h.by || '复核人') + ' · ' + fmt(h.at);
        if (h.action === 'confirm') return '<div>✔ 确认：' + head + '</div>';
        if (h.action === 'reject') return '<div class="warn">✘ 退回：' + esc(h.reason || '') + '（' + head + '）</div>';
        if (h.action === 'resubmit') return '<div>↻ 重新提交：' + head + '</div>';
        return '';
      }).join('');
    }
    function batchHtml(itemId, b, no) {
      const meta = statusMeta[b.status] || statusMeta.pending;
      const rows = batchKeys.map(k => '<span><b>'+batchLabels[k]+'</b>：'+esc(b[k] ?? '')+'</span>').join('');
      const actions = b.status === 'pending'
        ? '<div class="batch-actions"><button class="mini" data-act="confirm" data-item="'+esc(itemId)+'" data-bid="'+esc(b.id)+'" data-version="'+b.version+'">确认</button><button class="mini danger" data-act="reject" data-item="'+esc(itemId)+'" data-bid="'+esc(b.id)+'" data-version="'+b.version+'">退回</button></div>'
        : b.status === 'rejected'
          ? '<div class="batch-actions"><button class="mini secondary" data-act="resubmit" data-item="'+esc(itemId)+'" data-bid="'+esc(b.id)+'" data-version="'+b.version+'">重新提交</button></div>'
          : '';
      return '<div class="batch"><div class="batch-head"><span>#'+no+'</span><span class="bpill '+meta[1]+'">'+meta[0]+'</span>'+(b.legacy?'<span class="pill">旧数据</span>':'')+'<span class="meta">'+fmt(b.at)+'</span></div><div class="batch-fields">'+rows+'</div>'+(b.note?'<div class="meta">备注：'+esc(b.note)+'</div>':'')+'<div class="trail">'+trailHtml(b)+'</div>'+actions+'</div>';
    }
    function cardHtml(item) {
      const itemId = item.id || item.code;
      const main = fields.slice(0,4).map(([key,label]) => '<div><b>'+label+'</b> '+esc(item[key] ?? '')+'</div>').join('');
      const batches = item.batches || [];
      const ordered = batches.map((b, i) => ({ b, no: i + 1 })).sort((a, z) => (z.b.at || '').localeCompare(a.b.at || ''));
      const finalLine = item.finalScore != null
        ? '<div class="final">最终评分：'+esc(item.finalScore)+'（来自#'+((batches.findIndex(x => x.id === item.finalBatchId))+1)+' 已确认批次）</div>'
        : '<div class="meta">最终评分：暂无已确认批次</div>';
      const batchPanel = ordered.length
        ? '<div class="batches">'+ordered.map(({ b, no }) => batchHtml(itemId, b, no)).join('')+'</div>'
        : '<div class="meta">暂无试磨批次</div>';
      return '<article class="card"><h3>'+esc(item.code || item.id)+'</h3><span class="pill">'+esc(item.status)+'</span>'+(item.pendingCount?'<span class="meta">待复核批次：'+item.pendingCount+'</span>':'')+main+finalLine+'<label>状态</label><select data-status="'+esc(itemId)+'">'+stages.map(s => '<option '+(s===item.status?'selected':'')+'>'+s+'</option>').join('')+'</select>'+batchPanel+'</article>';
    }
    async function load() { items = await api('/api/items'); render(); }
    cards.addEventListener('click', async event => {
      const btn = event.target.closest('button[data-act]');
      if (!btn) return;
      const reviewer = reviewerInput.value.trim();
      if (!reviewer) { alert('请先在左上角填写复核人姓名'); reviewerInput.focus(); return; }
      const { act, item, bid, version } = btn.dataset;
      let reason = null;
      if (act === 'reject') {
        reason = prompt('请填写退回原因（必填）');
        if (reason === null) return;
        reason = reason.trim();
        if (!reason) { alert('退回必须填写原因'); return; }
      }
      try {
        if (act === 'resubmit') {
          await api('/api/items/'+encodeURIComponent(item)+'/batches/'+encodeURIComponent(bid)+'/resubmit', { method:'POST', body: JSON.stringify({ reviewer, expectedVersion: Number(version) }) });
        } else {
          await api('/api/items/'+encodeURIComponent(item)+'/batches/'+encodeURIComponent(bid)+'/review', { method:'POST', body: JSON.stringify({ action: act, reviewer, reason, expectedVersion: Number(version) }) });
        }
      } catch (e) {
        alert('操作未生效：' + e.message);
      }
      await load();
    });
    createForm.onsubmit = async event => { event.preventDefault(); await api('/api/items', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(createForm).entries())) }); createForm.reset(); await load(); };
    actionForm.onsubmit = async event => { event.preventDefault(); await api('/api/items/'+encodeURIComponent(itemSelect.value)+'/batches', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(actionForm).entries())) }); actionForm.reset(); await load(); };
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
    if (req.method === "POST" && url.pathname === "/api/items") {
      return await withLock(async () => {
        const db = await loadDb();
        const input = await body(req);
        const item = { id: newId(), ...input, logs: [{ at: new Date().toISOString(), step: "建档", note: "创建墨锭" }], batches: [] };
        db.items.unshift(item);
        await saveDb(db);
        return send(res, 201, summarize(item));
      });
    }
    const patch = url.pathname.match(/^\/api\/items\/([^/]+)$/);
    if (patch && req.method === "PATCH") {
      return await withLock(async () => {
        const db = await loadDb();
        const item = findItem(db, decodeURIComponent(patch[1]));
        if (!item) return send(res, 404, { error: "item_not_found", message: "墨锭不存在" });
        Object.assign(item, await body(req));
        item.logs ||= [];
        item.logs.push({ at: new Date().toISOString(), step: "状态", note: "更新为" + item.status });
        await saveDb(db);
        return send(res, 200, summarize(item));
      });
    }
    const log = url.pathname.match(/^\/api\/items\/([^/]+)\/logs$/);
    if (log && req.method === "POST") {
      return await withLock(async () => {
        const db = await loadDb();
        const item = findItem(db, decodeURIComponent(log[1]));
        if (!item) return send(res, 404, { error: "item_not_found", message: "墨锭不存在" });
        const input = await body(req);
        item.logs ||= [];
        item.logs.push({ at: new Date().toISOString(), step: input.step || "记录", note: input.note || "" });
        await saveDb(db);
        return send(res, 201, summarize(item));
      });
    }
    const batches = url.pathname.match(/^\/api\/items\/([^/]+)\/batches$/);
    if (batches && req.method === "POST") {
      return await withLock(async () => {
        const db = await loadDb();
        const item = findItem(db, decodeURIComponent(batches[1]));
        if (!item) return send(res, 404, { error: "item_not_found", message: "墨锭不存在" });
        const input = await body(req);
        const score = Number(input.score);
        if (!Number.isFinite(score)) return send(res, 400, { error: "bad_score", message: "评分必须是数字" });
        item.batches ||= [];
        const batch = {
          id: newBatchId(),
          at: new Date().toISOString(),
          paper: String(input.paper || "").trim(),
          water: String(input.water || "").trim(),
          speed: String(input.speed || "").trim(),
          colorLayer: String(input.colorLayer || "").trim(),
          sediment: String(input.sediment || "").trim(),
          score,
          note: String(input.note || "").trim(),
          legacy: false,
          status: "pending",
          review: null,
          history: [],
          version: 1
        };
        item.batches.push(batch);
        item.logs ||= [];
        item.logs.push({
          at: batch.at,
          step: "试磨批次",
          note: "批次#" + item.batches.length + "：" + (batch.paper || "未填纸张") + "，评分" + score + "，待复核",
          score
        });
        await saveDb(db);
        return send(res, 201, summarize(item));
      });
    }
    const review = url.pathname.match(/^\/api\/items\/([^/]+)\/batches\/([^/]+)\/review$/);
    if (review && req.method === "POST") {
      return await withLock(async () => {
        const db = await loadDb();
        const item = findItem(db, decodeURIComponent(review[1]));
        if (!item) return send(res, 404, { error: "item_not_found", message: "墨锭不存在" });
        const batch = (item.batches || []).find(b => b.id === decodeURIComponent(review[2]));
        if (!batch) return send(res, 404, { error: "batch_not_found", message: "批次不存在" });
        const input = await body(req);
        // 后到者：批次已有结论，直接告知，不允许覆盖。
        if (batch.status !== "pending") {
          const who = batch.review?.by ? "「" + batch.review.by + "」" : "其他复核人";
          const did = batch.review?.action === "confirm" ? "确认" : "退回";
          return send(res, 409, {
            error: "batch_already_handled",
            message: "批次 #" + batchNo(item, batch) + " 已被" + who + did + "，不能重复处理",
            batch
          });
        }
        if (input.expectedVersion != null && Number(input.expectedVersion) !== batch.version) {
          return send(res, 409, { error: "version_stale", message: "批次信息已过期，请刷新后再处理", batch });
        }
        const reviewer = String(input.reviewer || "").trim();
        if (!reviewer) return send(res, 400, { error: "reviewer_required", message: "请填写复核人" });
        const action = input.action === "confirm" ? "confirm" : input.action === "reject" ? "reject" : null;
        if (!action) return send(res, 400, { error: "bad_action", message: "复核动作只能是 confirm 或 reject" });
        let reason = null;
        if (action === "reject") {
          reason = String(input.reason || "").trim();
          if (!reason) return send(res, 400, { error: "reason_required", message: "退回必须填写原因" });
        }
        const at = new Date().toISOString();
        const entry = { at, by: reviewer, action, reason };
        batch.status = action === "confirm" ? "confirmed" : "rejected";
        batch.review = entry;
        batch.history.push(entry);
        batch.version += 1;
        item.logs ||= [];
        item.logs.push({
          at,
          step: action === "confirm" ? "批次确认" : "批次退回",
          note: action === "confirm"
            ? "批次#" + batchNo(item, batch) + " 经" + reviewer + "确认，评分" + batch.score
            : "批次#" + batchNo(item, batch) + " 经" + reviewer + "退回：" + reason
        });
        if (action === "confirm") {
          item.status = batch.score >= 85 ? "已试磨" : "重点观察";
        }
        await saveDb(db);
        return send(res, 200, batch);
      });
    }
    const resubmit = url.pathname.match(/^\/api\/items\/([^/]+)\/batches\/([^/]+)\/resubmit$/);
    if (resubmit && req.method === "POST") {
      return await withLock(async () => {
        const db = await loadDb();
        const item = findItem(db, decodeURIComponent(resubmit[1]));
        if (!item) return send(res, 404, { error: "item_not_found", message: "墨锭不存在" });
        const batch = (item.batches || []).find(b => b.id === decodeURIComponent(resubmit[2]));
        if (!batch) return send(res, 404, { error: "batch_not_found", message: "批次不存在" });
        if (batch.status === "confirmed") {
          return send(res, 409, { error: "batch_already_handled", message: "批次 #" + batchNo(item, batch) + " 已确认，不能重新提交", batch });
        }
        if (batch.status === "pending") {
          return send(res, 409, { error: "batch_pending", message: "批次 #" + batchNo(item, batch) + " 正在待复核，无需重新提交", batch });
        }
        const input = await body(req);
        if (input.expectedVersion != null && Number(input.expectedVersion) !== batch.version) {
          return send(res, 409, { error: "version_stale", message: "批次信息已过期，请刷新后再提交", batch });
        }
        const reviewer = String(input.reviewer || "").trim();
        if (!reviewer) return send(res, 400, { error: "reviewer_required", message: "请填写提交人" });
        const at = new Date().toISOString();
        batch.history.push({ at, by: reviewer, action: "resubmit", reason: null });
        batch.status = "pending";
        batch.review = null;
        batch.version += 1;
        item.logs ||= [];
        item.logs.push({ at, step: "批次重提", note: "批次#" + batchNo(item, batch) + " 由" + reviewer + "重新提交" });
        await saveDb(db);
        return send(res, 200, batch);
      });
    }
    if (req.method === "GET" && url.pathname === "/api/stats") {
      const db = await loadDb();
      return send(res, 200, computeStats(db.items));
    }
    send(res, 404, { error: "not_found", message: "接口不存在" });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
});
server.listen(port, () => console.log("墨锭试磨室 listening on http://localhost:" + port));
