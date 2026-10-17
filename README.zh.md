---
description: "Web 计费界面：用户自有的按模型单价、DeepSeek 账户余额，以及建立在其上的会话与本轮费用胶囊；面向费用显示的使用者与维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-billing

[English](README.md) | 中文

## 概述

本包按用户自有的单价，为一次 Web 会话计价。它的 Host 半边把 `ui-billing` 这些字段声明为活字段，并在其中缓存两项来自提供方的读取：DeepSeek 账户余额与公布的价目表。浏览器半边渲染 composer dock 里的两个费用数字、每个已完成轮次操作行里的费用读数，以及 Plugins 页上的「计费」页。一条路由就是一对 `provider/model`，按「元 / 百万 tokens」在最多两个每日时段内计费——缓存命中输入、未命中输入、输出——按高峰单价或公布的空闲一档。余额是 DeepSeek 账户的余额。

## 目录

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

在 Web Chat 界面已存在的前提下挂载本插件；一旦知道某个单价或余额，胶囊就会出现，配置页出现在「插件」页上本包自己那一行。所有界面读取同一个配置值，没有提供配置条目的部署只是什么都不渲染；官方 DeepSeek 路由自带公布价默认值，官方会话开箱即可读出费用。

composer dock 承载本会话费用与余额两个数字，每个已完成轮次在操作行里带上自己的读数并点开明细；完整说明见 [细节文档](docs/README.zh.md)。

<a id="model-experience"></a>
## 模型体验

无：两个半边都只是把人已经由提供方上报的事实渲染并计价，既不注册提示词、工具 schema、模型调用，也不注册会话事件。

#### KV Cache 影响

无；本包从不组装或发出任何提供方请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了当前这份费用显示，是本包当前的约束，而不是一份通用计费比较或任务清单；完整清单与每条的机制见 [细节文档](docs/README.zh.md)。

- **账目不完整的轮次不显示费用** —— 每一轮的持久账目是全有或全无：证据不全的轮次宁可不出数字，也不拿更大的会话数字顶替。
- **尝试全部滑出加载窗口的轮次不显示费用** —— 拆分需要该轮次的助手行；账目点了多条路由又没有一行能落位时，读数不出数字，由对话框点名这些路由，而不是把整份合计在每条路由上各记一遍。
- **会话合计从浏览器首次看到时开始归属** —— 在那之前的一切按当时生效的路由计价，因此会话中途刷新会按那一刻正在使用的路由重读整份总量。
- **官方统计行出现之前不显示任何数字** —— 全新会话要等它的第一轮才显示余额；每轮读数在该轮次收尾时出现。
- **余额始终是 DeepSeek 账户的余额** —— 这是设计使然；Host 的这两次读取就是本包发出的全部请求。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>给维护者的工作上下文——点开查看</summary>

两件值得记着的注册事实：每轮读数是同一对组件在 ui-chat 两张清单上的注册——`conversation.chat.turnEndInfo`（已完成轮次的操作行）与 `conversation.chat.turnTail`（没有操作行的被中断轮次）；页面要求的读取走活字段的写入，而不是调进 Host。[细节文档](docs/README.zh.md#dev-note) 给出完整的维护上下文：节点数据的归属、样式门禁、价格表夹具、翻译类型与覆盖率说明。

</details>

**运行时不变式：** 未发布伴随包。本包两个半边不共享任何进程内状态：Host 半边拥有活字段声明与它的刷新链，浏览器半边拥有四个插槽注册，每一个都由 HMR 安全样张证明可被移除。
