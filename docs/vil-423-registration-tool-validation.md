# VIL-423：Coach 按需读取报名官网

## 2026-10-14：明确开放时间的分钟提醒正向闭环完成

用户列出的 PDF、King 证据、取消短信裁剪、最终英文问答／cron 闭环四项已完成本地验证；这不等于整个 VIL-423 可直接发布。新增测试只覆盖最后缺少的分钟级成功发送，没有修改业务代码／模型／prompt。

### 真实来源与测试边界

来源：[Burlington 官方报名页面](https://www.burlington.ca/en/recreation/registering-for-a-program.aspx)。本次真实 GET 确认页面仍公布 **Fall 2026 registration** 表，列名明确区分 resident／non-resident；Fall swimming lessons 为居民 **2026-08-22 09:00**、非居民 **2026-08-28 09:00**，来源时区 America/Toronto。**这是已过去的公开周期：本测试模拟当时的事件时钟，HTTP 和模型调用发生在本次执行；没有改年份，也没有把它推荐成今天即将报名的活动。**

数据库为 PGlite 测试家庭，批准动作、渠道同意／排队衔接与发送载体为 fixture／FakeTransport；官网 HTTP、原解析模型、日期取证、状态刷新、生产 cron、模板、SQL 去重／发送记录真实执行。未写远程 DB、发真实短信、push 或部署。

### 两条路径结果

| 家庭 | 模拟 cron 当地时间 | 官网开放时间 | 结果 |
| --- | --- | --- | --- |
| Burlington 居民（L7M） | 8 月 22 日 08:45 | 同日 09:00 | 发送前新 GET／解析，发送正确日期、时间、时区、链接 |
| 非居民（L4B） | 8 月 28 日 08:45 | 同日 09:00 | 发送前新 GET／解析，使用非居民列而非居民日期 |

- 最终批次 **2/2 真实正向场景通过**；每户 3 次 HTTP／解析（初始核验、前一晚提醒、分钟提醒），合计 **6 GET、6 模型提取**。
- 08:44 不提前发分钟提醒，前一晚提醒已送达，因此该 tick 也不重复抓取；08:45 触发 go leg，实际发送前读取次数与解析次数均增加一次。重复跑相同 tick 和到 09:00 再跑均不多发、不多抓。
- 故意预置旧 observation 为 2026-11-26 12:00；实际提醒不使用它。发送后的最后阅读记录对应分钟 tick、正确官网日期及原文证据；未暂停。
- 首轮没建立测试孩子，日期核实成功但现有课程匹配门禁不发送；补齐 Maya 测试资料后通过。测试函数参数类型也已修正。失败及诊断日志保留，没有修改业务门禁或降低发送断言。

### 完整分钟提醒

**resident**

> Registration opens at 2026-08-22 at 09:00 America/Toronto. Your link: https://www.burlington.ca/en/recreation/registering-for-a-program.aspx

**non-resident**

> Registration opens at 2026-08-28 at 09:00 America/Toronto. Your link: https://www.burlington.ca/en/recreation/registering-for-a-program.aspx

### 自己复跑

此测试已写入版本控制范围内的 `apps/web/lib/registration/sequence/live-flow.pglite.test.ts`，平常回归默认跳过两项付费网络测试，只有显式 opt-in 才实际请求官网／模型。运行会产生 API 费用，不会发真实短信。

```sh
VIL423_LIVE_MINUTE_EVAL=true node --env-file=launch.env .corepack/v1/pnpm/9.15.0/bin/pnpm.cjs --filter @hale/web exec vitest run lib/registration/sequence/live-flow.pglite.test.ts -t 'R12 real official'
```

普通相关回归 **38 文件／793 通过、2 个 opt-in 场景跳过**；两项在上述真实运行中另行通过。Web 类型检查、skill 哈希和 diff 检查通过；测试文件仅既有及同样风格的非空断言 lint warnings。日志：`.local/vil423-pdf/live-minute-positive-{first,diagnostic,complete,regression}.log`。

## 2026-10-14：代码精确去重

- 在既有 SMS 格式化器去重本次工具提供的完整相同来源 URL；查询参数、锚点、较长路径／文件名不合并。完全相同的独立资格说明只保留程序提供的一份；不同措辞、嵌在其他句子中的文字不按关键词或语义删除。
- 不修改日期、人群标签、提醒状态、长度政策、模型或 prompt。保留多来源链接、资格警告、隐私遮罩、安全回复和操作确认。没有恢复短信裁剪。
- 新的格式化测试先复现 **3 项失败**，再修复通过；覆盖 9 个场景，并加强多来源 Coach 链路检查。相关回归 **38 文件／793 项通过**，Web 类型检查、核心文件 Biome、eval 语法与 diff 检查通过；错误样本校准仍通过。
- 之前五条真实官网／模型回答通过生产格式化代码回放，**5/5**：每个官方 URL 一份，必要资格说明保留。此回放没有 HTTP／模型调用，不冒称五次新实时问答。首轮回放脚本错用了 P02 不存在的报告字段，改为读取实际工具记录后通过；原失败日志保留，未改模型输出。
- 限制：不同措辞的重复说明仍可能存在，按用户约定不做语义去重。未 push／部署、写远程 DB 或发真实短信；分钟级提醒正向闭环仍待补。
- 日志：`.local/vil423-pdf/exact-dedup-{red,unit,regression,recorded-replies,recorded-replies-final,calibration}.log`。

### P02：实际 PDF 回复回放后的全文

> The page lists 2026-11-10 at 09:00 (America/Toronto), but it doesn't label that date as resident vs non-resident, so I can't confirm it's your household's opening date. Date reminders on this watch are paused while that gets sorted. Source: https://www.uxbridge.ca/public/download/files/360410 uxbridge: 2026-11-10 at 09:00 America/Toronto; resident/non-resident eligibility unconfirmed.

## 2026-10-14：只转述官网，不反推适用人群

- 解析逐条使用日期本身的明确人群标签；另一个更晚的非居民日期／延迟规则，不能把较早的未标日期变成居民日期。没有添加 King／Toronto 专属分支，也没有改变官网日期、模型或 Schema。原有日期／年份／原文取证和发送前校验保留。
- Coach 不再按日期顺序推断居民优先，也不再在只有明确非居民日期时自动补“居民优先未确认”。工具保留已标日期和未标日期两条官网事实；未标日期不会覆盖已标日期，也不会凭此获得家庭适用性。删除了此前为短信压缩隐藏其他未标日期的那一行。
- Toronto ARC 的旧预期把没有居民标签的 6 月 5 日开日认作居民日期，已按原文改成未标人群；不计算“晚 10 天”的日期。King 预期继续保持：12 月 7 日未标人群，12 月 11 日明确为非居民 aquatics。旧解析回放仍 **11/12 失败**，保留红测；修正解析指令后的 **12/12 新模型调用通过**，后续回放 **12/12、0 API 调用**；错误样本校准仍能检出错误。
- 最终真实英文官网／模型问答 **5/5 通过**：King 非居民、King 居民追问 12 月 7 日、Markham、Richmond Hill 双日期、Uxbridge PDF。以下保留完整回复；这不是穷尽所有页面／措辞，也没有把测试短信称为生产送达。
- 相关回归 **37 文件／783 项通过**，Web 类型检查、56 skill 哈希、核心改动文件 Biome、eval 语法及 diff 检查通过；既有 PGlite 测试的非空断言 warnings 未顺手清理。
- 未 push／部署、改远程 DB 或发送真实短信。明确适用人群和开放时间的分钟级提醒正向真实官网闭环仍待补；重复来源链接／资格说明未在本次去重。
- 原始日志：`.local/vil423-pdf/official-eligibility-{red,tool-red,tool-green,extraction-live,extraction-replay,extraction-broken,final-live,final-regression}.log`。

### 最终五题实际回复

**C07** When does King Winter 2027 swimming registration open for non-residents? Check the official page and include its link.

> Non-residents can register starting 2026-12-11 (America/Toronto, opening time not published) per King's page. There's also a 2026-12-07 date listed on the page, but its resident/non-resident eligibility isn't confirmed, so I can't say it applies to you. Date reminders are currently paused on this watch. Source: https://www.king.ca/recreation king: 2026-12-07 (opening time not published) America/Toronto; resident/non-resident eligibility unconfirmed. https://www.king.ca/recreation

**C23** I live in King. Does the Winter 2027 page explicitly say December 7 is residents-only? Tell me what it actually says for December 7 and for non-resident aquatics registration, with the source link.

> The King page lists two dates for Winter 2027: December 7, 2026 and December 11, 2026 (both America/Toronto, no times published). December 7 is not labeled resident-only or public on the page - its eligibility isn't confirmed either way, so I can't say it applies to your King household. December 11 is the page's general/non-resident aquatics opening. Source: https://www.king.ca/recreation. Date reminders on your watch are currently paused. king: 2026-12-07 (opening time not published) America/Toronto; resident/non-resident eligibility unconfirmed. https://www.king.ca/recreation

**C08** When does non-resident registration open for Markham 2026 Fall Programs, Swim Lessons and Winter Break Camps? Check the official page and include its link.

> Markham's page lists 2026-08-11 at 06:30 (America/Toronto) for Fall Programs, Swim Lessons and Winter Break Camps, but whether that date applies to residents vs non-residents isn't confirmed by this reading, so I can't say it's your non-resident opening specifically. Date reminders are paused while that's unclear. Source: https://www.markham.ca/sports-recreation-fitness/sports-recreation-programs/registration-and-general-information markham: 2026-08-11 at 06:30 America/Toronto; resident/non-resident eligibility unconfirmed. https://www.markham.ca/sports-recreation-fitness/sports-recreation-programs/registration-and-general-information

**C14** Do Richmond Hill residents and non-residents have the same Winter 2026-2027 registration date? Check the official page and tell me both dates.

> No, they're different. Richmond Hill's page lists residents registering from 2026-11-24 and non-residents from 2026-12-01 (America/Toronto, opening times not published for either). Heads up that date reminders are paused right now, so I'm not sending an auto-text for this one yet. https://www.richmondhill.ca/en/things-to-do/Community-Recreation-Guide.aspx

**P02** What is the exact registration date, opening time and timezone for Uxbridge Winter 2027 Uxpool swimming? Use the official PDF.

> The page lists 2026-11-10 at 09:00 (America/Toronto), but it doesn't label that date as resident vs non-resident, so I can't confirm it's your household's opening date. Date reminders on this watch are paused while that gets sorted. Source: https://www.uxbridge.ca/public/download/files/360410 uxbridge: 2026-11-10 at 09:00 America/Toronto; resident/non-resident eligibility unconfirmed. https://www.uxbridge.ca/public/download/files/360410

## 2026-10-14：取消 Coach 短信固定长度限制

- 删除发送前的两段短信截断、306 字符／三句硬门槛，以及截断触发的单来源报名压缩兜底。Coach skill 仍要求简洁，但完整事实优先；评测不再因字符、短信段数或句数拒绝回复。
- 保留来源 URL、资格说明、计划邀请、转发链接、隐私遮罩与安全回复。未改模型／生成 token 预算；未修改其他独立消息模块的长度规则或供应商输入限制（Linq 单 text part 的既有 10,000 字符校验保留）。
- 回归 **37 文件／782 项通过**；Web 类型检查、5 个改动业务／测试文件的 Biome、56 个 skill 哈希及 eval 语法检查通过。eval 保留原有 console 日志 lint warnings；错误样本校准仍能检出捏造、未批准操作和 app handback。
- 四个真实英文官网／模型场景的日期、时间精度、来源及安全检查通过。**不等于措辞全部无问题**：C07 的 “Resident priority is not confirmed as different” 仍可能误导家长以为无居民优先；两项居民分类分歧也未在本次处理。取消压缩后还显露已有的资格说明／URL 重复，事实未被截断，本次不扩大为文案去重修复。
- 家庭和存储是 PGlite；没有真实短信、远程 DB 写入、push 或部署。较长短信可能增加分段费用。原始日志：`.local/vil423-pdf/sms-no-length-cap-{regression,unit,live,broken}.log`。

### 四次真实提问与完整回复

**C07** When does King Winter 2027 swimming registration open for non-residents? Check the official page and include its link.

> The King page lists Winter 2027 registration opening December 11, 2026 (America/Toronto); it does not publish a specific time. Resident priority is not confirmed as different, so this is the general date shown for non-residents too. Date reminders are paused right now, but I'm watching it: https://www.king.ca/recreation

**C08** When does non-resident registration open for Markham 2026 Fall Programs, Swim Lessons and Winter Break Camps? Check the official page and include its link.

> Markham's page lists 2026-08-11 at 06:30 (America/Toronto) for Fall Programs, Swim Lessons and Winter Break Camps, but whether that date applies to residents or non-residents isn't confirmed, so I can't confirm it's your opening date. Date reminders are paused until that's verified. Source: https://www.markham.ca/sports-recreation-fitness/sports-recreation-programs/registration-and-general-information markham: 2026-08-11 at 06:30 America/Toronto; resident/non-resident eligibility unconfirmed. https://www.markham.ca/sports-recreation-fitness/sports-recreation-programs/registration-and-general-information

**C14** Do Richmond Hill residents and non-residents have the same Winter 2026-2027 registration date? Check the official page and tell me both dates.

> Richmond Hill's page lists different dates for each: residents can register starting 2026-11-24, non-residents from 2026-12-01 (America/Toronto; opening times aren't published for either). So no, they're not the same. Date reminders are currently paused while this gets reconfirmed - the official page is https://www.richmondhill.ca/en/things-to-do/Community-Recreation-Guide.aspx. https://www.richmondhill.ca/en/things-to-do/Community-Recreation-Guide.aspx

**P02** What is the exact registration date, opening time and timezone for Uxbridge Winter 2027 Uxpool swimming? Use the official PDF.

> The PDF lists 2026-11-10 at 09:00 (America/Toronto) for Winter 2027 Uxpool swimming, but it doesn't say whether that's resident-only or general, so I can't confirm it's your household's actual opening slot. Date reminders are paused until that's confirmed. Source: https://www.uxbridge.ca/public/download/files/360410 uxbridge: 2026-11-10 at 09:00 America/Toronto; resident/non-resident eligibility unconfirmed. https://www.uxbridge.ca/public/download/files/360410

King 最新：非居民跨年报名提问已连续 **3 次通过**，并保留日期／年份／原文门禁；两个分类和工具返回边界已修。相关回归 **1,912 通过**。扩展解析评测为 **10/12**，仍有 Toronto ARC／King 默认日期的居民分类分歧，不是全套绿灯；[完整问题、三次原回复及剩余项](vil-423-pdf-extra-questions.md)。

最新：[追加 8 个真实英文 PDF 问题及修复前后回复](vil-423-pdf-extra-questions.md)。补测先发现 “for everyone” 误推断（7/8）；现已区分已核实日期与未确认资格，修复后 **8/8**，加官网控制组和 cron 合并 **14 项通过**。Uxbridge 的日期仍能回答，但资格未确认时不调度报名时间提醒；下文早期把它当可调度公众日期的结论已被纠正。后续仅为报名解析启用严格 Schema，原无年份包装失败现已修复：独立解析 **11/11**、P02／R09／生产无年份调用 **3/3**，相关回归 **1,909 通过**；没有部署。

## 2026-10-14：方案一，本地 PDF 文字提取

报名读取器现在保留下载的二进制，按文件签名识别 PDF，用本地 `unpdf@1.8.1` 提取文字，再接回现有模型解析和日期／年份／时间／原文证据校验。没有新增外部服务或 API，也没有更换模型。HTML 消费者仍使用原来的字符串接口；对话、定期复查、发送前读取共用这个 PDF 入口。

### 真实来源与前后对比

来源为已关注的 [Uxbridge 官方活动指南](https://www.uxbridge.ca/public/download/files/360410)，81 页、802,073 字节；下载快照 SHA-256：`24cb3c81c37927213856de16210ae899daac244c60efea0304e10043be95bb65`。已对照第 21 个物理页的渲染图确认：**Uxpool 游泳**冬季报名为 2026-11-10，09:00，America/Toronto，不是全市所有活动的统一日期。该页未单独列出居民／非居民日期。

| 检查 | 修改前 | 本次验证 |
| --- | --- | --- |
| PDF 日期读取 | PDF 二进制当文本，安全暂停、提供链接 | 本地提取文字，原证据校验核实日期和时间 |
| 英文 Coach C09 | 无法从 PDF 核实日期 | 当场下载后回答报名日期、时区和官方 PDF 链接，不使用夹入的旧日期 |
| 改期通知 R09 | PDF 读取失败，无法重排 | 发送前再下载；以新日期提前调度并通知家长 |
| 报名时间提醒 R11 | PDF 来源无法发送已核实的时间提醒 | 用真实 PDF／模型和模拟时钟、家庭及短信载体验证：发送前重读，日期／时间／时区／链接保留；重复 cron 不重发、不重复抓取 |
| HTML 控制 C01／C08 | 已有实时日期读取 | Richmond Hill 日期精度、Markham 未确认资格说明均保留 |

### 验证与限制

- 最终真实英文批次 **5/5 通过**：C01、C08、C09、R09、R11。HTTP／模型调用真实，提醒家庭、时钟和短信载体为测试环境；不等同生产端到端送达。
- PDF、共享读取器、安全下载共 25 个本地测试；相关 Web 回归 **1,830 通过、1 个 opt-in live-intake 跳过**；Agent **125 通过**。Web 类型、生产构建、56 个提示词哈希和 diff 检查通过；Biome 无错误，保留原有非空断言警告。
- 过程保留失败证据：初次模型把跨行引用写成字面 `\\n`，证据校验正确拒绝；现在在 PDF 适配层统一空白，与 HTML 输入一致，不放宽证据规则。一个提醒测试使用早于初始化读取的固定时钟，已修正为读取后一小时。
- 真实问答曾生成无依据的“same date for all registrants”，已补强现有提示词；后续问答未再使用该断言。另一次测试把“the page lists no resident priority tier”误判为断言没有居民优先，现区分“网页没有标注”和“实际不存在”。这是有限样本验证，不是所有措辞的可靠性保证。初始与中间失败日志没有删除。
- 原有 HTTPS／DNS 固定、非公网地址拒绝、禁止重定向及 4 MB 下载限制保留。PDF 另限制 100 页、200,000 个提取字符、15 秒异步读取预算；超限拒绝，不静默截断后继续猜日期。**同步 PDF.js CPU 不能由该计时器硬中断**，需要硬 CPU 隔离时应改用 worker；本次没有新增 worker 系统。
- 无文字层的扫描件、加密／损坏或超预算 PDF 仍安全暂停，提供来源链接；没有 OCR。只读取已有 URL，不发现新活动；没有迁移远程 DB、真实短信、部署、push 或修改 Live Finder／短信长度策略。
- 原始日志、PDF 和渲染图在本地 `.local/vil423-pdf/`。回归：`regression-complete.log`；构建：`build-direct.log`；真实英文最终批次：`real-english-final.log`。测试入口沿用 `.local/vil423-pre-post/english-step1.test.ts`，运行时加载 `launch.env`，家庭／存储使用 PGlite，短信载体为 FakeTransport，官网 HTTP 与模型调用真实。

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
