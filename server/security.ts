import type { NextFunction, Request, Response } from 'express';

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

/** Hostnames the API answers to: loopback names plus the configured bind host, if different. */
export function allowedHostnames(bindHost?: string): Set<string> {
  const allowed = new Set(LOOPBACK);
  const host = bindHost?.trim().toLowerCase();
  if (host) allowed.add(host.includes(':') && !host.startsWith('[') ? `[${host}]` : host);
  return allowed;
}

/** The hostname part of a Host header ("127.0.0.1:8787" -> "127.0.0.1"), or null if malformed. */
export function hostnameOf(hostHeader: string): string | null {
  if (!/^[A-Za-z0-9.\-:[\]]+$/.test(hostHeader)) return null;
  try {
    return new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function originHostname(origin: string): string | null {
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function hasBody(req: Request): boolean {
  const length = req.headers['content-length'];
  if (length !== undefined) return Number(length) > 0;
  return req.headers['transfer-encoding'] !== undefined;
}

/**
 * The server runs programs with the user's credentials, so the API only answers requests that
 * are addressed to this machine by name (defeating DNS rebinding), that do not come from another
 * site's pages, and whose bodies are JSON (which a cross-site form cannot send).
 */
export function apiGuard(bindHost?: string) {
  const allowed = allowedHostnames(bindHost);
  return (req: Request, res: Response, next: NextFunction): void => {
    const host = req.headers.host;
    const hostname = host ? hostnameOf(host) : null;
    if (!hostname || !allowed.has(hostname)) {
      res.status(403).json({ error: `Requests must be addressed to this computer (got Host: ${host ?? 'none'}).` });
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined) {
      const originHost = originHostname(origin);
      if (!originHost || !allowed.has(originHost)) {
        res.status(403).json({ error: `Cross-origin requests are not allowed (Origin: ${origin}).` });
        return;
      }
    }
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && hasBody(req)) {
      const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
      if (type !== 'application/json') {
        res.status(415).json({ error: 'Request bodies must be sent as Content-Type: application/json.' });
        return;
      }
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  };
}
