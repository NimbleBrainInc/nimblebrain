/**
 * A test double for `T` that implements only the members a test exercises.
 *
 * The members given are checked against `T`, so a misspelt name or a wrong
 * signature fails to compile. The members left out are absent at runtime: code
 * under test that reaches one fails with a TypeError, which says the double is
 * missing what the path needs.
 */
export function stub<T>(members: Partial<T>): T {
  // A partial implementation of T, handed to code that asks for the whole T.
  return members as T;
}
