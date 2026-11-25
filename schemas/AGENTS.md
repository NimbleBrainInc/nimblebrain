# Published schemas

`schemas/` is exactly the tree `https://schemas.nimblebrain.ai` serves: a file at
`schemas/<path>` is served at `https://schemas.nimblebrain.ai/<path>`, and its `$id` says so.

- **Every file here is authored here or emitted here.** An emitted file has a script that
  writes it and a `--check` mode in `verify:static` that fails on drift; never edit it by hand.
  `contracts/conversations/v1/contract.json` is emitted by
  `contracts/conversations/scripts/emit-contract.ts` (`bun run emit:contracts`,
  `bun run check:contracts`).
  `plugin-extension/v1/plugin-extension.schema.json` (the `ai.nimblebrain` extension of an
  Agent Plugins manifest) is emitted from `src/plugins/extension.ts` by
  `scripts/emit-plugin-extension-schema.ts` (`bun run emit:plugin-extension`,
  `bun run check:plugin-extension`).
- **Paths are `/<thing>/v<major>/`**: `v` plus the major, never the minor. A minor that only
  adds is served in place, at the same path. A breaking change is a new major directory beside
  the old one, which stays served.
- **A file's `$id` is its served URL, stated in the file.** Nothing derives it from another
  name.
- **Runtime code that validates against a published schema reads it from here**, so what is
  checked is what is served.
