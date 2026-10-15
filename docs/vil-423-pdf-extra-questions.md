# VIL-423：PDF 英文问答补测 8 题

**最终分钟级正向闭环已补：Burlington 居民／非居民 2/2 通过。** 真实 HTTP／模型、生产 cron 与 SQL 去重执行，时钟、家庭及发送载体为测试环境；使用官网仍公布的历史周期，没有改年份或实发短信。[完整提醒、测试边界与复跑命令](vil-423-registration-tool-validation.md)。下文“分钟提醒待补”是历史状态。

**最新官网标签修复：12/12 解析、5/5 实际英文问答通过。** Toronto 旧测试的“居民日期”预期没有原文标签支持，已修正；King 不再把 12 月 7 日反推为居民专属，12 月 11 日保留官网明确的非居民 aquatics 标签。工具保留两条日期，完整回复见[最新验证报告](vil-423-registration-tool-validation.md)。下文 10/12 是修复前的历史记录；分钟级提醒正向闭环仍待补。

**最新修复复测：同样 8 题全部通过。** 以下保留修复前的 7/8 和完整原回复；修复后的数据、实际回复及提醒行为见文末。不是删除失败结果后重新报绿。

**后续严格 Schema 验证：11/11 解析样本、3/3 生产路径场景通过。** 文末所述无年份样本的额外包装问题已通过严格模式修复；原失败记录保留，详见最后一节。

**再后续 King 复测：非居民问答连续 3 次通过。** 跨年年份取证及两个分类／工具返回边界已修；扩展到 12 个解析样本后的严格评测为 **10/12**，仍有两个居民日期分类分歧，不是全套绿灯。详见文末 King 一节；上面的 11/11 是此前版本的独立记录。

2026-10-14。人工复核 **7 题通过、1 题失败**。8 题都实际调用官网 HTTP、PDF 本地文字提取、原解析模型和 SMS Coach；不是模型 mock 或缓存回放。每题独立测试家庭，均预置错误旧日期 2026-11-26。家庭与存储为 PGlite；没有生产短信、远程 DB 修改或部署。本次只改测试检查器和报告，没有修业务代码／提示词。

## 结论

- **实时日期读取 8/8 正确**：每题重新下载并核实 2026-11-10、09:00、America/Toronto，最终回复均包含来源链接，没有复述错误旧日期或 noon。
- **完整回答不是全通过**：P02 擅自增加 “for everyone”。PDF 仅列出报名日期，没有证据确认居民与非居民都适用。因此此前小样本通过不能证明这个资格措辞问题已彻底解决。
- 实际请求：官网 GET **8 次**，解析模型 **8 次**，Coach 模型 **16 次**。8 次读取的 PDF SHA-256 均为 `24cb3c81c37927213856de16210ae899daac244c60efea0304e10043be95bb65`。
- 同一份 [Uxbridge 官方 PDF](https://www.uxbridge.ca/public/download/files/360410) 的八种问法，不是八份不同 PDF。没有覆盖扫描件或 App Ask。

## 逐题结果

| ID | 实际英文问题 | 人工复核 |
| --- | --- | --- |
| P01 | When can I enroll in Uxbridge Winter 2027 Uxpool swimming? Please check the current official guide and send its link. | 通过：`enroll` 问法触发读取；日期、时间、时区、链接正确，并说 resident priority isn't confirmed |
| P02 | What is the exact registration date, opening time and timezone for Uxbridge Winter 2027 Uxpool swimming? Use the official PDF. | **失败**：日期时间正确，但擅自添加 for everyone |
| P03 | Does that November 26 at noon date still hold for Uxbridge Winter 2027 Uxpool swimming? Recheck the official PDF and give me the current date, time and link. | 通过日期纠正：读取后回答 Nov 10、09:00，不重复旧日期／noon；措辞观察见下方 |
| P04 | And when can I do that? Please include the official link. | 通过：依靠前文课程上下文调用工具，不靠当前消息中的报名关键词 |
| P05 | What time does it open, and which timezone is that? Please check again and include the source. | 通过：即使前文已有日期，仍重新下载；回答 09:00 和 America/Toronto |
| P06 | Do Uxbridge residents and non-residents both register for Winter 2027 Uxpool swimming on the same date? Check the PDF, tell me the date and time it lists, and distinguish what it confirms from what is unclear. | 人工通过：给日期时间，说明仅确认页面列出的日期，resident priority isn't established；未断言同日对所有人开放 |
| P07 | I do not live in Uxbridge. Does the Winter 2027 Uxpool swimming PDF confirm that I can register on its listed opening date? Tell me that date and time, and be explicit if non-resident eligibility is not stated. | 通过：给日期时间，但明确 can't confirm you're cleared to register then |
| P08 | For Uxbridge Winter 2027 Uxpool swimming, what date and time does registration itself open, rather than the office opening hours? Check the official PDF and link it. | 通过：正确读取报名的 09:00，没有套用旁边办公室营业时间 |

P03 的前文故意写了错误 Nov 26 at noon；P04 的前文仅说正在讨论该游泳课程报名；P05 的前文只给日期、不含开放时间。

P03 还说了 “The date changed”。这个测试只证明纠正了错误旧值，没有证明官网真实改过日期；更精确的措辞应是“当前官网列出的日期是……”。本项日期纠正通过，不算官网变更检测的成功证据。

## 逐题实际完整回复

以下为同一批测试的最终回复原文，未润色；重复链接及失败措辞也原样保留。问题与前文上下文见上表。

### P01 — 通过

> Registration opens Nov 10, 2026 at 9:00am (America/Toronto); resident priority isn't confirmed. I'm already watching this one and will text you right at opening. Source: https://www.uxbridge.ca/public/download/files/360410

### P02 — 失败

> Registration opens Nov 10, 2026 at 9:00 a.m. (America/Toronto) for everyone - no separate resident priority listed. You're on the watch, so I'll text you right at opening. https://www.uxbridge.ca/public/download/files/360410

问题是 **for everyone**，不是日期提取失败。没有标注单独居民日期，不能推出所有人适用。

### P03 — 日期纠正通过，变更措辞需更严谨

> The date changed: Winter 2027 Uxpool swimming registration now opens Nov 10, 2026 at 9:00am (America/Toronto) per the official page. Your watch is active, so I'll text you when it opens. https://www.uxbridge.ca/public/download/files/360410

### P04 — 通过

> Registration opens Nov 10, 2026 at 9:00 am (America/Toronto) - I'm watching it and will text you the moment it opens. Source: https://www.uxbridge.ca/public/download/files/360410

### P05 — 通过

> Registration opens November 10, 2026 at 9:00 a.m. America/Toronto, per the PDF: https://www.uxbridge.ca/public/download/files/360410. I'm watching it and will text you when it opens. https://www.uxbridge.ca/public/download/files/360410

### P06 — 人工复核通过

> The page lists Nov 10, 2026 at 9:00 (America/Toronto) for Winter 2027 Uxpool swimming - only a general date is confirmed, so resident priority isn't established. I'm watching it and set to text you right at opening. https://www.uxbridge.ca/public/download/files/360410

### P07 — 通过

> The page lists Nov 10, 2026 at 9:00 am (America/Toronto) for Winter 2027 Uxpool swimming. Resident priority isn't confirmed, so non-resident eligibility for that date isn't stated either - I can't confirm you're cleared to register then. https://www.uxbridge.ca/public/download/files/360410

### P08 — 通过

> Registration for Winter 2027 Uxpool swimming opens Nov 10, 2026 at 9:00am (America/Toronto), per the official PDF: https://www.uxbridge.ca/public/download/files/360410. You're on the active watch, so I'll text you right when it opens. https://www.uxbridge.ca/public/download/files/360410

### 自动检查与人工结论的区别

原自动检查显示 7 通过、1 失败，但具体判错了两处：漏掉 P02 的 “for everyone”；把 P06 的 `9:00`（没有前导零／am）及 `isn't established` 误判成时间／资格说明缺失。已补充检查器识别这三种表达，没有更改业务代码或重新付费刷结果。人工复核最终仍是 **7/8**，失败的是 P02，不是 P06。

原始日志完整保留：[8 题真实运行](../.local/vil423-pdf/real-english-eight-extra-selected.log)。首次测试名称筛选未匹配、零题执行的日志为 `real-english-eight-extra.log`，不计入结果。

复跑命令（会产生真实模型费用；使用测试家庭，不发送真实短信）：

```sh
node --env-file=launch.env .corepack/v1/pnpm/9.15.0/bin/pnpm.cjs --filter @hale/web exec vitest run --config /Users/yuhangsong/hale/.local/vil423-pre-post/english-step1.config.mts --testNamePattern 'P0[1-8]'
```

## 修复后复测 — 2026-10-14

### 修复内容

- 原解析提示词把“未标居民／非居民的唯一日期”归入 `general_open`；现在单独返回 `unclassified_open`，不再推断所有人适用。该日期仍通过原有年份、日期、时间、引用和时区检查。
- 共享归一化层也会拦截“模型误放进 general、没有居民日期、引用没有公众报名标签”的旧形状。不再只对 Markham／Oakville 等特定主机检查资格。
- Coach 工具不再把这类日期交成家庭适用日期：`generalOpens: null`、`unclassifiedOpens: "2026-11-10 at 09:00 America/Toronto"`、`reminderState: "paused"`、`minuteReminderAvailable: false`。对话、通知和原有发送保护复用此状态；没有新增 DB 表、外部 API 或更换模型。
- **行为更正：Uxbridge PDF 的报名时间已核实，适用人群没有核实。** 可以报日期、说明不确定并给链接，但不会替该家庭重排／发送报名时间提醒。之前测试把它当成可调度的公众日期，现已纠正。

### 八题实际最终回复

P01、P02、P03、P04、P05、P06、P07、P08 的最终家长可见回复均为以下完整文本（8 条逐字相同，按原日志合并展示）：

> Page lists 2026-11-10 at 09:00 America/Toronto; resident/non-resident eligibility unconfirmed. Date reminders paused. https://www.uxbridge.ca/public/download/files/360410

这是生产 SMS 格式化后的回复，复用了此前已有的资格说明保护／超预算精简路径，不是测试直接返回模板。P02 的原始 Coach 回答也已不含 `for everyone`：

> The PDF lists 2026-11-10 at 09:00 (America/Toronto), but it doesn't say if that's resident-only or general, so I can't confirm it applies to your household. Date reminders are paused: https://www.uxbridge.ca/public/download/files/360410

| 测试 | 修复后结果 |
| --- | --- |
| P01–P08：原八个英文问题 | **8/8 通过**；均重新读取、保留正确日期／时间／时区／链接和资格说明；不含人人适用的断言；工具不返回公众日期；提醒暂停 |
| C01／C02：Richmond Hill 居民／非居民 | 通过；Nov 24／Dec 1 两类日期保留，不编造未发布的时间 |
| C06：Burlington 非居民 | 通过；Aug 28、09:00 与居民优先日期仍区分正确 |
| C08：Markham 未确认资格 | 通过；日期保留、明确资格未确认、提醒暂停 |
| R09：PDF 通知 | 通过；发送前再读，给日期与资格说明，不发送“已替你重排”的误导通知 |
| R11：到 PDF 列出的报名时间／重复 cron | 通过；只有资格待确认通知，不发报名时间提醒，也不重复发送 |

合并 **14 个真实官网／模型场景通过**。首批 13 个通过，R11 因测试把 ISO 时间的 `Z` 与 `.000Z` 作字符串比较而失败；改为比较规范化时间后单独复测通过。旧失败日志保留。家庭、时钟、发送载体仍是测试环境，不是生产实发。

R11 实际通知原文：

> The page lists 2026-11-10 at 09:00 America/Toronto; resident/non-resident eligibility is unconfirmed. I can't confirm this applies to you. Date reminders are paused. https://www.uxbridge.ca/public/download/files/360410

### 其他检查及剩余限制

- 新回归先失败再修复，覆盖无标签 PDF、不依赖主机名的误分类保护、新输出字段解析及日期／年份／时间证据门禁。相关 Web **1,837 通过、1 个 opt-in 跳过**，Agent **125 通过**；Web 类型、56 个提示词哈希、核心 Biome 与 diff 检查通过。两个旧测试文件只跑 lint，未顺手改其原有格式；非空断言等原有警告保留。
- 同步既有解析评测的字段与期望，并真实重录 **11 个样本，10/11 严格通过**。`no-year-stated` 的模型输出多包了一层 `published_registration_window`，内层实际为 `found: false, reason: no_year_stated`，但顶层不符合 schema；生产同样会拒绝，不能当正常解析成功。没有解包放宽校验或合成缓存。本次未扩大修通用输出结构；不能声称全部解析评测绿灯。故意错误模型的反向校准通过。
- 没有 push、部署、远程迁移或真实短信；没有修改 Live Finder、模型、token 上限或短信长度政策。无文字层 PDF 仍不支持，单次八题通过不代表所有站点和问法的可靠性保证。
- [真实问答及 R09 原始记录](../.local/vil423-pdf/eligibility-root-live.log)、[R11 修正测试时间格式后的记录](../.local/vil423-pdf/eligibility-root-minute-hold.log)、[本地业务回归](../.local/vil423-pdf/eligibility-root-regression-final.log)、[独立解析评测及未通过项](../.local/vil423-pdf/eligibility-root-extraction-eval.log)。

## 后续：报名解析启用严格 JSON Schema — 2026-10-14

只给 `published_registration_window` 启用 `strict: true`；共享调用器新增可选参数，其他调用默认不变。生产和独立评测使用同一份封闭 Schema，顶层和日期对象均禁止额外字段。本地 Zod 同样拒绝额外字段，继续保留置信度范围、日期／时间格式及原文证据校验；没有增加自动解包或降级到非严格模式。

本次直接验证了当前 `claude-sonnet-5` 和现有 Anthropic 通道，没有换模型、升级 SDK 或新增 API。首轮 API 拒绝了“类型数组 + 可空枚举”的写法，已改成等价的 `anyOf`；严格模式不支持的数值上下限只从发送的 Schema 移除，本地 `0..1` 校验不变。原 400 失败日志保留，没有通过关闭严格模式解决。

### 验证结果

| 检查 | 结果 |
| --- | --- |
| 既有解析评测 | **11/11**；11 次真实新调用，包括之前失败的 `no-year-stated` |
| 同一评测缓存重放 | **11/11**；0 次新调用。严格模式使用单独缓存命名空间，不复用旧非严格结果，不合成缓存 |
| 故意错误输出的反向校准 | 通过：检查器仍能拒绝错误样本 |
| P02：实际 PDF 问答 | 通过，日期／资格说明／链接保留，无 `for everyone` |
| R09：实际 PDF 提醒通知 | 通过，发送前重新读取，通知资格未确认和暂停，不承诺报名时间提醒 |
| S01：生产调用器读取无年份文本 | 通过；断言实际请求携带 `strict: true`，单次调用直接得到顶层结果，没有包装或重试 |
| 相关 Web 回归 | **1,909 通过、1 个 opt-in live-intake 跳过**；包含共享调用器默认不启用、仅显式启用、坏结构不自动解包／不回退的测试 |
| 类型和检查 | Web typecheck、核心 Biome、评测 JS 语法和 diff 检查通过；原有非空断言警告保留 |

### 无年份样本实际返回

以下为 S01 实际工具输入中的关键字段，均在顶层（其余字段在原始日志中）：

```json
{
  "found": false,
  "reason": "no_year_stated",
  "preview": null,
  "resident_open": null,
  "general_open": null,
  "unclassified_open": null
}
```

这里通过的是“按规定格式说明年份无法核实”，不是推断出一个官网没有写的日期。生产模型输出仍需日期／资格证据校验；严格结构不能保证事实正确，截断和无工具结果仍拒绝。

P02 最终实际回复：

> Page lists 2026-11-10 at 09:00 America/Toronto; resident/non-resident eligibility unconfirmed. Date reminders paused. https://www.uxbridge.ca/public/download/files/360410

R09 最终实际通知：

> The page lists 2026-11-10 at 09:00 America/Toronto; resident/non-resident eligibility is unconfirmed. I can't confirm this applies to you. Date reminders are paused. https://www.uxbridge.ca/public/download/files/360410

本轮没有重跑全部八个问法或全仓测试；上述八题结果属于前一轮资格修复验证。这次没有 push、部署、远程 DB 写入或真实短信。

日志：[11 项真实评测](../.local/vil423-pdf/strict-schema-extraction-second.log)、[0 调用重放](../.local/vil423-pdf/strict-schema-extraction-replay.log)、[3 项生产路径验证及完整模型输出](../.local/vil423-pdf/strict-schema-production-live.log)、[回归](../.local/vil423-pdf/strict-schema-regression.log)、[首轮 Schema 兼容性错误](../.local/vil423-pdf/strict-schema-extraction-live.log)。API 能力依据：[Anthropic 严格工具调用](https://platform.claude.com/docs/en/agents-and-tools/tool-use/strict-tool-use)、[支持的 Schema 子集](https://platform.claude.com/docs/en/build-with-claude/structured-outputs#json-schema-limitations)。

## King 当前版本复测与跨年取证修复 — 2026-10-14

### 修复前重新确认

当前严格 Schema 版本仍复现 `uncorroborated`：模型返回 2026 年报名日期，但 `yearEvidence` 只引用 2027 年课程／上课时段标题。网页下载和引用匹配都成功，失败点是年份证据没有覆盖返回的 2026 年日期。严格 Schema 没有也不应该绕过这个事实校验。

原 C07 允许“安全暂停”通过，不代表能回答日期；现已取消这个兜底，通过必须实际核实日期。最终两次重复还要求回复明确包含 2026 年、工具保留已确认的非居民日期、不用另一条未知资格日期覆盖它。

### 本次改动

1. 解析提示词新增四行：年份证据要覆盖每个返回日期的日历年；跨年时引用含报名年份的段落，不只引课程年份标题。没有修改年份／日期／原文证据门禁，没有换模型。
2. 分类检查识别网页实际用语 `registration for non-residents`，不把明确标了非居民的日期错误降级为未知；单数／复数和词序已有回归。没有扩大成根据缺失标签推断人人适用。
3. 同页存在“已确认适用日期”和“另一条未标人群日期”时，工具优先返回该家庭适用的已确认日期，不让另一条未知日期的 caveat 覆盖它。未知日期本身仍保存在读取历史中；没有确认适用日期的 Markham／Uxbridge 仍按原规则暂停。

### 实际提问及三次完整回复

问题：When does King Winter 2027 swimming registration open for non-residents? Check the official page and include its link.

第一次：

> King's page lists Winter 2027 registration opening 2026-12-11 for non-residents (America/Toronto), with no time published yet. Date reminders are paused right now - source: https://www.king.ca/recreation

第二次（增加更严格断言）：

> The page lists Dec 11, 2026 for registration (America/Toronto) but hasn't published a time, and resident priority isn't confirmed for that date. Date reminders are paused right now: https://www.king.ca/recreation

第三次：

> The King.ca page lists Winter 2027 registration opening Dec 11, 2026 (America/Toronto); resident priority isn't confirmed and the opening time isn't published. Date reminders are paused right now - https://www.king.ca/recreation

三次都是新官网 HTTP、新解析和新 Coach 调用，非缓存重放。第二、三次记录的 `pendingChange.kind` 为 `later`：测试故意存了 11 月 26 日，现在读到 12 月 11 日，按原规则等待家长确认；暂停**不是**日期仍然无法核实。官网没有报名小时，未编造时间。

### 验证与未完成项

- King 非居民问题 **3/3**；Markham、Uxbridge 控制问答 **2/2**，仍保留未知资格保护。
- 新边界回归先失败后通过。相关 Web **1,912 通过、1 个 opt-in 跳过**；Agent **125 通过**；Web 类型、56 个提示词哈希、核心 Biome、JS 语法和 diff 检查通过。原有非空断言警告保留。
- 扩展解析评测 **10/12 严格通过**：Toronto ARC 的已打印默认日期被模型归为未分类，而测试期望居民；King 的另一条 12 月 7 日默认日期被模型归为居民，而按无明确居民标签的保守期望应为未分类。两项分歧是适用人群分类，不是把日期／年份读成另一日；也不是新非居民问答失败。新增 King 样本最初把默认日期预期为居民，按保守取证口径改为未分类后如实保留失败，没有为了报绿改成接受模型结果。
- 本次不继续扩大修改居民推断规则。尚不能声称全部城市、全部居民日期分支已通过；未 push、部署、远程迁移或真实短信。

原始证据：[修复前当前版本仍失败](../.local/vil423-pdf/king-current-live.log)、[跨年修复后的首次读取及暴露的分类边界](../.local/vil423-pdf/king-cross-year-live.log)、[边界修复后 King 和控制组](../.local/vil423-pdf/king-boundary-live.log)、[第二次](../.local/vil423-pdf/king-final-repeat-1.log)、[第三次](../.local/vil423-pdf/king-final-repeat-2.log)、[12 项严格评测重放与未通过项](../.local/vil423-pdf/king-cross-year-replay.log)、[最终业务回归](../.local/vil423-pdf/king-final-regression.log)。
