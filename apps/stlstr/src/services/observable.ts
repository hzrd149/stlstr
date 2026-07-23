/**
 * Reading a single value out of an Applesauce reactive cast.
 *
 * Several services need the same thing from a cast: the first *defined* value it emits — the
 * user's relay list, their Blossom servers, their profile — with a timeout so a cold lookup
 * that never resolves cannot hang the caller. This is that shared helper.
 */

export type ObservableLike<T> = {
  subscribe(observer: (value: T) => void): { unsubscribe(): void };
};

/**
 * Resolves the first defined value from a reactive cast, or undefined on timeout.
 *
 * These observables replay a cached value synchronously when the store already holds the
 * event, so the timeout only applies to a cold lookup that is still in flight. Timing out
 * resolves undefined rather than rejecting: callers treat "not known yet" and "could not
 * resolve" the same way and fall back to app defaults.
 */
export function firstDefinedValue<T>(
  observable: ObservableLike<T | undefined>,
  timeoutMs = 1_500,
): Promise<T | undefined> {
  return new Promise((resolve) => {
    let settled = false;

    const settle = (value: T | undefined) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      subscription.unsubscribe();
      resolve(value);
    };

    const subscription = observable.subscribe((value) => {
      if (value !== undefined) settle(value);
    });
    const timeout = window.setTimeout(() => settle(undefined), timeoutMs);
  });
}
