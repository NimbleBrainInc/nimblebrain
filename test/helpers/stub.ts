/**
 * A test double for `T` that implements only the members a test exercises.
 *
 * Each member the argument shares with `T` is checked against it, so a wrong
 * signature fails to compile. An object literal is also checked for names `T`
 * lacks, so a misspelt member fails too; a class instance passed whole is not,
 * and a misspelt method on it reads as missing. The members left out are absent
 * at runtime: code under test that reaches one fails with a TypeError, which
 * says the double is missing what the path needs.
 */
export function stub<T>(members: Partial<T>): T {
  // A partial implementation of T, handed to code that asks for the whole T.
  return members as T;
}
