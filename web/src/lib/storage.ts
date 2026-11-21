/**
 * localStorage can be missing or throw (private mode, disabled storage, sandboxed frames).
 * The app must keep working without it, so every access goes through these helpers.
 */

export function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Persistence is a convenience; the in-memory value still applies for this session.
  }
}
