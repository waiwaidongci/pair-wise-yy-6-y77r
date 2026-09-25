# 墨锭试磨室

运行：

```bash
npm start
```

访问`http://localhost:3037`。数据保存在`data/ink-stick-testing.json`。

## 批次复核

- 每次试磨独立成批，记录纸张、水量、速度、墨色、沉淀、评分和备注，提交后为「待复核」。
- 复核人可「确认」或「退回」（退回必填原因），退回批次可修改后重提；全部流转留痕。
- 两人同时处理同一批时，后到者会收到 409 并看到先前处理人和结论，不会覆盖。
- 卡片列出各批结果与退回原因，最终评分取最近确认批次。
- 旧数据（`tests` 数组、日志中的试磨记录）启动时自动升级为待复核批次，可继续复核。

接口：

- `POST /api/items/:id/batches` 提交试磨批次
- `POST /api/items/:id/batches/:batchId/review` 复核，body：`{ action: "confirm" | "return" | "resubmit", by, reason?, expectedRevision? }`
