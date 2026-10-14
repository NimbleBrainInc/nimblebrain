/**
 * A response body, typed as what the route returns.
 *
 * `Response.json()` is `Promise<unknown>`, so a test reading a field off it
 * checks nothing at compile time. Naming the type once per read is what lets a
 * renamed field fail the test. A server route's body is its named type in
 * `src/api/schemas/responses.ts` (`ApiErrorBody` for every `apiError`
 * response); never a local interface, and never the web client's copy.
 */
export async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
