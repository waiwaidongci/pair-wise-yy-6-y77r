# 墨锭试磨室

运行：

```bash
npm start
```

访问 `http://localhost:3037`。数据保存在 `data/ink-stick-testing.json`（原子写入，重启记录不丢）。

## 批次复核流程

- 每次试磨独立成批：记录纸张、加水量、出墨速度、墨色层次、沉淀情况、评分，批次初始为「待复核」。
- 复核人先在左上角填写姓名，可对批次**确认**或**退回**；退回必须填写原因。
- 已退回批次可**重新提交**，再次进入待复核；确认 / 退回 / 重提全过程留痕。
- 两人同时处理同一批时：写操作串行 + 批次 `version` 乐观锁，后到者收到 409 并看到批次已被谁处理，不能覆盖先前结论。
- 卡片列出每批评审结果与退回原因；**最终评分取最近一次已确认批次**，同时驱动墨锭状态。
- 旧数据（`tests`、带评分的试磨日志）在服务启动时自动升级为待复核批次（标记「旧数据」），可继续复核。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/items` | 墨锭列表（含各批、待复核数、最终评分） |
| POST | `/api/items/:id/batches` | 新建试磨批次 |
| POST | `/api/items/:id/batches/:bid/review` | 复核：`{action:"confirm"\|"reject", reviewer, reason, expectedVersion}` |
| POST | `/api/items/:id/batches/:bid/resubmit` | 退回后重新提交：`{reviewer, expectedVersion}` |
