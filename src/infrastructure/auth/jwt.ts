import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Minimal HS256 JWT — sign/verify only, no dependencies. Session tokens are
 * short-lived wallet proofs; the asymmetric trust anchor is the wallet
 * signature itself, so a symmetric session token is the right weight here.
 */

export type SessionClaims = {
  sub: string; // wallet address (lowercase)
  iat: number;
  exp: number;
};

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/u, '');
}

function b64urlJson(value: unknown): string {
  return b64url(JSON.stringify(value));
}

function fromB64url(input: string): Buffer {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

export function signSession(claims: Omit<SessionClaims, 'iat'>, secret: string): string {
  const header = b64urlJson({ alg: 'HS256', typ: 'JWT' });
  const payload = b64urlJson({ ...claims, iat: Math.floor(Date.now() / 1000) });
  const signingInput = `${header}.${payload}`;
  const sig = b64url(createHmac('sha256', secret).update(signingInput).digest());
  return `${signingInput}.${sig}`;
}

export function verifySession(token: string, secret: string): SessionClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts as [string, string, string];
  const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest();
  const provided = fromB64url(sig);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  let claims: SessionClaims;
  try {
    claims = JSON.parse(fromB64url(payload).toString('utf8')) as SessionClaims;
  } catch {
    return null;
  }
  if (!claims || typeof claims.sub !== 'string' || typeof claims.exp !== 'number') return null;
  if (claims.exp <= Math.floor(Date.now() / 1000)) return null;
  return claims;
}
