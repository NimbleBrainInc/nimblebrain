/** One line on stderr, stamped, for the person watching the worker. */
export function log(line: string): void {
  process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${line}\n`);
}
