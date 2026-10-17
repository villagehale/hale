# VIL-423：修改前／后实际输出

执行日期：2026-10-11。本地受控对照，不是生产端到端测试。

## 固定输入

- DB：报名时间 `2026-10-20 09:00 America/Toronto`。
- 已知 URL：`https://example.org/registration`；家长已批准提醒。
- 网页结果分别注入：10 月 18 日、10 月 22 日、读取失败。
- cron 时钟固定为 `2026-10-13 10:00 America/Toronto`，每个版本各跑一次。
- Before：HEAD `11fc9a8c2d0c710a5ccd97f11ee0fe3cfdf261e3` 的 registration 模块；After：当前未提交实现。共用当前测试环境及其余依赖。

## 1. 同一句家长提问

`When does the registration I asked you to watch open now?`

使用真实 Claude Sonnet 5、真实 agent loop 和前／后的策略；日期 context 关键值来自另行实跑的旧／新上下文构建器。模型评测不是完整 webhook 调用。

### 网页结果为 10 月 18 日

修改前原文：

> Richmond Hill recreation registration opens Oct 20, 9:00 a.m. - I'm on it and I'll text you before it opens.

修改后原文：

> Richmond Hill registration opens October 18, 2026 at 9:00 a.m. (America/Toronto) - I'm on it and I'll text you before it opens.

### 网页读取失败

修改前原文：

> Richmond Hill registration opens Oct 20, 9:00 a.m. - I'm on it and I'll text you before it opens.

修改后原文：

> I couldn't verify the current date. Date reminders are paused while I check again.

原始输出：[修改前](../.local/vil423-pre-post/coach-before.log)、[修改后](../.local/vil423-pre-post/coach-after.log)。两组各 2/2 通过；本轮合计 16 次真实 API 调用（含评审），估算 $0.3136。旧版通过只代表符合旧版输入及预期，不代表 DB 日期符合网页。

## 2. cron 各跑一次

实际执行旧／新 `runRegistrationSequenceCron`，使用真实 PGlite 和迁移。网页解析结果、短信传输、审批草拟和部分外围服务为测试替身。

修改前三种情况都不读取网页，均发送以下原文：

> Richmond Hill VIL-423 comparison 2026 recreation programs registration opens Oct 20, 9:00 a.m. for Maya. I'll send your plan the evening before.

修改后的发送原文：

| 网页结果 | 实际发送内容 |
|---|---|
| 10 月 18 日 | The registration page now says 2026-10-18 at 09:00 America/Toronto. I moved your reminder schedule earlier. https://example.org/registration |
| 10 月 22 日 | The registration page now says 2026-10-22 at 09:00 America/Toronto, later than before. Old date reminders are paused. Confirm the new date in your approvals; I'll recheck the page before resuming. https://example.org/registration |
| 读取失败 | I couldn't verify a current registration date. Date reminders are paused; I'll check again in an hour. https://example.org/registration |

每个新版场景均调用读取接口两次：到期刷新一次，发送前再核验一次。这里是注入的读取结果，不是两次真实网络请求。

| 网页结果 | Before：跑后状态 | After：跑后状态 |
|---|---|---|
| 10 月 18 日 | 仍按 10/20 调度，不暂停 | 改按 10/18 调度，不暂停 |
| 10 月 22 日 | 仍按 10/20 调度，不暂停 | 保留旧锚点但暂停；记录 10/22 候选，等重新确认 |
| 读取失败 | 仍按 10/20 调度，不暂停 | 暂停日期提醒；记录读取失败 |

新版三个场景的 `next_check_at` 均为 `2026-10-13T15:00:00Z`，即本次运行后一小时。

注意：三个场景的 cron 汇总都显示 `sent=1`。新版发送的是日期变更／暂停通知，不能把它误读为“仍发送了旧日期提醒”。现有 `result.read` 是旧课程准备读取计数，不包含新读取接口调用；对照日志另列 `pageReads`。

完整输出（含 cron 返回对象、发送原文、SQL 状态和 Coach context）：[原始日志](../.local/vil423-pre-post/cron-and-context.log)。本地对照测试 5/5 通过。

## 复现

原始代码快照、对照脚本及日志保留在忽略的 `.local/vil423-pre-post/`，未修改产品实现。

从仓库根目录运行 SQL／cron 对照：

```sh
node .corepack/v1/pnpm/9.15.0/bin/pnpm.cjs --filter @hale/web exec vitest run --config "$PWD/.local/vil423-pre-post/vitest.config.mts" --reporter=verbose
```

模型缓存回放，零 API 调用：

```sh
cd .local/vil423-pre-post/baseline/apps/worker
node evals/run-coach-channel-eval.mjs --cached-only --show --only=comparison-before-earlier,comparison-before-unavailable
node evals/after-coach-eval.mjs --cached-only --show --only=comparison-after-earlier,comparison-after-unavailable
```

尚未验证：生产官网抓取→AI 解析→真实短信的完整链路；本次也未部署、迁移生产库或发送真实家长消息。
