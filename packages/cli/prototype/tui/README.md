# CLI terminal UI: a runnable mockup

A mockup of how `npx nimblebrain` could look and feel for a person at a terminal. It
is not wired to the CLI: every step is simulated with timers, nothing is installed,
started or saved, and the model-key prompt discards what you type. It sits outside
`src/`, is not built, published or linted, and exists so the design can be judged
by running it rather than by reading about it. The design is in the issue linked
from the pull request that added this folder.

```bash
node packages/cli/prototype/tui/demo.mjs            # init: the first run
node packages/cli/prototype/tui/demo.mjs up         # also: down, update, uninstall
node packages/cli/prototype/tui/demo.mjs status     # status --stopped for the grey brain
node packages/cli/prototype/tui/demo.mjs doctor     # also: mcp, mcp add, logs, error
node packages/cli/prototype/tui/demo.mjs --still    # any of them without motion
```

Use a truecolor terminal. At 112 columns or wider `init` draws the large mark; narrower
terminals get smaller ones.

## The mark

`mark.json` is the brand mark sampled from `web/src/assets/nb-logo-icon-light.svg`, two
pixels per character cell (`▀`/`▄` with a foreground and background colour), with
coverage kept as alpha. The demo asks the terminal for its background (OSC 11) and
blends edges into it, so circles read as round. Every pixel records which shape it
belongs to (the N, or one of the 26 dots), which is what lets the dots pop in one at
a time and the N draw along its stroke.

Regenerate it after the logo changes (needs ImageMagick):

```bash
node packages/cli/prototype/tui/gen.mjs
```

## The rule it demonstrates

The mark appears only when the install changes state (`init`, `up`, `down`, `update`,
`uninstall`) or is asked for it (`status`, where it is the status light: lit is
running, grey is stopped, and it draws instantly). Prompts, tables and logs stay plain
text. Under `--json`, CI or a non-terminal, the real CLI's output would not change.
