# English Live Registration Verification

最新架构已改为 Coach 按需调用实时读取工具，关键词门控已移除。见 [工具化改造及 30 场景验证](/Users/yuhangsong/hale/docs/vil-423-registration-tool-validation.md)。以下保留各阶段原始结果，不覆盖历史失败。

## 结论：实时日期正确，英文交付仍有缺口

2026 年 10 月 13 日，核对 **23 个英文场景、5 个真实官网**：**15 项通过、5 项安全暂停通过、2 项失败、1 项部分通过**。所有被测试的问日期/发送前核实路径都实际请求了官网；没有观察到把故意写错的数据库日期当作最终事实。第 1 项仍不能宣称全部通过：C02 没交付日期，C04 没给来源，C13 的尾句不完整。

“安全暂停通过”只表示无法核实时不猜日期、给链接、暂停提醒，不代表这三个官网已成功解析出日期。居民/非居民复测全部保留，未挑选通过样本替换失败。

## 口径：只测第 1 项，不测中文或新城市支持

- 测试问题和模型回答均为英文。报告说明为中文；此前中文测试不计入结果。
- 一行是一个场景；同一官网不同家庭资格、追问、提醒阶段分别列行，不是 23 个独立网站。
- 真实部分：官网 GET、原有解析模型、原有 Coach 指令/上下文/模型/后处理、提醒调度/SQL/去重代码。
- 隔离部分：PGlite 测试家庭、孩子和已批准 action，短信通道/许可/队列测试端口与 FakeTransport。提醒时钟在本地推进；关闭定期检查，确保发送前读取不是靠周期 job 预先修好。
- 故意错缓存：默认 Nov 26 at noon；非居民提醒用 Dec 3。实际官网没有明确小时的日期保持 date-only。
- 不接新 API、不切模型、不改产品逻辑、不写远程 DB、不发真实短信、不做部署。

## 英文问答：日期与来源分别核对

下表检查最终家长回复，而不只看模型输入。C03/C05 的地址省略了协议/www，但仍是同一官方域名和路径，因此按“有来源依据”接受；没有把格式不同误判成无来源。

| Case | 英文场景 | 实际结果摘要 | 判定 |
| --- | --- | --- | --- |
| C01 | RH 居民日期 | Nov 24；时间未公布；带官网地址 | 通过 |
| C02 | RH 非居民日期：初测 | `Richm` + 官网 URL；没有日期 | 失败 |
| C03 | RH 精确时间询问 | Nov 24；时间未公布；省略协议的官网地址 | 通过 |
| C04 | RH 再核对，拒用旧缓存 | Nov 24；时间未公布；未附来源 | 失败 |
| C05 | Burlington 居民历史日期/时间 | Aug 22, 2026 / 9:00 a.m.；来源省略协议 | 通过 |
| C06 | Burlington 非居民历史日期/时间 | Aug 28, 2026 / 9:00 a.m.；完整来源 | 通过 |
| C07 | King 冬季泳课 | 说明无法核实，日期提醒暂停；附官网 | 安全暂停通过 |
| C08 | Markham 资格日期未核实 | 说明资格日期无法核实；附官网 | 安全暂停通过 |
| C09 | Uxbridge PDF | 说明无法核实 PDF 日期；附来源 | 安全暂停通过 |
| C10 | 英文时间追问 | 重新 GET；说明开放时间未公布；附官网 | 通过 |
| C11 | 普通感谢，不查日期 | `You're welcome.`；0 次 GET | 通过 |
| C12 | RH 非居民：独立复测 1 | Dec 1；时间未公布；附官网 | 通过 |
| C13 | RH 非居民：独立复测 2 | Dec 1 + 官网；尾句停在 `exact time` | 部分通过 |

## 英文提醒：实时核实、精度和去重均通过

两组 RH 提醒分别验证居民 Nov 24、非居民 Dec 1。错误缓存经发送前读取被修正；一组最多经过 3 次模拟 cron 才发送，不能说第一轮就发出。King 仅验证问答安全处理，未把它说成完成了提醒 E2E。

| Case | 英文场景 | 实际结果摘要 | 判定 |
| --- | --- | --- | --- |
| R01 | RH 居民：错误缓存→实时提醒 | Nov 26 缓存→Nov 24；新 GET；附官网 | 通过 |
| R02 | RH 居民：前一晚提醒 | Nov 24；发送前新 GET；附官网 | 通过 |
| R03 | RH 居民：重复 cron | 0 新短信，0 新 GET | 通过 |
| R04 | RH 居民：无时间不发分钟提醒 | 没有分钟提醒；未猜开放小时 | 通过 |
| R05 | RH 非居民：错误缓存→实时提醒 | Dec 3 缓存→Dec 1；新 GET；附官网 | 通过 |
| R06 | RH 非居民：前一晚提醒 | Dec 1；发送前新 GET；附官网 | 通过 |
| R07 | RH 非居民：重复 cron | 0 新短信，0 新 GET | 通过 |
| R08 | RH 非居民：无时间不发分钟提醒 | 没有分钟提醒；未猜开放小时 | 通过 |
| R09 | Uxbridge：发送前核实失败 | 重新 GET；暂停日期提醒，说明情况并给 URL | 安全暂停通过 |
| R10 | Markham：发送前核实失败 | 重新 GET；暂停日期提醒，说明情况并给 URL | 安全暂停通过 |

## 未通过结果：原文与含义

### C02 — RH 非居民日期：初测

模型原始输出就是 Richm；实时上下文含 Dec 1，最终未交付日期。completionTokens=400，但本轮未确定截断根因。

实际最终输出：

> Richm https://www.richmondhill.ca/en/things-to-do/Community-Recreation-Guide.aspx

### C04 — RH 再核对，拒用旧缓存

日期正确，但最终没有来源地址；不会把它说成日期读取错误。

实际最终输出：

> Richmond Hill Winter 2026-2027 resident registration opens Nov 24, 2026 (America/Toronto) - the opening time isn't published yet. You're on the watch list so I'll text you once a time shows up.

### C13 — RH 非居民：独立复测 2

Dec 1 和来源保留，但尾句 exact time 后的说明丢失；正文与 URL 拼接后不完整。

实际最终输出：

> Winter 2026-2027 registration at Richmond Hill opens Dec 1, 2026 (America/Toronto) for all registrants, including non-residents - exact time https://www.richmondhill.ca/en/things-to-do/Community-Recreation-Guide.aspx

## 真实来源的独立对照

- [Richmond Hill 官网](https://www.richmondhill.ca/en/things-to-do/Community-Recreation-Guide.aspx)：居民 November 24, 2026；非居民 December 1, 2026；Winter 未写明确开放小时。
- [Burlington 官网](https://www.burlington.ca/en/recreation/registering-for-a-program.aspx)：Fall swimming residents Aug 22 at 9 a.m.；non-residents Aug 28 at 9 a.m.；这是已过去的 2026 报名窗口，不是新的未来活动推荐。
- [King 官网](https://www.king.ca/recreation)：本次证据门禁拒绝抽取结果，不引用缓存；不能把安全暂停计为读取覆盖。
- [Markham 官网](https://www.markham.ca/sports-recreation-fitness/sports-recreation-programs/registration-and-general-information)：本次资格日期未核实，安全暂停。
- [Uxbridge 来源](https://www.uxbridge.ca/public/download/files/360410)：实际返回 PDF；当前 HTML 读取器无法核实其中日期，不能声称 PDF 本身没有日期。

## 限制与下一步

这是小样本真实读取/模型 + 本地业务流程，不是生产 webhook→运营商送达测试，不是可靠性统计。可用日期实际来自两个官网，另外三个只证实安全处理。C13 核心日期/来源检查通过，但人工复核为部分通过，未藏掉尾句截断。

未来报名有明确小时的“提前 15 分钟提醒”尚未用真实网页完整验证；这轮分钟提醒只验证了 date-only 时不会发送。日期变化通知、延后确认、任意城市链接入口属于其他验收项，不在本报告范围内。

下一步应先定位 C02 的不完整生成、保证 C04 的来源保留、处理 C13 的句尾截断，再复测英文交付。本轮只验证，没有实施这些修复。

## 可复核证据

- [逐行结果 JSON](/Users/yuhangsong/hale/.local/vil423-pre-post/english-step1-reviewed.json)
- [主测试原始日志](/Users/yuhangsong/hale/.local/vil423-pre-post/english-step1-2026-10-13.log)
- [非居民两次独立复测日志](/Users/yuhangsong/hale/.local/vil423-pre-post/english-step1-repeats-2026-10-13.log)
- [英文用例](/Users/yuhangsong/hale/.local/vil423-pre-post/english-step1.test.ts)

主日志 Vitest 初始结果为 4 failed / 11 passed；其中 C03/C05 是精确 URL 字符串校验误报，已按实际相同官方地址复核。复测 C12/C13 的自动核心检查均通过，但 C13 的呈现仍列为部分通过。表格的 23 行与 Vitest 的分组测试数量不是同一分母。

## 后续修复：来源链接由最终回复层保留

2026 年 10 月 13 日追加。以上初测结果保留，不用新结果覆盖旧失败。已将来源保护从仅 `paused` 扩展到本轮全部实时报名来源；去重后作为受保护尾部输出，不依赖模型是否写出链接，不改模型或生产 token 上限。

- Coach 模块 11 个测试文件、142 个测试通过；Web 类型检查及修改文件的 Biome 检查通过。
- 新增回归覆盖 active、awaiting_confirmation、多个来源去重，以及模型漏链接、已附链接、长回答裁剪。已有 paused 和非报名对话检查仍通过。
- 同一英文问题和实时上下文分别用 400、2000 上限复测，四组、八份最终回复均保留官网链接及对应家长日期；自动检查四项通过。

| 场景 | 400 上限最终日期/链接 | 2000 上限最终日期/链接 |
| --- | --- | --- |
| C02 非居民 | Dec 1 + 官网 | Dec 1 + 官网 |
| C04 居民重新核实 | Nov 24 + 自动补官网 | Nov 24 + 自动补官网 |
| C12 非居民复测 | Dec 1 + 官网 | Dec 1 + 官网 |
| C13 非居民复测 | Dec 1 + 官网；发生一次模型重试 | Dec 1 + 官网 |

C04 两档模型原文仍未写 URL，最终回复均自动补上，直接验证了本次修复。

**未解决的独立问题：** C13 在 400 上限首次请求的 400 tokens 全用于思考，无文本；现有关闭思考重试产生完整回答。本次未修改截断处理。另外，2000 上限 C13 写了 `no resident priority`，但官网居民日期 Nov 24 早于非居民 Dec 1，这个措辞错误不在原自动日期/链接检查中，不能把自动通过当作全文事实正确。多个长链接可能需要额外 SMS 段数。未部署、未发送真实短信，未重跑全部 23 个场景。

- [来源修复真实读取/模型日志](/Users/yuhangsong/hale/.local/vil423-pre-post/source-link-fix-2026-10-13.log)
- [Coach 模块回归日志](/Users/yuhangsong/hale/.local/vil423-pre-post/source-link-fix-unit-2026-10-13.log)

## 后续修复（二）：生成截断与居民优先

2026 年 10 月 13 日追加，本节更新上节这两项待修状态；不覆盖初测失败。

| 问题 | 修复前 | 修复后 |
| --- | --- | --- |
| 生成到一半触及 token 上限 | 只要有文字就当作正常回答，可能发出 `Richm` 或 `exact time` 半句 | 非流式调用识别半句，复用一次关闭思考的同预算重试；仍截断则安全失败，不交付半句 |
| 非居民被说成“没有居民优先” | 只传本家庭日期与 `residentsFirst: false`，缺少官网的另一个日期 | 分别传本家庭适用日期、官网居民日期和官网非居民日期；明确 false 不是“官网没有优先”，缺失日期也不是平等开放的证据 |

完整工具调用仍执行一次，不因旁边的文字截断而重复写入。已执行工具的结果进入下一步，未交付的半句不进入回答历史。未改模型、生产 400-token 上限、抓取、调度或数据库结构；流式 App 对话不在这次 SMS 修复范围内。

### 验证结果

- 修改前，新增/更新测试复现 5 项截断失败、4 项日期上下文失败。
- 修改后，Agent 全套 125 项、Coach/报名模块 724 项，共 **849 项通过**；Agent 构建、Agent/Web 类型检查、提示词哈希检查通过。Lint 无错误；报名测试文件保留原有非空断言警告，未顺手整理无关代码。
- 八组英文问题用相同上下文分别跑 400/2000 上限，**16 份真实模型回答通过目标检查**：正确家长日期、官网来源、未编造小时，未再观察到“没有居民优先”。包括专门询问“两者是否同一天”和要求纠正先前错误的用例。
- 最终提示词补充“根据已发布日期先后判断优先”后，C13/C14/C15 再跑两档，**6 份回答通过**。自然生成均正常结束，不能用它们独立证明截断恢复。
- 因此另做两次受控真实恢复测试：仅在本地测试中把首次请求临时限为 24 tokens、关闭思考，后续仍走原生产重试逻辑与 400 上限。两次均触发 `max_tokens` + 非空半句，再真实请求模型，恢复完整短信；不是伪造模型最终回答。

最后一次受控实测：

| 阶段 | 真实结果 |
| --- | --- |
| 首次请求 | 24 output tokens，`max_tokens`；`Non-residents can register starting Dec 1, 2026 (Richmond` |
| 自动重试 | 112 output tokens，`end_turn`；`truncatedRetries: 1` |
| 最终短信 | `Non-residents can register starting December 1, 2026 (opening time not yet published, America/Toronto) - residents get priority access from November 24.` + 完整官网链接 |

重试的 output tokens 合计 136（24 + 112），没有把失败请求的消耗漏记。首次 24-token 限制只用于故障注入，不是生产配置。

### 限制与证据

这些结果验证本次两项修复，不代表 VIL-423 整体已可发布。原始模型文案仍有一次把“提醒暂停”误称成“今天无法核实”；该句在这次最终短信中被裁掉，没有交付给家长，但更广泛文案可靠性仍需回归。重试最多一次，不能保证每次模型请求都成功。未部署、未发真实短信，也未改远程数据库。

- [八组英文两档真实复测](/Users/yuhangsong/hale/.local/vil423-pre-post/truncation-tiers-live-2026-10-13.log)
- [最终提示词三组两档复测](/Users/yuhangsong/hale/.local/vil423-pre-post/truncation-tiers-live-final-2026-10-13.log)
- [真实受控截断与恢复](/Users/yuhangsong/hale/.local/vil423-pre-post/truncation-forced-live-final-2026-10-13.log)
- [Agent 回归](/Users/yuhangsong/hale/.local/vil423-pre-post/truncation-agent-final-2026-10-13.log)
- [Coach/报名回归](/Users/yuhangsong/hale/.local/vil423-pre-post/truncation-tiers-web-after-2026-10-13.log)
