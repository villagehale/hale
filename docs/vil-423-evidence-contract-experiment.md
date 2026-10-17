# VIL-423：事实与证据交接 A/B 实验

2026-10-15，产品基线 `03b5d1e53`。**本文记录接入前的实验，不代表当前代码状态。** 后续业务接入与验证见 [接入报告](vil-423-step3-business-integration.md)。

## 结果先说

小样本支持继续验证“事实绑定原文证据＋逐场次日期/时间＋未确认参考单独交接”这个方向，但不能作为生产完成验收。新方案降低了本批网页上的证据关联错误，保住了全部正向案例。最终 Coach 仍有历史状态表达不够准确的问题；实验协议也还没有覆盖全部现有生产字段。

| 检查项 | 现有方案，本轮新样本 | 实验方案，本轮新样本 |
| --- | --- | --- |
| 将年龄筛选器当成活动年龄 | 1/3 次出现 | 0/3；原始模型输出也没有伪造活动 |
| 指定 Preschool Storytime，却混入同页其他活动 | 3/3 次 | 0/3；3/3 保留目标课程为参考，当前场次未确认 |
| Bostwick 两个场次的不同时间 | 3/3 正确 | 3/3 正确，两条 session 各带原文 |
| 简单合成月份筛选 | 3/3 正确 | 3/3 正确，保留 2026-10-24 |
| 合成付费活动，旁边有其他年龄的免费活动 | 3/3 正确 | 3/3 正确，保留 $20/child + mandatory $2 fee |
| 正向案例保留 | 9/9 | 9/9，没有靠全删结果避错 |

这里的 1/3 是本轮配对实验的新样本，不替换上一轮诊断的 2/3；不能把不同批次的采样差异归因于代码修改。旧方案的旧日期有 caveat，不把“保留旧日期说明”误报为“冒充新日期”。

## 比较的是什么

两组使用相同网页原文、相同逐字输入、当前 `claude-sonnet-5-5`、相同 thinking/effort、相同 **1024 token** 上限。每类 3 对，共 30 次逻辑提取；输入 hash 相同已断言。两组共同获得 `today: 2026-10-15` 和明确的日期范围 `2026-10-15` 至 `2026-10-31`。这不是生产中任意自然语言月份解析的验收。

现有组使用当前生产提取 prompt、JSON Schema、Zod 校验和 `toPicks`。实验组在同一调用内使用以下内部协议：

- 活动名称、年龄、费用携带对应原文证据。
- 用 `sessions[]` 表达每次明确的日期/时间及其证据，不让模型自由拼接 `when`；由代码生成向后兼容的显示字段。
- 代码核对引用存在于对应 URL、日期有效且在范围内、时间格式有效。
- 有具体年龄证据和范围内场次的结果进入 picks；有真实课程依据但属性未确认的结果进入 references，保留 URL 和 caveat。

这是**提示词＋内部结构＋筛选和交接的整体方案实验**，不是某一个字段或原文引用机制的独立因果测试。代码能核对原文存在，但不能证明原文与活动的语义归属。实验没有增加模型层数，也没有接新 API、原生 citations 或 DOM 分块器。

三类输入是此前真实官网读取的文本快照，两类是明确标注的合成对照。没有本轮新搜索/HTTP，因此不是当前官网变化或完整搜索质量的证据。

## 实际提取例子

London 通用列表，现有组其中一次：

```json
{
  "name": "Storytimes, London Public Library (listed under What's On: Programs & Events, filterable by the Storytime subject and Ages 2-5)",
  "age_fit": "Ages 2-5 (the library's audience filter for this age group)"
}
```

实验组 3 次均不把该导航/筛选组合生成活动。仍向 Coach 提供 checkedSources，使它能说明本次读过什么并给链接，而不是声称没有活动。

旧 Preschool Storytime，实验组返回课程原文与年龄原文，但不编当前 sessions。代码保留为：

```json
{
  "name": "Preschool Storytime, Burlington Public Library (Central - Children's Program Room)",
  "ageFit": "Children ages 3-5 capable of sitting on their own without a caregiver present",
  "when": null,
  "status": "unconfirmed",
  "caveat": "No dated session in the requested period was established; do not present an old session as current.",
  "sourceUrl": "https://bpl.libnet.info/event/3493258"
}
```

正确 Bostwick 场次 3/3 都保留 `2026-10-16 10:30–11:30` 与 `2026-10-21 09:30–10:30`，每条 session 有独立原文。付费对照保留全部必付费用；模型另给出的 $22 是 $20+$2 的算术总和，不是原文逐字价格。

## 最终 Coach：8 轮真实运行，不是模拟回复

每类固定使用提取实验 **repeat=1** 的结果，不挑最好的一次。4 个案例 × 2 组，共 8 个真实生产 Coach runtime/agent/tool/SMS 格式化对话；家人上下文来自临时本地 PGlite，Finder 输出固定为上述实验结果。实验组新增 references/checkedSources/evidence 的展示协议和相应系统说明，允许把未知情况带给家长。输入数据差异与系统协议差异是这次整体方案的一部分，不能当作单一提示词实验。

### 年龄误推，前后实际片段

现有组：

> Their site says you can filter it by the Storytime subject and Ages 2-5, which fits Maya.

实验组：

> I couldn't find any published October 2026 storytime dates, times, ages or prices for London Public Library. I read its What's On page (https://www.lpl.ca/whats-on) and its Eventbrite page (https://www.eventbrite.ca/o/london-public-library-67405991003). Neither showed a preschool storytime listing I could stand behind, so I won't guess at details.

实验组不再把筛选年龄说成适合孩子；给出实际读过的页面。其后续承诺仅为本地生成意图，没有测试实际后续发送。

### 旧课程，改善与残留问题

现有组给出旧目标课程的 caveat 后，另列 Family/Halloween Storytime 并询问是否加日历。实验组不再换成旁栏其他活动，但回复开头为：

> Burlington Public Library does have a Preschool Storytime program, but I couldn't confirm any October 2026 dates.

后半句正确保留了当前场次未确认；前半句 `does have` 仍可被理解为课程当前存在。仅凭历史页不能证明仍开设。**没有将这个回复算作完美事实验收。** 这里暴露的是引用状态不够细：原型把“只有历史证据”和“当前项目存在、排期待公布”都压成了 unconfirmed。落地前需要保留这种通用来源状态，不能靠某个网站的措辞补丁掩盖。

### 正向事实

两组最终回复都保留了 Bostwick 两条正确时间和完整筛选 URL。实验组付费对照实际回复为：

> Leaf Workshop at Example Community Centre is $20 per child plus a mandatory $2 materials fee, so $22 total. The listing says it's for ages 2-5, which fits Maya at 4. The October session is 2026-10-24, 10:00-11:00. The venue's programs page published all of this. It didn't mention any other fees. https://venue.example/programs

这是合成案例，不是真实课程费用。两组 Bostwick 回复都出现了 “Price ... in the result” 一类内部过程旁白，记录为未解决的表达问题，不包装成无误差成品。

## 代价

| 提取指标 | 现有组 | 实验组 |
| --- | --- | --- |
| 逻辑提取 | 15 | 15 |
| 实际模型请求（含重试） | 18 | 16 |
| 正常恢复的截断 | 3 | 1 |
| 最终解析错误 | 0 | 0 |
| 全部提取耗时中位数 | 4.078s | 3.279s |
| 正向案例耗时中位数 | 1.629s | 2.570s |
| 正向案例累计输出 token | 3,057 | 4,373（约 +43%） |
| 全部输出 token | 10,063 | 7,365 |

整体 token 较少，是因为负向案例不再输出多个不相关活动，不能据此宣称证据“没有成本”。正向案例负担明显增加。配对样本很少、有缓存和服务端波动，不是产品首回复 p50/p95 或可靠性统计。

提取 usage 分开保留：现有组 input 87,282 / cache creation input 6,167 / cache read input 49,342；实验组 input 59,378 / cache creation input 7,239 / cache read input 50,680。Coach 额外 22 次请求（8 轮对话，1 次截断正常恢复），无失败。合计本轮 56 次完成请求。这里只报告 usage，不冒充账单金额。

## 进入产品前的边界

1. 区分历史证据、当前项目但日期未知、读取失败等状态，使 Coach 不从历史页推断当前开设；保持原文和 URL 可追溯。
2. 接入时保留现有 access/indoorOutdoor 等元数据、无日期的常规开放时间及其他调用方行为。原型专门验证有日期课程，不是可直接替换全部 Finder 的公共协议。
3. 在独立网页与新鲜完整链路上复测误报和正确结果保留，再跑生产调用方回归；不因本次 9/9 正向成功声称所有活动都不会被误删。

没有改产品代码、模型/生产预算/依赖/数据库结构，没有远程 DB 写入、carrier 发送、push、Slack/Linear 更新或部署。用户已有 Next/dev 修改和 landing 文档未动。

## 复现与证据

以下是实验当时的本地脚本与命令，依赖基线 `03b5d1e53` 的源码结构；当前分支已移动提取 schema，并改变 prompt 切分，付费脚本不能原样当作当前实现的复跑入口。保存的日志仍可只读检查，当前业务结果见[最新实测](vil-423-step3-live-validation-2026-10-16.md)。

只读检查已保存结果，不花 API：

```sh
node .local/vil423-pre-post/evidence-contract-prototype.test.mjs
node .local/vil423-pre-post/step3-evidence-review.mjs
```

第一条检查 14 条机械边界：有效正例、错来源、假引用、年龄/价格缺证据、未知场次保留、旧/范围外/无效日期、无效时间及不修改原始输入。第二条检查本轮观察的具体结果并展示全部 8 条最终回复；这些断言不是通用语义验证器。

实验当时的付费命令：先运行 `node --env-file=launch.env .local/vil423-pre-post/step3-evidence-ab.mjs`，完成后再运行 `node --env-file=launch.env .local/vil423-pre-post/step3-evidence-coach.mjs`。脚本自身输出到 stdout；本轮原始记录另存于下列日志，结果未伪造或覆写为预期值。

本地证据：[实验协议和绑定函数](../.local/vil423-pre-post/evidence-contract-prototype.mjs)、[提取实验](../.local/vil423-pre-post/step3-evidence-ab.mjs)、[30 组原始输出与实际请求](../.local/vil423-pre-post/step3-evidence-ab.log)、[Coach 实验](../.local/vil423-pre-post/step3-evidence-coach.mjs)、[8 轮原始 Coach/tool 记录](../.local/vil423-pre-post/step3-evidence-coach.log)、[审查结果和全部最终回复](../.local/vil423-pre-post/step3-evidence-review.json)。`.local` 文件未跟踪、未推送。
