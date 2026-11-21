import { describe, expect, it } from 'vitest';
import { parsePath, pathFor } from './routes';

describe('routes', () => {
  it('parses conversation paths', () => {
    expect(parsePath('/c/123e4567-e89b-12d3-a456-426614174000')).toEqual({
      kind: 'conversation',
      id: '123e4567-e89b-12d3-a456-426614174000',
    });
    expect(parsePath('/c/abc/')).toEqual({ kind: 'conversation', id: 'abc' });
    expect(parsePath('/c/a%20b')).toEqual({ kind: 'conversation', id: 'a b' });
  });

  it('treats everything else as home', () => {
    for (const p of ['/', '', '/c/', '/c', '/settings', '/c/a/b', '/c/%E0%A4%A', '/c/%20']) {
      expect(parsePath(p)).toEqual({ kind: 'home' });
    }
  });

  it('round-trips through pathFor', () => {
    expect(pathFor({ kind: 'home' })).toBe('/');
    const route = { kind: 'conversation' as const, id: 'x/y z' };
    expect(parsePath(pathFor(route))).toEqual(route);
  });
});
