# VIL-423 第三步：事实错误定位

日期：2026-10-15。产品代码：`03b5d1e53`。本轮只诊断，没有修改产品逻辑。

## 结论

问题集中在 **Finder 解析时没有可靠区分“目标活动的证据”和“同一网页的导航、筛选器、其他活动”**。字段格式正确、URL 确实读过，不代表这些事实属于同一个活动。

本轮用当前 `claude-sonnet-5-5`、当前提取 prompt、实际生产 JSON Schema / Zod 校验 / `toPicks`，做了 **5 类 × 3 次 = 15 次定向测试**。其中三类使用此前真实官网读取的原文，两类是明确标注的合成边界对照。没有重新搜索或抓取官网，也没有新跑最终 Coach。

| 测试 | 实际结果 | 判断 |
| --- | --- | --- |
| London 通用列表，年龄只出现在筛选器 | 2/3 次把 `Ages 2-5` 填成 Storytimes 的 `age_fit`；1/3 次不返回活动 | 年龄证据归属错误复现 |
| Burlington 2020 年 Preschool Storytime 旧详情页 | 3/3 次保留旧目标活动，并加入旁栏的 Family/Music/PJ Storytime 等其他活动 | 没有收敛为目标活动在指定月份的有效场次；都有旧日期 caveat，不能说成“伪造 2026 日期” |
| London Bostwick 同一活动两个日期、不同时间 | 3/3 次正确保留 Oct 16 10:30–11:30、Oct 21 09:30–10:30 | 本轮没有复现时间混用 |
| 合成：同一活动含 2020-10、2026-10、2026-11 三个场次 | 3/3 次只选 2026-10-24 10:00–11:00 | 简单明确输入的月份筛选正确，不代表复杂网页已有确定性过滤 |
| 合成：2–5 岁付费活动，旁边是 8–12 岁免费活动 | 3/3 次保留目标活动的 $20/child + mandatory $2 materials fee，没有串入 Chess/Free | 本轮价格和年龄正向对照通过 |

不把“保留旧活动但明确说明没有当前场次”和“把旧日期冒充当前日期”混为一谈；本轮观察到的是前者。诊断脚本对旧活动案例采用目标活动/指定月份的严格候选要求，其非空标记不是可泛化到所有未知排期场馆的生产规则。

## 1. 年龄错误：先出在 Finder，Coach 随后放大

真实页面原文包含：

```text
Filter by Audience - Any - Babies Ages 2-5 Ages 6-12 Teens Adults Older Adults Newcomers
```

没有对应的学龄前 Storytime 场次。新模型调用仍输出：

```json
{
  "name": "Storytimes, London Public Library",
  "age_fit": "Ages 2-5 (the audience filter on the What's On page)",
  "source_url": "https://www.lpl.ca/whats-on"
}
```

另一次甚至在 `age_fit` 内说明 “the page does not state an age for storytimes specifically”，但仍填入 Ages 2-5。也就是说模型看到了证据缺口，却仍拼成了一个满足字段要求的 pick。

上轮实际完整 Coach 测试已经显示后续放大：

> London Public Library's What's On page has a Storytimes listing with an ages 2-5 filter, which fits Maya.

因此不是最终 SMS 格式化凭空创造年龄，而是 Finder 已提供错误关联，Coach 又据此作出适合孩子的判断。本轮没有重新购买这条 Coach 生成。

## 2. 旧活动与旁栏：读取成功，但目标活动范围被冲淡

真实旧页面主内容：

```text
Preschool Storytime 2020-01-22 10:00:00 2020-01-22 10:30:00 ...
For kids ages 3-5 capable of sitting on their own.
```

同一页下方还带有很多其他活动的近期列表。提问条件明确为 Burlington Public Library Preschool Storytime / October 2026，输出仍包括：

> The only dated session on the cited page is Wednesday, January 22 (2020), 10:00am - 10:30am; no October 2026 session of this program is posted there.

以及同页旁栏的 Family Storytime、Music & Rhythm Storytime 或 PJ Storytime。它们没有被谎称是同名 Preschool Storytime，但仍作为本次目标活动查询的 picks 返回。部分其他活动的 `age_fit` 也承认没有具体年龄范围。

所以直接观察是：旧场次仍占候选位，目标查询混入其他活动；不是本轮已经证明旧场次会被最终 Coach 当作当前报名日期发送。

## 3. 代码为什么没拦住

- [页面处理](../apps/web/lib/channel/activity/lane.ts#L542)：HTML 去标签后取前 20,000 字符；导航、筛选器、主活动和旁栏仍在同一段文本中。页面级地点验证不验证每个活动。
- [字段转换](../apps/web/lib/channel/activity/lane.ts#L428)：`name` / `age_fit` / `source_name` 非空即可继续；没有在这里核对年龄原文是否属于该活动，也没有按请求月份/当前日期过滤。机械探针把 `event_date: 2020-10-24` 交给实际 `toPicks`，旧日期原样保留。这是转换层探针，不是一次完整 Finder/Coach 测试。
- [来源检查](../apps/web/lib/channel/activity/lane.ts#L586)：只保证来源 URL 属于刚读取过的页面集合，不保证活动名称、日期、时间、年龄在该页面上彼此对应。
- [现有 prompt](../packages/agent/skills/activity-finder.md#L118) 强调真实项目缺日期/价格也应保留。它可能与必填年龄字段一起促进“先填出一个 pick”，但没有做 prompt A/B，不能断言某一句是唯一原因。

因此 JSON Schema 已约束输出结构，但没有验证活动事实之间的关系。不是数据库旧日期回退，也不是第二步的地点/月分/机构/链接再次丢失。

## 调用与证据

15 次逻辑测试，18 次真实请求；3 次 `max_tokens` 被生产结构化输出层的正常重试恢复，最终解析错误 0。用量分别为：input 86,553；output 10,780；cache creation input 18,501；cache read input 37,008。仅记录 usage，不冒充账单费用。

[诊断脚本与全部输入](../.local/vil423-pre-post/step3-facts-diagnostic.mjs)、[原始输出、生产转换结果与 token 用量](../.local/vil423-pre-post/step3-facts-diagnostic.log)、[上一轮真实 Coach 回复](vil-423-step2-live-validation.md)。本地 `.local` 文件未跟踪、未推送。

复现命令（会产生新的 API 费用和样本，不是只读回放）：

此命令对应诊断时的 `03b5d1e53` 基线；当前分支已迁移 schema，需先适配本地脚本，不能原样视为当前实现的验证入口。

```sh
node --env-file=launch.env .local/vil423-pre-post/step3-facts-diagnostic.mjs
```

下一步最小修复应针对目标活动的证据归属和旧场次候选过滤；不据本轮结果重做搜索架构，不因三个对照通过而声称时间/价格永不出错。

未验证：新官网变化、新最终 Coach 生成、cron、真实短信和部署。没有修复、push、远程 DB 操作或 Slack/Linear 更新。
