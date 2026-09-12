---
description: "Web billing surface: user-owned per-model token rates, the DeepSeek account balance, and the session and turn cost pills over them; for users and maintainers of the cost display."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-billing

English | [中文](README.zh.md)

## Summary

This package prices a Web session from rates the user owns. Its Host half owns the `ui-billing` settings namespace and caches two provider reads: the DeepSeek account balance and the published price table. Its browser half renders two cost figures under the composer, a cost pill in every completed Turn's row, and the Billing settings page that edits the rates. A route is a `provider/model` pair priced per million tokens in one or two daily windows — cached input, uncached input, output — at the peak rates and at a published off-peak band. The balance is always the DeepSeek account's.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin with the Web Chat surfaces present; the pills appear once a rate or a balance is known, and the settings page appears under Settings → Billing. Every surface reads the same settings value, so a deployment without a settings provider simply renders nothing.

### Rates

The Billing page lists every provider the deployment can configure, with one row per model that provider's own settings profile declares. Each row carries the three rates for that `provider/model` route, once per price window:

| Rate | Charges |
|---|---|
| Cache hit | Prompt tokens served from the provider's cache. |
| Cache miss | Uncached prompt tokens, including cache writes. |
| Output | Generated tokens, reasoning tokens included. |

Rates are in the currency the balance reports, per million tokens. Only the official DeepSeek provider bills by time of day, and only its cards offer a second band of fields: the peak row is the route's own price, and the off-peak row is what that route charges outside its peak window. Every other provider's card carries the three fields once, because a provider that publishes one price charges it at every hour, and any such route can be given a second band on request (`Add off-peak rate`): the schema, the folds, and the settings document carry one for every route, and a route that already holds one shows both. DeepSeek states its window as Beijing time Monday–Friday 09:00–12:00 and 14:00–18:00 at half price outside it, so the official card names the window in force above its rows.

The official DeepSeek provider's routes carry published defaults, so an official session reads a cost out of the box: a stored row for that route overrides everything published, an eligible row shows the published figure as its field placeholder and a `default rate` badge, and clearing the row returns the route to it. Every other route with no stored rates contributes to no total: the pills show a dash and the dialog names the route, rather than showing a number the configuration cannot support. Rates are stored in the namespace's `models` record under the key `provider/model`, so a hand edit of the settings document and the page are the same storage.

The Host refreshes the published figures from the provider's price page (`pricingUrl`, the Chinese documentation page by default), retrieving it through the deployment's own web capability (`ctx.web`) rather than a request of this package's own; a deployment that mounts no such capability records that it had no page to read. A published price list moves rarely, so the automatic read is long-spaced — fifteen days by default (`pricingRefreshIntervalMs`; `0` reads once at startup and schedules nothing) — and a start whose stored table is still inside that interval waits instead of reading again, which is what makes a restart cost no request. The page's own `Read now` control asks for one at any time, and it is the settings document that carries the request: the browser writes `officialRequest`, the Host reads the page and clears the field when that read settles, and the card shows it in flight until then. DeepSeek serves no price endpoint — its API answers completions, files, a model list of ids, and the balance — so the page's table is the only machine-readable statement of the prices. A read whose table cannot be recognized, or that states its figures in another currency than `currency`, is recorded as a structured failure: the shipped snapshot keeps pricing the official routes, and the Billing page says what happened.

### Rate editing

Saving a row writes the fields that hold a figure and leaves the rest of the document alone: an empty field is not a way to store a zero, and text that does not parse writes nothing at all rather than changing a row the user mistyped. Emptying every field of a row removes it, which is also what the row's own Clear control does. Emptying only the off-peak fields removes that band, so a route with one price stays a route with one price.

### Cost display

The composer row carries a session-cost figure and a balance figure inside the shipped turn/step and token pills' own line: `conversation.composer.stats` is a hole that ui-chat's stats row renders itself, so these figures are that row's own flex items and share the shipped group's centring and its 12px gap instead of landing beside it. That line is width-bound — at the 680px clamp its content box holds 616px, of which the two shipped pills, the row's three gaps, and both figures spend about 560 — so both figures are bare amounts (`¥16.82` and `¥15.96`, distinguished by the coin and wallet glyphs, and a bare `-` while one is unknown); each one states what it is through its accessible name and hover title rather than through visible words. The session total accumulates the `tokenUsage` projection — the whole durable log, not the loaded window — by pricing each growth of the running total at the route active when it grew, which is what keeps a mid-session model switch correctly split.

Each completed Turn carries its own cost pill in its action row, after the shipped 用量 and 用时 pills and before the message clock, through the `conversation.chat.turn-stats` hole. It shows `费用 ¥0.42` and opens that Turn's breakdown: one row per route, priced from the Turn's durable accounting and attributed by the route each loaded attempt was billed on. A Turn that also produced files shows both rows: the file row is the tail chain's own line above the action row, and the figures are a hole inside the row, so neither displaces the other. Three cases carry no figure, and the dialog says which one applies:

- the Turn's own accounting is absent (its events paged out, an attempt that never settled), exactly as its own 用量 pill shows nothing then — the session total is a session-wide number and never stands in for one Turn;
- its accounting names several routes and none of those attempts is still loaded, so the split cannot be made; the dialog names the routes it could not attribute rather than charging the whole aggregate once per route;
- a route it ran on has no configured rates, which the dialog names as unpriced.

An interrupted Turn keeps the row too: no closing message means no copy or branch target, but the accounting and the cost pill are what that row is for. A Turn that has not ended yet has no row — the shipped tail node appears when the Turn closes — so the newest answer carries its cost only once that Turn settles.

Nothing here issues a model request or writes a session event: the pills are a read-only projection of usage the providers already reported.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### The settings namespace

`ui-billing` holds one value:

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

`models` is user configuration and the Host only reads it. `cache`, `official`, their two error fields, and `officialRequest` are Host-owned, and each is written by its own refresh chain or by the page that asks for a read. For the balance the Host resolves the API key per read (the `credentials` seam first, then the process environment), calls `GET /user/balance` on the configured base URL, and writes the answer back. The `credentials` service is a required injection, so the first read waits for the credential document instead of reporting a key the operator did store as missing. The balance read takes a key resolver rather than the context, so the plugin body owns the credential seam and the read stays one call that reaches no service; the price read takes the page fetcher the same way, resolved from the optional `web` service, so the parser is a pure function over markup. A failed read of either kind keeps the previous value and records a structured reason — no key, an HTTP status, a transport failure, an unreadable payload, a body the retrieval path capped, no mounted web capability, and for prices a currency the document does not price in — which the browser states in its own language, with the untranslatable detail appended as a second clause. Each chain re-arms itself after its own settlement, on its own configured interval, and stops with the plugin fiber; the price chain is armed from the stored table's own age, and a read the page asked for replaces that timer rather than adding a second one.

### Cost folds

`tokenUsage` is a running total whose growth between two reads is exactly what one route was billed, so the session fold records one stretch per observed growth and prices each under its own route. Editing a rate reprices every stretch, and switching models starts a new stretch; neither loses history. The turn fold starts from the durable turn-tail accounting — the same evidence the shipped Turn-usage dialog shows — and attributes it across the routes its loaded attempts were billed on, charging any remainder (a retried attempt, or one whose message left the window) at the last route's rate so the priced total matches the tokens the provider reported. A turn whose accounting the loaded window lost carries no figure; the session projection is never substituted for it, because a session-wide total read as one turn's cost is simply wrong.

Both folds also charge each stretch in the price window it happened in. The session fold stamps every observed growth with the clock at the moment it was observed, which is the window the provider was pricing while those tokens were produced; the turn fold stamps each attempt with the time its own settled message carries, and an attempt without one is not evidence at all. A route that publishes a single price is not split by window, because both bands hold the same figures.

### Registration

Three surfaces, each restored on unload: `settings.section` (the Billing page), `conversation.composer.stats` (the two figures inside the shipped composer stats row), and `conversation.chat.turn-stats` (the per-Turn cost pill inside the completed Turn's own action row). Both figure holes are list slots the owning row renders itself, and a row's owner share reaches an entry spread flat onto its props, so the Turn pill reads `turn` directly, the way the shipped produced-files entry reads `openFile`. Components type their props as the slot's four shares — `PropsRuntime` (owner share and session seats), `InjectFace` over this plugin's face, and `PropsLocale` — never as a hand-written list of members.

The settings page lists one card per provider whose profile the user layer configures, whose adapter is currently registered, or whose deployment-level profile carries models (the shipped official provider is one); a catalogue entry with none of those carries nothing to price and is left out. Each card's models come from that profile, and any route a stored rate row or a typed input names keeps its card, so a route whose provider disappeared stays editable and clearable.

The apply closure owns every ctx read. Components receive a `useBilling` selector hook over the namespace snapshot, a `useBillingGroups` hook over the loaded provider groups, and three plain callbacks: `routeGroups`, `saveRate`, and `clearRate`. The directory's own invalidations (`llm/adapters-updated`, `connection/reset`) are subscribed in the plugin, and the group list is one observable store, so a component holds no subscription machinery and never reaches for the context.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the displays are not enough. They move from the browser surfaces to the measurement and the settings transport they read.

- [dsh-token-meter](../../llm/token-meter/README.md) — the `tokenUsage` projection this package accumulates.
- [dsh-settings](../../settings/settings/README.md) — the namespace seam the Host half registers and the browser edits.
- [dsh-web](../../web/web/README.md) — the web capability the Host reads the published price page through.
- [ui-settings](../ui-settings/README.md) — the settings shell and the namespace scope the page binds.
- [ui-chat](../ui-chat/README.md) — the pills, dialogs, and turn-tail chain this package extends.

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
- **A stretch that crosses a price boundary is charged at one band** — the evidence is a stretch's own moment, not a per-token timestamp: the session fold takes the moment it observed the growth and the turn fold the moment an attempt settled. A Turn that spans 12:00 or 18:00 Beijing time is therefore split only when its attempts fall on either side of the boundary, and a long single attempt is charged at the band in force when it ended.
- **The published figures come from a documentation page** — DeepSeek serves no price endpoint, so the Host parses the table on `pricingUrl`, and the shipped snapshot is what prices the official routes whenever that read fails or the page is redesigned. Prices the provider changed since the last successful read reach a session at the next automatic read, which is up to `pricingRefreshIntervalMs` away, or immediately through the page's own `Read now` control.
- **A price page in another currency is refused** — the table states its figures in one currency, and the read is dropped with a named reason when it is not the one this document prices in, because mixing them would misprice every official route by the exchange rate. Point `pricingUrl` at the matching edition when changing `currency`.
- **A route with only some fields filled is billed zero on the rest** — an empty field is never written, so a hand-typed row that names one figure and leaves the others empty carries the schema's zeros for them. Enter the figures a route actually bills, or clear the row to fall back on the published price.
- **The balance is always the DeepSeek account's** — by design: the page compares spend against the one account the API can report. A deployment whose sessions never use the official provider still shows this balance, and the two Host reads are the only requests this package makes.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

- The per-turn node data lives only in the materialized Chat node store, not in the legacy compatibility slice the shipped stats row reads.
- ui-chat's completed-Turn extension above the action row is a chain that elects one entry, so a contribution there is dropped for every Turn the shipped produced-files entry claims; the cost figure lives in the row's own list hole (`conversation.chat.turn-stats`) instead. The per-attempt node kind is `assistant-step`, and its `finalNode.provenance` and `finalNode.time` are the route and the moment that attempt was billed on.
- The price-table fixture is the table the live documentation pages served, recorded verbatim, so `parsePricePage` is specified against the row spans, footnote markers, and unit suffixes it will actually meet. The Chinese edition is the default because it states its figures in the package's default currency; the English one is in the spec as the refused-currency case.
- `BillingTranslate` stays declared locally while the props derive from `PropsLocale`: the framework's seat over a merged `LocaleNamespaceMap` accepts this dictionary's keys plus the shared common ones, which is assignable to the narrower local alias but not the reverse. The two-faces-in-one-package layout compiles `src/settings.ts` in both leaves — the Client leaf lists it in `include` — because a Client config may not enter a split project's Host leaf.
- The settings namespace (`ui-billing`) and the copy dictionary (`billing`) stay separately named: one identifier for both binds the scope to the dictionary, so every surface renders its unavailable state while the Host serves correct values.
- The package is inside the per-file 100% coverage gate, and one arm carries a `/* v8 ignore */`: the turn fold's last-row guard, whose row every attempt above added, with a turn that has no attempt returning before it.
- A read the page asks for travels as a settings write rather than a call into the Host: the browser cannot read the documentation page itself (its origin sends no grant for one) and this package owns no Remote namespace to call, so the namespace's `officialRequest` field is the channel both halves share. The client writes the moment it asked, the Host watches the namespace, reads the page, and clears the field with that read's own settlement. The field being absent and being null are the same thing to every reader, because a union in the namespace schema resolves neither into the stored document.

</details>

**Runtime invariant:** No companion is published. The package's two halves own no shared in-process state: the Host half owns the settings namespace registration and its refresh chain, and the browser half owns three slot registrations, each proven removed by the HMR-safety spec.
