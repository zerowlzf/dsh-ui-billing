---
description: "Web billing surface: user-owned per-model token rates, the DeepSeek account balance, and the session and turn cost pills over them; for users and maintainers of the cost display."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-billing

English | [中文](README.zh.md)

## Summary

This package prices a Web session from rates the user owns. Its Host half declares the `ui-billing` fields live and caches two provider reads there: the DeepSeek account balance and the published price table. Its browser half renders two cost figures in the composer's dock, a cost reading in every completed Turn's action row, and the Billing page on the Plugins page. A route is a `provider/model` pair priced per million tokens in up to two daily windows — cached, uncached, and output — at the peak or published off-peak rate. The balance is the DeepSeek account's.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](docs/README.md#understand-the-implementation)
- [Further Exploration](docs/README.md#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Mount this plugin with the Web Chat surfaces present; the pills appear once a rate or a balance is known, and the configuration page appears on this package's own row of the Plugins page. Every surface reads the same configuration value, so a deployment that serves no configuration entry simply renders nothing, and the official DeepSeek routes carry published defaults, so an official session reads a cost out of the box.

The composer dock shows the session total and the balance, and every completed Turn carries its own reading that opens a per-charge breakdown. [the details document](docs/README.md) states the rate model, the editing rules, the two cost folds, and what the package registers.

<a id="model-experience"></a>
## Model Experience

None, as both halves render and price facts the providers already reported for a human, and neither registers a prompt, tool schema, model call, or session event.

#### KV Cache effect

None; the package never assembles or sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define the current cost display. They are current package constraints, not a general billing comparison or a task backlog; [the details document](docs/README.md) states each one in full.

- **A Turn with incomplete accounting shows no cost** — the durable per-Turn accounting is all-or-nothing, so a Turn whose evidence is incomplete renders no figure rather than a wider session number.
- **A Turn whose attempts all aged out of the loaded window shows no cost** — the split needs that Turn's assistant rows, and the dialog names the routes it could not attribute rather than charging the aggregate once per route.
- **The session total is attributed from the browser's first sight** — everything before it is priced under the route active then, so a reload mid-session re-reads the whole total under the route in use at that moment.
- **No figures appear before the shipped stats row does** — a brand-new session shows no balance until its first Turn, and the per-Turn reading appears when that Turn closes.
- **The balance is always the DeepSeek account's** — by design; the two Host reads are the only requests this package makes.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Two registration facts worth keeping in view: the per-Turn reading is one component pair registered on two ui-chat lists — `conversation.chat.turnEndInfo` for the completed Turn's action row, and `conversation.chat.turnTail` for the interrupted Turn that has no row — and a read the Billing page asks for travels as a write to the live fields rather than a call into the Host. [docs/README.md](docs/README.md#dev-note) carries the full working context: node-data placement, the stylesheet gates, the price-table fixture, the translation typing, and the coverage-gate note.

</details>

**Runtime invariant:** No companion is published. The package's two halves own no shared in-process state: the Host half owns the live field declarations and its refresh chain, and the browser half owns four slot registrations, each proven removed by the HMR-safety spec.
