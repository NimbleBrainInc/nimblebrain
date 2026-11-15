# NimbleBrain Docs

[![Deploy Docs](https://github.com/NimbleBrainInc/nimblebrain/actions/workflows/docs-pages.yml/badge.svg)](https://github.com/NimbleBrainInc/nimblebrain/actions/workflows/docs-pages.yml)
[![License: CC BY 4.0](https://img.shields.io/badge/License-CC%20BY%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by/4.0/)
[![Built with Starlight](https://astro.badg.es/v2/built-with-starlight/tiny.svg)](https://starlight.astro.build)

Documentation site for [NimbleBrain](https://nimblebrain.ai) — the composable MCP orchestrator and app host.

**[docs.nimblebrain.ai](https://docs.nimblebrain.ai)**

## Local Development

Prerequisites: [Bun](https://bun.sh), and [uv](https://docs.astral.sh/uv/) for the Server SDK pages.

```bash
bun install
bun run dev       # Start dev server at localhost:4321
bun run build     # Production build to dist/
bun run preview   # Preview the production build
```

`dev` and `build` first run `bun run reference`, which writes the Server SDK API reference
(`src/content/docs/server-sdk/reference/`, not in git) from the docstrings in
`../packages/server-sdk-py`. The Server SDK guides import their code from that package's
`examples/`, which its test suite runs, so edit an example there, not in a page.

## Deployment

Pushes to `main` automatically deploy to GitHub Pages via the [deploy workflow](.github/workflows/deploy.yml).

## License

Content is licensed under [CC BY 4.0](LICENSE).
