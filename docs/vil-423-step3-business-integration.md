# VIL-423：Finder 事实绑定接入报告

2026-10-15（Toronto）的实现记录。分支 `codex/vil-423-live-truth`；分支检查点不等于合并或上线。

2026-10-16 补充：extract 已只接收 Step 2；新的 4 个英文官网→Coach 实测为 3 个事实检查通过、1 个 RBG 检索失败。全量回归和实际回复见[最新实测报告](vil-423-step3-live-validation-2026-10-16.md)。下方 10 月 15 日实测保留为历史记录，不冒充本次 prompt 切分的 A/B。

## 五项改动，各给一个具体例子

下面逐项对应“交付内容”表，不把实现变化和模型错误率混为一谈。第 1 项使用真实官网快照的模型输出；第 2–5 项使用当前代码的合成回归用例，专门检验拦截与交接机制。旧行为按基线 `03b5d1e53` 的代码说明，不冒充五次真实短信前后 A/B。

### 1. `when` 从模型写整句话，变成代码拼接独立场次

**来源：真实 Bostwick 官网快照。**两个场次分别是 10 月 16 日 10:30–11:30、10 月 21 日 09:30–10:30。

**原来：**模型直接输出整段文字，代码原样采用：

```json
{"when":"Bostwick Library: October 16, 2026, 10:30 am - 11:30 am; October 21, 2026, 9:30 am - 10:30 am"}
```

**现在：**模型分别提取两场，每场附自己的官网原文。以下只展示日期/时间字段；代码核对来源和日期范围后生成 `when`：

```json
{"sessions":[{"date":"2026-10-16","start_time":"10:30","end_time":"11:30"},{"date":"2026-10-21","start_time":"09:30","end_time":"10:30"}]}
```

```text
when = 2026-10-16 10:30–11:30; 2026-10-21 09:30–10:30
```

**实际差别：**不再让模型自由生成最终排期字符串；两天各自保留对应时间。这个样本原来就答对了，不能说它证明旧版发生过串场。[原始配对输出](../.local/vil423-pre-post/step3-evidence-ab.log)；当前场次生成的回归依据见 [facts.test.ts](../apps/web/lib/channel/activity/facts.test.ts)。

### 2. 模型填了 `Free`，但找不到原文，就不采用这个价格

**输入：合成测试页**写的是 `Cost: $20 per child plus mandatory $2 fee.`。故意让模型结果含有：

```json
{"price":"Free","price_evidence":"Admission is free"}
```

**原来：**只要其他必需字段齐全，转换层会保留非空的 `price: "Free"`；没有代码核对这段价格原文。

**现在：**在对应来源页找不到 `Admission is free`，所以输出 **`price: null`**，不是免费，也不会擅自从其他文字补一个价格。若年龄原文不存在，同理不采用该年龄，并把活动降为未确认参考。

这证明的是“缺引用则拒用字段”，不是代码能理解任意引用的语义归属。[当前价格和未知年龄测试](../apps/web/lib/channel/activity/facts.test.ts)。

### 3. 即使模型没删掉旧日期、月份外日期，代码也会拦截

**输入：合成边界测试。**固定今天为 2026 年 10 月 15 日，家长问 `October 2026`；分别注入模型输出日期 `2020-10-16`、`2026-11-16`、`2026-02-31`，同时保留看似可用的自由文本 `when: "October 16 at 10:30"`。

**原来：**转换层本身不检查日期范围与有效性，依赖模型先筛掉；旧日期字段和自由文本可以继续传下去。

**现在：**三种输入都得到 **`picks: []`**；保留活动参考，但其 **`when: null`**。不会删掉有问题的结构化日期后，又从自由文本恢复出一个可推荐排期。

这是故意注入错误结果的代码测试，不是声称真实模型本次产生了这三个错误。[当前日期及禁止回退测试](../apps/web/lib/channel/activity/facts.test.ts)。

### 4. “没有可推荐结果”不再只剩一个空结果标记

**输入：合成工具测试。**本次读到 `Past workshop` 的旧活动页，没有当前场次。

**原来交给 Coach 的失败结果：**

```json
{"found":false,"reason":"no_picks"}
```

**现在交给 Coach 的结果节选：**

```json
{"found":false,"reason":"no_picks","references":[{"name":"Past workshop","status":"historical","when":null,"sourceUrl":"https://venue.example/old?program=kids#details"}],"checkedSources":["https://venue.example/old?program=kids#details"]}
```

**实际差别：**Coach 能知道“读到了历史活动，但当前场次未确认”，并保留链接；不是“这家没有活动”。若活动年龄未确认，则参考的 `status` 是 `unconfirmed`、`ageFit` 是 `null`，不能说适合孩子。这里只验证工具交接，不把期望文案冒充真实 Coach 回复。[当前历史参考交接测试](../apps/web/lib/channel/activity/tools.test.ts)、[未知年龄测试](../apps/web/lib/channel/activity/facts.test.ts)。

### 5. 未确认的后续短信，也会附上这次读过的官网链接

**输入：合成发送测试。**文案生成器固定返回：

> I could not establish a current session from the page. I will keep looking.

本次已读来源列表含两条相同的 `https://venue.example/programs?topic=kids#dates`，另混入一条不安全的 `javascript:alert(1)`。

**原来：**这条文案通过后，没有代码把已读来源补到短信里，因此会缺少官网链接。

**现在：**测试传输收到上述文案，并附上 **一次** `https://venue.example/programs?topic=kids#dates`；重复链接去掉，`javascript:` 不会发送。链接的 `?topic=kids` 也不会被误当成询问家长的问号。

这是当前 follow-up sweep 到本地测试传输的验证，文案是测试输入，不是新买的模型回复，也不是已发送的真实短信。[当前发送测试](../apps/web/lib/channel/activity/sweep.test.ts)。

另需查看真实模型的对话前后片段，可看[接入前的方案 A/B 报告](vil-423-evidence-contract-experiment.md)；接入后新抓官网的完整英文回复仍保留在下方。

本次报告核对：将第 1 项保存的真实提取结果交给当前绑定函数，得到上述 `when`；第 2–5 项对应的 facts/tools/sweep 三个测试文件重新运行，共 **78 条通过**。没有新调用模型或发送真实短信。

## 交付内容

已接入实际 Finder → 工具返回 → Coach 回复，以及浅层活动 follow-up 的交接和发送路径，不再只是实验脚本。

| 原先 | 现在 |
| --- | --- |
| 模型直接拼接 `when` | 明确日期按 `sessions[]` 提取，每场独立携带日期、时间和原文；代码生成兼容的 `when` |
| 年龄、价格与原文的对应关系主要靠提示词 | 每个字段携带原文，并核对原文确实存在于本次读取的对应 URL；缺依据的字段不采用 |
| 旧日期或月份不符可能随文字传下去 | 代码校验日期有效性，过滤过去及请求范围外的场次；不允许退回自由文本绕过筛选 |
| 未确认结果容易变成确定推荐或“没有活动” | 区分可推荐结果、历史参考、未确认参考，保留来源和不确定性供 Coach 说明 |
| 空结果后续短信可能没有来源 | 通过现有安全校验后，由代码附加本次读取的安全来源链接并去重 |

明确发布的营业时间、周期安排仍保留，不捏造具体日期。只有学期文字、没有当前适用依据时保留为参考。现有年龄匹配、地理过滤、隐私、同意和发送安全检查继续保留。

日期边界使用已保存的家庭时区；旅行调用使用行程表已有的完整起止日期做内部校验，不让模型从省略年份的搜索文字猜年份。没有新 API、依赖、模型切换、数据库表或迁移。

## 验证

| 检查 | 结果 |
| --- | --- |
| Web 全量回归 | 最终代码 10,443 通过，14 跳过（751 个文件通过，4 个跳过） |
| Worker 全量回归 | 437 通过，1 跳过 |
| Agent 包回归 | 157 通过 |
| 真实模型录制的既有旅程回放 | 15 通过；旧录制未覆盖，新增 26 条内容寻址录制 |
| 技能文件哈希 | 72 个匹配 |
| Web typecheck、production build | 最终代码均通过 |
| 共享事实边界测试 | 覆盖逐场次、假引用、未知年龄/价格、历史、月份、非法日期、正常周期安排、时区跨日和旅行已有日期 |
| 后续发送测试 | 本地测试传输验证来源去重、安全 URL 和带查询参数链接；未发送真实短信 |

完整 Web 回归日志：`.local/vil423-pre-post/business-evidence-web-final.log`。其余日志使用同目录的 `business-evidence-*` 前缀。

### 真实英文官网 → Finder → Coach

不是模拟模型输出。使用真实公开网页、本次 HTTP 读取、实际工具和 Coach runtime；家庭数据来自本地 PGlite，未连接远程业务库、未调用短信运营商。

| 问题 | 实际结果 | 整段运行时间 |
| --- | --- | --- |
| London Public Library October 2026 storytimes，要求官网日期、时间、价格和链接 | 3 条 Oct 16 场次，Masonville、Beacock、Bostwick 各自保留时间与年龄；价格未知 | 131.406 秒 |
| Are the London Public Library Storytime programs free…? | 1 条 Masonville 具体活动页；明确不把未公布价格当作免费，也不推断整月周期 | 126.263 秒 |

两次共 4 条返回记录的对应来源、原文、日期、时间和年龄已对照保存的网页正文检查。第一次实测在最终家庭跨日边界补丁前；第二次已带 Toronto 本地日期。之后只补旅行调用已有日期，不改变这两条本地搜索的路径。

第二次的完整实际回复：

> I can't say they're free. The London Public Library pages I read don't publish a price for Storytime, so I won't assume it. The one listing I found is "Storytime (Ages 1+), Masonville Library, London Public Library". It's drop-in, for ages 1 and up, on Fri, Oct 16, 2026, 10:30-11:30 am. The library's page describes it as "stories, songs, rhymes and more". That page gave no price and no recurring schedule, so I can't confirm other October dates or branches. Sources: https://www.lpl.ca/events/storytime-ages-1-149 and https://www.lpl.ca/whats-on

原始记录保留于 `.local/vil423-pre-post/business-evidence-live-london.log` 和 `business-evidence-live-final.log`。这些耗时不是短信首回复 p50/p95；速度没有因此完成验收。

## 尚未验收的边界

- 原文存在不等于语义归属绝对正确；不能声称对任意网站零幻觉。年龄筛选器、旁栏等语义归属仍由同一次提取模型判断，代码不是完整自然语言验证器。
- 无法明确解析的自然语言日期范围保守交接为未确认，不放宽为任意日期；不是所有自然语言时间表达都已支持。
- 旧 Finder 8 案例质量评测入口已对齐共享协议，并修好路径加载；`--cached-only` 正确报新协议缓存缺失，尚未重录，不能列作通过。
- 本轮没有重写独立 deep researcher，也没有验证真实运营商发送、生产部署或远程删除旧表；不代表整个 VIL-423 已上线完成。
