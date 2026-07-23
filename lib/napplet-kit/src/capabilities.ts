/**
 * Feature-detecting the shell's NAP domains.
 *
 * A napplet reaches its host through `window.napplet`, but a given shell implements only some
 * NAP domains, and a domain may be present without the exact method a napplet needs. So every
 * optional capability is checked before use. This holds the two pieces that check was being
 * copied around — the namespace accessor and the "does this domain expose these methods" test.
 * Each napplet still declares which methods it requires; nothing here assumes a fixed set.
 */

/** The shell's injected NAP namespace, or an empty object when nothing is mounted. */
export function napplets(): Record<string, unknown> {
  return ((window as Window & { napplet?: Record<string, unknown> }).napplet ?? {}) as Record<
    string,
    unknown
  >;
}

/** True when the named domain is present at all (mounted as an object). */
export function hasDomain(domain: string): boolean {
  return typeof napplets()[domain] === 'object';
}

/** True when the named domain is present and exposes every listed method as a function. */
export function hasMethods(domain: string, ...methods: string[]): boolean {
  const target = napplets()[domain] as Record<string, unknown> | undefined;
  if (!target) return false;
  return methods.every((method) => typeof target[method] === 'function');
}
