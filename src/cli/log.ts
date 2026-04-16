/**
 * Startup logger — colored stderr output for CLI boot messages.
 *
 * Info messages use dim text, warnings use yellow, errors use red.
 * All output goes to stderr to keep stdout clean for JSON-RPC / pipe output.
 */

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

export const log = {
  info: (msg: string) => console.error(dim(msg)),
  warn: (msg: string) => console.error(yellow(msg)),
  error: (msg: string) => console.error(red(msg)),
};
