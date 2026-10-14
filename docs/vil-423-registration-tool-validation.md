# VIL-423：Coach 按需读取报名官网

## 2026-10-14：日期与适用人群分开处理（步骤 2、3）

- 日期、时间、年份、时区继续走原证据检查；此次没有放宽日期校验。原来因资格不明确而整次拒绝的读取，现在保留已核实日期为 `unclassified_open`，不冒充居民或公众报名日期。
- Coach、课程链接入口及 intake 官方日期问答可以报告该日期，并明确说明居民／非居民资格未确认。日期与资格说明和 URL 一样放入短信保护尾部，混合操作时也不会被截掉。若单来源、无其他操作的 Coach 回复仍超出短信预算，以当前工具结果生成精简事实兜底，保留日期、资格说明、暂停状态与链接；不覆盖其他操作的确认信息。
- `registrationDate` 仍只选择适用于该家庭的已分类日期。未分类日期不会替换提醒调度日期；关注保留、日期提醒暂停，下一次按原机制复查。
- cron 的待确认通知保留官网日期、时区、资格说明和 URL；重复扫描不会重复通知。后续读取确认适用日期后，再按已有调度／改期确认规则处理。
- 使用现有 JSON 状态与审计记录；不改表结构、模型、API 或 token 预算。PDF 未改。

### 本次验证

| 检查 | 结果 |
| --- | --- |
| 业务回归：报名、Coach、相关 intake、两个活动 journey | 38 个文件，790 项通过 |
| 类型与提示词 | Web `tsc --noEmit`、56 个提示词哈希通过 |
| Markham 非居民询问 C08 | 官网日期／时间保留，明确资格未确认，不误称公众日期 |
| Markham 家长自称本市居民 C21 | 仍不把未标注日期当成该家庭适用日期 |
| Markham 明确追问非居民资格 C22 | 日期与资格分别说明；最终短信无省略号截断 |
| Markham cron R10 | 发送前再次读官网；发资格待确认通知，不发报名时间提醒 |
| 已分类日期控制组 C01／C02／C06 | Richmond Hill 居民／非居民、Burlington 非居民日期仍正确 |

Markham cron 实际输出：

> The page lists 2026-08-11 at 06:30 America/Toronto; resident/non-resident eligibility is unconfirmed. I can't confirm this applies to you. Date reminders are paused.

实际消息末尾保留完整官网链接。这里的 2026-08-11 是页面列出的历史日期，不是新的未来报名承诺。

- [最终 Markham 英文问答与 cron 复测：4 项通过](/Users/yuhangsong/hale/.local/vil423-pre-post/eligibility-live-validation-complete.log)
- [首次复测与已分类日期控制组](/Users/yuhangsong/hale/.local/vil423-pre-post/eligibility-live-validation-actual.log)
- [790 项回归](/Users/yuhangsong/hale/.local/vil423-pre-post/eligibility-regression-final.log)

首轮真实复测出现资格说明后的短信截断；此外检查器未识别 `isn't confirmed`。压缩提示词后曾 4 项通过，但重复复测仍出现截断，因此没有仅靠提示词结束：新增上述窄范围格式化兜底、对应单元测试，并确认有其他草稿时不覆盖回复。最终 4 项真实复测全部通过；原失败日志保留在 `eligibility-live-validation-actual.log` 和 `eligibility-live-validation-final.log`。核心文件 Biome 检查通过；`link-handler.ts` 原有格式／导入顺序未顺手调整，仅其 lint 检查通过。

真实部分为官网 HTTP、解析模型、Coach 模型与生产业务逻辑；DB 为 PGlite，发送为 FakeTransport。未操作远程家庭数据、未发真实短信、未部署。下方为此前工具接入阶段的历史记录；Markham 仅安全暂停的结论已被本次结果更新，King 和 Uxbridge PDF 尚未修复。

## 当前结果

当前分支已改为 **DB 关注信息 → Coach 自主选择读取工具 → 实时抓取、解析、校验 → 回答**。移除报名关键词门控，不在进入 Coach 前抓网页，也不预注入 DB 保存的报名日期。

- 工具：`read_registration_page({ watchId })`。只能读取当前家庭的已知关注 ID，不接受任意 URL；服务端再次按家庭校验。
- DB 上下文：活动名称、官网 URL、关注 ID、同意提醒状态和已记录结果，不含旧报名日期。
- 读取：复用原抓取器、解析器和证据门禁，保留来源链接、居民／非居民日期、时区、提醒状态；读取结果仍按原逻辑写关注状态和调度记录。
- 同一轮重复读取同一 watch 会复用结果；下轮重新读取。取消此前前 8 项的截断，DB 集成测试已覆盖第 9 项。
- 仅实际调用工具读过的来源进入最终回复的链接保护，不自动附加其他关注项的网址。
- 不改主 agent loop、模型、每步 400-token 上限、数据库结构或 cron。提醒发送前仍由 cron 强制实时读取，不依赖 Coach 自主调用。

## 代码验证

- Coach、报名模块及两个活动 journey：36 个文件，747 项通过。
- Agent 包：6 个文件，125 项通过。合计 **872 项回归通过**。
- Web 类型检查、改动核心文件 Biome 检查、56 个提示词哈希检查通过。
- 工具回归覆盖：未调用不抓网页、家庭隔离、同轮去重／下一轮刷新、关注消失、读取失败、来源保护、全部关注元数据与第 9 项访问。

## 英文真实验证

三个批次加旧聊天专项，合并 **30 个场景，30 项通过目标检查**，不是 30 个独立网站。其中 **5 项仅验证安全暂停**，不能算成功解析日期。

| 场景 | 观察结果 |
| --- | --- |
| 居民／非居民日期、重新核实、资格比较 | LLM 主动调用工具；答 Nov 24／Dec 1，保留来源，不编造开放小时 |
| `registrations` 复数 | 主动调用工具；不再被关键词挡住 |
| `enroll` 问法 | 主动调用工具；正确返回非居民日期 |
| `And when can I do that?` | 根据之前的课程讨论选择工具，正确读取 |
| 两个课程，不清楚指哪个 | 先询问目标，0 次网页抓取 |
| 普通感谢 | 不调用读取工具，0 次网页抓取 |
| 旧聊天故意写 Nov 26 at noon | 重新调用工具，回答 Nov 24、时间未公布；不复述旧日期或小时 |
| King／Markham／Uxbridge PDF | 实时读取后说明无法核实，保留官网 URL，不用旧缓存顶替 |
| 居民／非居民 cron、前一晚提醒 | 发送前读取，使用官网日期与 URL；重复 cron 不重发 |
| 官网未公布小时 | 不发送分钟级提醒 |
| 提醒前核实失败 | 暂停日期提醒并给链接 |

本轮记录：21 次 Coach 对话、40 次 Coach 模型请求、19 次按需读取；总计 33 次真实官网 GET、33 次解析模型请求。两个无需读取的对话没有 GET。Coach output tokens 合计 3849（含工具调用／思考，不包含解析模型）；多一步工具调用会增加一次模型往返，每步上限没有提高。

## 口径与限制

真实部分是模型选择工具、官网 HTTP、原解析模型和生产业务代码；DB 使用 PGlite 测试家庭，提醒通道使用 FakeTransport。未访问远程家庭数据，未发送真实短信，未部署。

仍限 SMS Coach、已有关注 URL；App Ask 未接入此工具，也没有扩大到新活动发现或任意 URL。三个官网目前只验证失败保护；未来有明确开放小时的分钟提醒仍缺真实页面完整验证。LLM 是否调用工具仍是模型决策，少量样本通过不等于所有问法永不漏调用，也不代表全文事实或整个 VIL-423 已可发布。

补测首轮 R09/R10 因本地测试脚本仍调用旧接口而报错；已迁移到新读取接口，单独复测通过。原失败日志保留，没有当作产品故障或隐藏。

## 证据

- [逐项检查与完整最终回答](/Users/yuhangsong/hale/.local/vil423-pre-post/registration-tool-reviewed.json)
- [首批真实问答与控制组](/Users/yuhangsong/hale/.local/vil423-pre-post/registration-tool-live.log)
- [扩展问答、解析失败和提醒](/Users/yuhangsong/hale/.local/vil423-pre-post/registration-tool-live-extra.log)
- [R09/R10 修正测试接口后的复测](/Users/yuhangsong/hale/.local/vil423-pre-post/registration-tool-reminder-holds.log)
- [旧聊天日期专项](/Users/yuhangsong/hale/.local/vil423-pre-post/registration-tool-stale-transcript.log)
- [业务回归](/Users/yuhangsong/hale/.local/vil423-pre-post/registration-tool-regression.log)
- [Agent 回归](/Users/yuhangsong/hale/.local/vil423-pre-post/registration-tool-agent-tests.log)
