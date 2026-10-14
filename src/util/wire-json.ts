/**
 * A value as it travels over JSON-RPC: own enumerable string keys, JSON values
 * only. TypeBox schemas carry symbol-keyed metadata (`[Kind]`, `[Hint]`) that a
 * JSON encoder drops anyway, but the MCP SDK validates a result against its
 * JSON types before encoding it and refuses a symbol key. A tool schema built
 * with TypeBox goes through here before it reaches a `tools/list` result.
 */
export function toWireJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
