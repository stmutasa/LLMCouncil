import type { Route } from '../store';

/** `/c/<id>` opens a conversation; every other path is the new-chat screen. */
export function parsePath(pathname: string): Route {
  const match = /^\/c\/([^/]+)\/?$/.exec(pathname);
  if (match) {
    try {
      const id = decodeURIComponent(match[1]!);
      if (id.trim()) return { kind: 'conversation', id };
    } catch {
      // A malformed escape sequence is not a conversation id.
    }
  }
  return { kind: 'home' };
}

export function pathFor(route: Route): string {
  return route.kind === 'conversation' ? `/c/${encodeURIComponent(route.id)}` : '/';
}
