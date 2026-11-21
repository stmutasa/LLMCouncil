/** Locally generated ids for settings entities (members, protocols, rounds). */
export function newId(prefix: string): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return `${prefix}-${c.randomUUID().slice(0, 8)}`;
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}
