// Globals the web suite sets that no library declares. Read by
// `tsconfig.test.json` only, so shipped code cannot name them.

export {};

declare global {
  /**
   * React's flag for an act-aware test environment. A suite that renders
   * through `act()` sets it to `true`; React reads it off `globalThis`.
   */
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
