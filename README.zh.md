---
description: "Web 计费界面：用户自有的按模型单价、DeepSeek 账户余额，以及建立在其上的会话与本轮费用胶囊；面向费用显示的使用者与维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-billing

[English](README.md) | 中文

## 概述

本包按用户自有的单价，为一次 Web 会话计价。它的 Host 半边拥有 `ui-billing` settings 命名空间，并在其中缓存两项来自提供方的读取：DeepSeek 账户余额与公布的价目表。浏览器半边渲染 composer 下方的两个费用数字、每个已完成轮次那一行的费用胶囊，以及用于编辑单价的「计费」设置页。一条路由就是一对 `provider/model`，按「元 / 百万 tokens」在一个或两个每日时段内计费——缓存命中输入、未命中输入、输出——分别按高峰单价与公布的空闲一档。余额始终是 DeepSeek 账户的余额。

## 目录

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

在 Web Chat 界面已存在的前提下挂载本插件；一旦知道某个单价或余额，胶囊就会出现，设置页出现在「设置 → 计费」。所有界面读取同一个 settings 值，因此没有 settings provider 的部署只是什么都不渲染。

### 单价

「计费」页列出部署可配置的每个提供方，并为该提供方自身 settings 配置声明的每个模型给出一行。每行携带该 `provider/model` 路由的三个单价，并按价格时段各给一组：

| 单价 | 计入 |
|---|---|
| 缓存命中 | 由提供方缓存提供的提示词 tokens。 |
| 缓存未命中 | 未缓存的提示词 tokens，含缓存写入。 |
| 输出 | 生成的 tokens，含推理 tokens。 |

单价的币种与余额一致，单位为百万 tokens。只有官方 DeepSeek 提供方按时段计价，也只有它的卡片给出第二组字段：高峰一组是这条路由自己的价，空闲一组是它在高峰时段之外的价。其它提供方的卡片只给一组三个字段，因为只公布一个价格的提供方全天同价；这类路由也可以按需加上第二档（「加入空闲时段」）：schema、费用折算与 settings 文档本来就为每条路由都带着第二档，已经存有第二档的路由会直接显示两档。DeepSeek 公布的时段是北京时间周一至周五 9:00–12:00、14:00–18:00，时段外为半价，因此官方卡片会在字段上方说明当前生效的是哪一档。

官方 DeepSeek 提供方的路由自带公布价默认值，因此官方会话开箱即可读出费用：该路由上存过的一行会覆盖一切公布价，走默认值的行会把公布数字显示为输入框的占位符并带一个「默认单价」标记，清除该行即回到公布价。其余没有存量单价的路由不进入任何合计：胶囊显示短横线，对话框点名该路由，而不是显示一个当前配置无法支撑的数字。单价存放在命名空间的 `models` 记录中，键为 `provider/model`，因此手工编辑 settings 文档与页面操作是同一份存储。

Host 会按 `pricingUrl`（默认是官方中文文档页）读取公布价，取页面走的是本部署自己的网页读取能力（`ctx.web`），而不是本包自己发起的请求；没有挂载该能力的部署会记为「没有可读的页面」。公布价很少变动，因此自动读取的间隔很长——默认十五天（`pricingRefreshIntervalMs`；`0` 表示只在启动时读一次、之后不再排期）——而且启动时若存量表格仍在间隔之内就只等待、不再读一次，这正是「重启不产生请求」的原因。页面上的「立即读取」控件随时可以要求读一次，承载这个请求的是 settings 文档：浏览器写入 `officialRequest`，Host 读到后去取页面，并在该次读取结算时清掉这个字段，卡片在此之前一直显示读取中。DeepSeek 没有价格接口——它的 API 提供补全、文件、一份只有 id 的模型列表和余额——因此那张页面表格是价格唯一可机读的表述。读到的表格无法识别、或它陈述的币种与 `currency` 不一致时，都会记成结构化失败：出厂快照继续给官方路由计价，计费页说明发生了什么。

### 单价编辑

保存一行只写入填了数字的字段，其余字段原样不动：留空不是存零的方式，无法解析的文字则什么都不写，绝不会改动用户敲错的那一行背后的数据。把一行的所有字段清空会删除该行，与该行自己的「清除」控件等效；只清空空闲时段的字段则移除那一档，于是「只公布一个价格」的路由仍然是「只公布一个价格」。

### 费用显示

composer 行把本会话费用与余额放进官方轮次/步数胶囊与 token 胶囊自己那一行：`conversation.composer.stats` 是 ui-chat 统计行亲自渲染的一个洞，因此这些数字就是那一行自己的 flex 子项，与官方那组共享同一份居中与同一个 12px 间距，而不是落在它旁边。那一行是**宽度受限**的——680px 封顶时内容盒只有 616px，其中官方两个胶囊、行内三个间距与两个数字合计约占 560px——因此两个数字都是纯金额（`¥16.82` 与 `¥15.96`，用金币与钱包字形区分；算不出时就是一个裸的 `-`）；它们靠无障碍名与 hover 提示说明自己是什么，而不是靠可见文字。会话合计累积 `tokenUsage` 投影——整份持久日志，而不是已加载窗口——按运行总量每次增长时生效的路由计价，这正是让会话中途换模型能被正确切分的原因。

每个已完成的轮次在它自己的操作条里带上费用胶囊，位置在官方「用量」「用时」之后、消息时间之前，经由 `conversation.chat.turn-stats` 这个洞。它显示 `费用 ¥0.42`，点开是该轮次的明细：一行一条路由，总额取自该轮次的持久账目，归属则来自每条已加载尝试**实际被计费的那条路由**。同时产出了文件改动的轮次两行都在：文件行属于操作条上方的 tail 链，费用属于操作条内部的洞，彼此不抢占。有三种情况不带数字，对话框会说明是哪一种：

- 该轮次自身的账目缺失（事件已被分页移出、某次尝试从未结算）——与它自己那个「用量」胶囊的取舍完全一致：会话合计是整场会话的数，绝不拿来顶替某一轮；
- 账目点了多条路由，而这些尝试一条都不在已加载窗口里，拆分无从谈起；对话框会点名这些无法归属的路由，而不是把整份合计在每条路由上各记一遍；
- 它跑过的某条路由没有配单价，对话框会把它标为未定价。

被中断的轮次同样保留这一行：没有收尾消息就没有可复制、可分支的目标，但账目与费用胶囊正是这一行存在的理由。尚未结束的轮次根本没有这一行——官方的收尾节点在该轮次结束时才出现——因此最新一条回答要等那一轮结算后才带上费用。

这里不发起任何模型请求，也不写入任何会话事件：胶囊只是对提供方已经上报的用量做只读投影。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### settings 命名空间

`ui-billing` 保存一个值：

```yaml
models:
  bai/glm-5.3-flash:
    cacheHit: 0.15
    cacheMiss: 4.5
    output: 13.5
  deepseek-official/deepseek-flash:
    cacheHit: 0.04
    cacheMiss: 2
    output: 8
    offPeak:
      cacheHit: 0.02
      cacheMiss: 1
      output: 4
cache:
  total: 12.75
  currency: CNY
  available: true
  at: 1787667264186
cacheError: null
official:
  models:
    deepseek-flash: { cacheHit: 0.04, cacheMiss: 2, output: 8, offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 } }
  currency: CNY
  at: 1787667264186
  source: https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
officialError: null
officialRequest: null
```

`models` 记录是用户配置，Host 只读取它来作答。`cache`、`official`、两个错误字段与 `officialRequest` 属于 Host，各自由对应的刷新链、或由要求读取的那个页面写入。余额一侧：Host 每次读取时解析 API key（先走 `credentials` seam，再走进程环境），对配置的基址调用 `GET /user/balance`，并把结果写回命名空间。`credentials` 是必需注入，因此首次读取会等待凭据文档，而不会把运维者确实存过的 key 报成缺失。余额读取接收一个 key 解析器而不是 context，凭据 seam 因此归插件体所有，读取保持为一次不触碰任何服务的调用；价格读取同样接收一个取页函数，它由可选的 `web` 服务解析而来，解析器因此是对 markup 的纯函数。任一侧读取失败都会保留上一份取值，并记录**结构化原因**——没有 key、HTTP 状态、传输失败、响应无法解析、取页路径截断了正文、部署没有挂载网页读取能力，价格一侧还有「页面按另一种币种计价」——由浏览器用自己的语言陈述，无法翻译的技术细节作为第二句附在后面。两条链各自在结算后按自己的间隔重新排期，并随插件 fiber 一起停止；价格链按存量表格自身的年龄排期，而页面要求的那次读取是替换这个定时器，而不是再加一个。

### 费用折叠

`tokenUsage` 是一个运行总量，两次读取之间的增量恰好就是某条路由被计费的部分，因此会话折叠为每次观察到的增长记录一段，并按各自的路由计价。编辑单价会重算每一段，切换模型会开始新的一段；两者都不会丢失历史。轮次折叠从持久的 turn-tail 账目出发——与官方「本轮用量」对话框所显示的同一份证据——按每条已加载尝试被计费的那条路由归属；剩余部分（被重试的尝试，或消息已离开窗口的尝试）按最后一条路由的单价计入，使计价总额与提供方上报的 tokens 一致。账目已不在已加载窗口内的轮次不显示数字；绝不用会话投影顶替，因为把整场会话的数读成某一轮的费用本身就是错的。

两个折叠还会按每一段**发生时所处的价格时段**计费。会话折叠给每次观察到的增长打上观察时刻，也就是提供方在这些 tokens 产生时正在计价的时段；轮次折叠给每条尝试打上它自己那条结算消息所带的时间，而没有时间的尝试根本不算证据。只公布一个价格的路由不按时段拆分，因为两档的数字本来相同。

### 注册

三个界面，卸载时各自还原：`settings.section`（计费页）、`conversation.composer.stats`（官方 composer 统计行内部的两个数字），以及 `conversation.chat.turn-stats`（已完成轮次自己的操作条里的每轮费用胶囊）。两个数字洞都是由宿主行亲自渲染的 list 槽；行的拥有者事实以**摊平**方式到达条目，因此轮次胶囊直接读 `turn`，与官方交付文件条目直接读 `openFile` 是同一种读法。组件一律按槽的**四份份额**声明 props——`PropsRuntime`（拥有者份额与会话座位）、本插件面的 `InjectFace`、以及 `PropsLocale`——绝不手写成员清单。

计费页为「用户层确实配置过」「适配器当前已注册」或「部署层 profile 里带模型」（官方提供方就是这一类）的提供方各给一张卡片；三者都不占的目录条目没有可定价的东西，就不列出。每张卡片的模型来自那份 profile，模型列表收在该卡片自己的编辑控件之后；任何被某条已存单价行或本页刚输入的路由点名的提供方同样保留卡片，因此提供方消失的路由仍然可编辑、可清除。

所有 ctx 读取都归 apply 闭包：组件拿到的是命名空间快照的 `useBilling` 选择器钩子、已加载提供方分组的 `useBillingGroups` 钩子，以及 `routeGroups`、`saveRate`、`clearRate` 三个普通回调。目录自身的失效信号（`llm/adapters-updated`、`connection/reset`）在插件里订阅，分组列表是一个可观察 store；因此组件既不持有任何订阅装置，也不会去够 ctx。

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

当这些显示不够用时，读这些页面。它们从浏览器界面走向它所读取的测量与 settings 传输。

- [dsh-token-meter](../../llm/token-meter/README.zh.md) — 本包所累积的 `tokenUsage` 投影。
- [dsh-settings](../../settings/settings/README.zh.md) — Host 半边注册、浏览器半边编辑的命名空间 seam。
- [dsh-web](../../web/web/README.zh.md) — Host 读取公布价页面所用的网页读取能力。
- [ui-settings](../ui-settings/README.zh.md) — 设置外壳，以及本页绑定的命名空间 scope。
- [ui-chat](../ui-chat/README.zh.md) — 本包所扩展的胶囊、对话框与 turn-tail 链。

-----

<a id="model-experience"></a>
## Model Experience

None, as both halves render and price facts the providers already reported for a human, and neither registers a prompt, tool schema, model call, or session event.

#### KV Cache effect

None; the package never assembles or sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the current cost display. They are current package constraints, not a general billing comparison or a task backlog.

- **A Turn with incomplete accounting shows no cost** — the durable per-Turn accounting is all-or-nothing, so a Turn whose evidence is incomplete (its events paged out, an attempt that never settled) renders no figure rather than a wider session number. An old Turn can therefore read as costless while its answer is still on screen, which is the same abstention the shipped Turn-usage pill makes beside it.
- **A Turn that ran on several routes without a loaded attempt shows no cost** — attribution needs the route each attempt was billed on, so a Turn whose attempts all left the window cannot be split; the pill withholds the figure and the dialog names the routes. One named route is still priced, because every attempt ran there.
- **A retried attempt is charged at the route of the attempt the window kept** — the turn fold reads route attribution from the loaded window, so a Turn that retried on another route is charged for the attempts that survived there, with any remainder at the last of them. The priced total stays equal to the tokens the provider reported; the split between two routes of one retried Turn is approximate.
- **The session total is attributed from the browser's first sight** — the running total a page first observes is priced under the route active then, because the routes of everything before it are not in the evidence a browser can read; only later growth is split per route. A reload mid-session therefore re-reads the whole total under the route in use at that moment.
- **No figures appear before the shipped row does** — both composer figures ride ui-chat's stats row, which renders once the session has a step or billed tokens, so a brand-new session shows no balance until its first Turn. The per-Turn figure appears when that Turn closes, since the row itself is the shipped tail node's.
- **Cache writes are charged as uncached input** — the three configured rates match how the DeepSeek adapters report usage, where a cache write arrives as prompt input. A provider that reports writes in their own bucket is charged that bucket's tokens at its cache-miss rate.
- **跨越价格边界的一段只按一档计费** — 证据是这一段自己的时刻，而不是逐 token 的时间戳：会话折叠取观察时刻，轮次折叠取尝试结算的时刻。因此只有尝试分别落在边界两侧时，跨过北京时间 12:00 或 18:00 的轮次才会被拆开，而一次跨越边界的长尝试按它结束时生效的那一档计费。
- **公布价来自一张文档页面** — DeepSeek 没有价格接口，Host 解析的是 `pricingUrl` 上的表格；该读取失败或页面改版时，给官方路由计价的仍是出厂快照。提供方自上次成功读取后调整的价格，要等下一次自动读取才会进入会话，最多相隔 `pricingRefreshIntervalMs`，或由页面上的「立即读取」立刻取回。
- **按另一种币种计价的页面会被拒绝** — 表格只陈述一种币种的数字；当它与本文档计价所用币种不一致时，该次读取被丢弃并记录具名原因，因为混用会让每条官方路由都按汇率错价。改 `currency` 时请把 `pricingUrl` 指向相应语言的版本。
- **只填了部分字段的路由，其余字段按 0 计费** — 留空的字段从不写入，因此手工填写时只给了一个数字、其余留空的行，其余字段取 schema 的 0。请把这条路由实际计费的数字都填上，或清除该行回落到公布价。
- **The balance is always the DeepSeek account's** — by design: the page compares spend against the one account the API can report. A deployment whose sessions never use the official provider still shows this balance, and the Host read is the only request this package makes.

<a id="dev-note"></a>
### 开发备注

<details>
<summary>Working context for maintainers — click to expand</summary>

- The per-turn node data lives only in the materialized Chat node store, not in the legacy compatibility slice the shipped stats row reads.
- ui-chat's completed-Turn extension above the action row is a chain that elects one entry, so a contribution there is dropped for every Turn the shipped produced-files entry claims; the cost figure lives in the row's own list hole (`conversation.chat.turn-stats`) instead. The per-attempt node kind is `assistant-step`, and its `finalNode.provenance` and `finalNode.time` are the route and the moment that attempt was billed on.
- 价格表夹具就是线上文档页实际提供的那张表格，逐字录下，因此 `parsePricePage` 是针对它真正会遇到的行合并、脚注标记与单位后缀来规定的。默认用中文版，因为它陈述的币种就是本包默认币种；英文版在样张里充当「币种不符被拒」的用例。
- `BillingTranslate` 保持本地声明，而 props 从 `PropsLocale` 派生：框架在合并后的 `LocaleNamespaceMap` 上给出的座位同时接受本字典的键与共享的通用键，它可以赋给更窄的本地别名，反向则不行。一包两 face 的布局让 `src/settings.ts` 在两个 leaf 中都参与编译——Client leaf 把它列进 `include`——因为 Client 配置不允许进入 split 项目的 Host leaf。
- settings 命名空间（`ui-billing`）与文案字典（`billing`）分开命名：两者共用一个标识符会把 scope 绑到字典上，于是 Host 明明在提供正确取值，而每个界面都渲染自己的「不可用」状态。
- 本包处在逐文件 100% 覆盖率门内，只有一条分支带 `/* v8 ignore */`：轮次折叠里「最后一行存在」的判空——上面的循环为每条尝试都加了一行，而没有尝试的轮次在到达该处之前就已返回。
- 页面要求的这次读取走 settings 写入，而不是调进 Host：浏览器自己读不了那张文档页（该来源不为它下发许可），本包也没有可调用的 Remote 命名空间，于是命名空间里的 `officialRequest` 字段就是两端共用的那条通道。客户端写下它请求的时刻，Host 监听命名空间、去取页面，并在该次读取结算时清掉字段。这个字段「不存在」与「为 null」对每个读取方都是同一件事，因为命名空间 schema 里的联合类型两者都不会写进存量文档。

</details>

**Runtime invariant:** No companion is published. The package's two halves own no shared in-process state: the Host half owns the settings namespace registration and its refresh chain, and the browser half owns three slot registrations, each proven removed by the HMR-safety spec.
