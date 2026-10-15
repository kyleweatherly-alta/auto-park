import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export const COOKIE_NAME = "ap_session";
const SESSION_DAYS = 90;

function hmac(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Token = "<expiry ms>.<signature>". Nothing personal is stored in it. */
export function signSession(secret: string, now = Date.now()): { token: string; expires: Date } {
  const expires = new Date(now + SESSION_DAYS * 24 * 60 * 60 * 1000);
  const payload = String(expires.getTime());
  return { token: `${payload}.${hmac(secret, payload)}`, expires };
}

export function verifySession(secret: string, token: string | undefined, now = Date.now()): boolean {
  if (!token) return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig || !/^\d+$/.test(payload)) return false;
  if (!safeEqual(sig, hmac(secret, payload))) return false;
  return Number(payload) > now;
}

/** Compare passcodes without leaking their length or content through timing. */
export function passcodeMatches(secret: string, expected: string, given: string): boolean {
  return safeEqual(hmac(secret, `pc:${given}`), hmac(secret, `pc:${expected}`));
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

/** Simple in-memory limiter: N failures per window per key (IP). */
export class FailureLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private readonly max = 5,
    private readonly windowMs = 15 * 60 * 1000,
  ) {}

  private recent(key: string, now: number): number[] {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    this.hits.set(key, list);
    return list;
  }

  /** Milliseconds until the key may try again, or 0 if it may try now. */
  retryAfter(key: string, now = Date.now()): number {
    const list = this.recent(key, now);
    if (list.length < this.max) return 0;
    return this.windowMs - (now - list[0]!);
  }

  fail(key: string, now = Date.now()): void {
    this.recent(key, now).push(now);
  }

  reset(key: string): void {
    this.hits.delete(key);
  }
}

export function requireAuth(secret: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (verifySession(secret, readCookie(req, COOKIE_NAME))) return next();
    res.status(401).json({ error: "unauthorized", message: "Enter your passcode to continue." });
  };
}

/**
 * Cookies are SameSite=Lax, and every write needs a JSON body (which a
 * cross-site form can't send). As a belt-and-braces check, reject writes whose
 * Origin header names another site.
 */
export function sameOriginWrites(req: Request, res: Response, next: NextFunction) {
  if (req.method === "GET" || req.method === "HEAD") return next();
  const origin = req.headers.origin;
  if (origin) {
    let ok = false;
    try {
      ok = new URL(origin).host === req.headers.host;
    } catch {
      ok = false;
    }
    if (!ok) {
      res.status(403).json({ error: "bad_origin", message: "Request blocked." });
      return;
    }
  }
  next();
}
