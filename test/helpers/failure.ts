/** Run `fn` and return whatever it throws. Fails if it does not throw. */
export function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected the call to throw, but it did not");
}

/** Like `thrown`, for async functions: returns whatever `fn` rejects with. */
export async function rejected(fn: () => unknown): Promise<unknown> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected the call to reject, but it did not");
}

type ErrorType<T> = abstract new (...args: never[]) => T;

function ofType<T extends Error>(type: ErrorType<T>, error: unknown): T {
  if (error instanceof type) return error;
  throw new Error(
    `expected a ${type.name} but got ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
    {
      cause: error,
    },
  );
}

/** The error `fn` throws, which must be a `type`. */
export const thrownBy = <T extends Error>(type: ErrorType<T>, fn: () => unknown): T => ofType(type, thrown(fn));

/** The error `fn` rejects with, which must be a `type`. */
export const failureOf = async <T extends Error>(type: ErrorType<T>, fn: () => unknown): Promise<T> =>
  ofType(type, await rejected(fn));
