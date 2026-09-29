/**
 * A response body, typed as what the route returns.
 *
 * `Response.json()` is `Promise<unknown>`, so a test reading a field off it
 * checks nothing at compile time. Naming the type once per read is what lets a
 * renamed field fail the test. Use the server's own type where one exists
 * (`ChatResult`, `ApiErrorBody` for every `apiError` response, the web client's
 * response types such as `ShellData`); where none does, a local interface that
 * names only the fields the test reads.
 */
export async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
