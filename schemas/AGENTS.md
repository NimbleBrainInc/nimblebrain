# schemas/

`schemas/` is exactly the tree served at `https://schemas.nimblebrain.ai`: a file at `schemas/<path>` is served at `/<path>`. `.github/workflows/schema-deploy.yml` publishes every file here on push to `main` (the guide files, `*.md`, excepted), so editing a file ships it.

- **Each file is authored here or emitted here by a script.** An emitted file is never edited by hand; its generator has a check (a `--check` mode or a drift test) that fails when the committed file differs from what the source builds.
- **Paths are `/<thing>/v<major>/<file>`**: `v` plus the major, after the thing (`config/v1/config.schema.json`).
- **A minor that only adds is served in place.** New optional fields go into the existing `v<major>/` file; its cache is short and revalidating, so readers pick it up. A breaking change (a removed, renamed, or newly required field, or a narrowed type) is a new major directory, `v<major+1>/`, and the old one stays served.
- **Runtime code that validates against a published schema reads it from here**, never from a copy elsewhere in the repo.
- **Legacy `/v1/<name>` keys are served as aliases by the deploy.** Configs and manifests written before this layout point at them, so the workflow's `LEGACY_ALIASES` copies each one from its file here. Never remove an alias.
- **A new top-level directory needs the deploy role granted write on its prefix** (an infra change outside this repo) before it merges, or its upload is refused.

| File | What it is | Source |
|---|---|---|
| `config/v1/config.schema.json` | The `nimblebrain.json` config schema. The runtime validates against it at startup (`SCHEMA_PATH` in `src/config/index.ts`). | Authored here. In lockstep with `src/config/features.ts`; `test/unit/config-schema-drift.test.ts` fails on drift. |
| `host/v1/host.schema.json` | The `ai.nimblebrain/host` `_meta` extension: how an MCP server declares its UI placement in the host shell. **Published-only**: nothing validates against it, because the runtime reads that block from a catalog entry it already trusts. Fields are camelCase, the only spelling read; `src/connectors/catalog/host-meta.ts` is the one reader of the raw block, and a block carrying `admin_tools` gates every tool. | Authored here. `test/unit/host-manifest-schema-drift.test.ts` holds it in step with `HostManifestMeta` (`src/connectors/runtime/types.ts`) and `HookDeclaration`; change them together. |
| `host-bridge/v1/constants.json` | The app bridge's identifiers and limits, which an SDK holding copies of them (`@nimblebrain/synapse`) tests against. Plain JSON, not a JSON Schema. A contract: add fields freely, bump `version` to rename or remove one. | Emitted by `bun run gen:host-constants` from `web/src/bridge/host-constants.ts`; `test/unit/bridge/host-constants.test.ts` fails on drift. |
