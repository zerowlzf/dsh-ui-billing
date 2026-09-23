# Contributing / maintaining this repository

This repository is the **release snapshot** of one DSH Web plugin: `@deepseek-ai/dsh-client-ui-billing`. Its files are a byte-for-byte copy of the package directory `packages/client/ui-billing` in [zerowlzf/deepseek-harness](https://github.com/zerowlzf/deepseek-harness) on the branch `update/0.1.7-alpha.2`, which is a fork of the DeepSeek Harness carrying this plugin alongside the harness it extends. That branch is the one whose baseline this snapshot names: the plugin is built against DSH `0.1.7-alpha.2`.

## Why the code is developed in the fork

The plugin is not standalone software. It imports the harness's own packages (`@deepseek-ai/dsh-client-ui-slots`, `.../ui-primitives`, `.../dsh-settings`, `.../dsh-web`, `.../dsh-token-meter`, …) through the monorepo's TypeScript path map, contributes to slots the harness declares, and is registered by three harness-owned surfaces (the `tsconfig.client.json` aggregate, the `bundle/web-app` plugin row, and that bundle's `package.json`). The harness publishes some of those packages to npm, but not at the version this plugin is built against, so the checkout is the only place where it can be type-checked, tested, and run.

Development therefore happens in the fork. This repository receives the package directory when a release is cut.

## Syncing

```sh
node sync.mjs --into-dsh ~/deepseek-harness   # this repository -> checkout
node sync.mjs --from-dsh ~/deepseek-harness   # checkout -> this repository
node sync.mjs --check    ~/deepseek-harness   # report drift, write nothing
```

Only the package's own paths travel (`src/`, `tests/`, the manifests, the READMEs, `tsdown.config.ts`); `lib/` and `node_modules/` are ignored on both sides and nothing outside `packages/client/ui-billing` is touched. `--check` is what a release is verified with: an empty diff means the tag matches the checkout it came from.

## Gate policy

The plugin is inside the harness's CI gate, which requires **per-file 100%** statements, branches, functions, and lines over `packages/*/*/src`. That is the standard a release tag must meet, along with the harness's documentation gates (`pnpm run doc-sync`), both TypeScript faces, and the linter. Run them in the checkout:

```sh
pnpm run test:gui                                   # the GUI suites
npx vitest run packages/client/ui-billing --coverage \
  --coverage.include='packages/client/ui-billing/src/**/*.{ts,tsx}'
npx tsc -b packages/client/ui-billing/tsconfig.host.json && npx tsc -b tsconfig.client.json
npx tsx scripts/run-oxlint.ts packages/client/ui-billing
pnpm run doc-sync
```

Between releases the bar is a working plugin rather than a red-free CI: the package's own suite, both typecheck faces, and the linter are what a change should pass, and the coverage gate is chased when a release is being cut. Review attention — does the change keep the surfaces consistent, does it reuse what the harness already provides, is the copy localized and the behaviour dated in the README — matters more than the percentage in between.

## Releases

A release is a tag on both repositories, cut from the same content:

1. Sync the package into this repository (`--from-dsh`) and verify with `--check`.
2. Tag this repository `v<version>` and publish a GitHub release whose notes list what the plugin does and what changed.
3. Tag the fork `ui-billing-v<version>` at the commit the snapshot came from.
4. The version is the harness version the plugin is built against (`packages/` in the fork keeps one uniform version), so a release names its DSH baseline rather than a private counter.

## Where the design record lives

The decisions behind the plugin — the plugin's own live configuration fields as the Host's whole surface, the two price windows and where they come from, the folds behind each figure, the published-price read through `ctx.web`, the manual read as a settings write — are recorded in the fork as an Agent Note: [`.agents/notes/implemented/feature/2026-09-13-web-billing-display-over-user-owned-rates.md`](https://github.com/zerowlzf/deepseek-harness/blob/update/0.1.7-alpha.2/.agents/notes/implemented/feature/2026-09-13-web-billing-display-over-user-owned-rates.md). It is kept current with the code and is the first thing to read before changing behaviour.
