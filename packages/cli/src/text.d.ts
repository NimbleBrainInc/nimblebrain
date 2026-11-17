// A file imported `with { type: "text" }` (bundled by `bun build`) is its contents as a string.
declare module "*.yml" {
  const text: string;
  export default text;
}
