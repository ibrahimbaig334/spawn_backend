import { Inject, Injectable } from '@nestjs/common';
import { verifyMessage } from 'viem';
import { randomBytes } from 'node:crypto';
import { APP_ENVIRONMENT } from '../../config/config.constants';
import type { Environment } from '../../config/environment';
import { DomainException } from '../../common/http/domain.exception';
import type { DomainCachePort } from '../../infrastructure/cache/domain-cache.port';
import { CACHE_MANAGER } from '../../infrastructure/cache/cache.constants';
import { signSession, verifySession, type SessionClaims } from './jwt';

const NONCE_TTL_SECONDS = 600;
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

/**
 * Wallet sessions: SIWE-style sign-in. The client asks for a nonce, signs a
 * human-readable statement, and the backend recovers the signer with viem.
 * A short-lived HS256 session token is issued on success; write endpoints
 * (comments, likes) require it and derive the actor wallet from the token —
 * never from the request body or URL.
 */
@Injectable()
export class WalletAuthService {
  constructor(
    @Inject(APP_ENVIRONMENT) private readonly environment: Environment,
    @Inject(CACHE_MANAGER) private readonly cache: DomainCachePort,
  ) {}

  private secret(): string {
    const secret = this.environment.APP_JWT_SECRET ?? 'spawn-dev-session-secret-change-me';
    return secret;
  }

  async issueNonce(walletAddress: string): Promise<{ nonce: string; message: string }> {
    const wallet = walletAddress.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/u.test(wallet) || /^0x0{40}$/u.test(wallet)) {
      throw new DomainException(400, 'INVALID_WALLET_ADDRESS', 'walletAddress must be a nonzero EVM address');
    }
    const nonce = randomBytes(16).toString('hex');
    const issuedAt = new Date().toISOString();
    const message = [
      'Spawn wants you to sign in.',
      '',
      `Address: ${wallet}`,
      `Nonce: ${nonce}`,
      `Issued: ${issuedAt}`,
      '',
      'This signature only proves wallet ownership. It is free and grants no permission to move funds.',
    ].join('\n');
    await this.cache.set(`auth:nonce:${wallet}:${nonce}`, { message }, { ttlSeconds: NONCE_TTL_SECONDS });
    return { nonce, message };
  }

  async verify(walletAddress: string, nonce: string, signature: string, message: string): Promise<{ token: string; wallet: string; expiresIn: number }> {
    const wallet = walletAddress.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/u.test(wallet) || /^0x0{40}$/u.test(wallet)) {
      throw new DomainException(400, 'INVALID_WALLET_ADDRESS', 'walletAddress must be a nonzero EVM address');
    }
    if (typeof nonce !== 'string' || !/^[0-9a-f]{32}$/u.test(nonce)) {
      throw new DomainException(400, 'INVALID_NONCE', 'nonce is malformed');
    }
    const key = `auth:nonce:${wallet}:${nonce}`;
    const stored = await this.cache.get<{ message: string }>(key);
    if (!stored) {
      throw new DomainException(401, 'NONCE_EXPIRED', 'nonce is unknown or expired — request a new one');
    }
    await this.cache.delete(key); // single-use
    // The client echoes the exact message it signed; it must match the stored
    // one byte-for-byte, and the signature must recover to the wallet.
    if (message !== stored.message) {
      throw new DomainException(401, 'MESSAGE_MISMATCH', 'signed message does not match the issued nonce');
    }
    let valid = false;
    try {
      valid = await verifyMessage({ address: wallet as `0x${string}`, message, signature: signature as `0x${string}` });
    } catch {
      valid = false;
    }
    if (!valid) {
      throw new DomainException(401, 'SIGNATURE_INVALID', 'signature does not match the nonce message');
    }
    const now = Math.floor(Date.now() / 1000);
    const token = signSession({ sub: wallet, exp: now + SESSION_TTL_SECONDS }, this.secret());
    return { token, wallet, expiresIn: SESSION_TTL_SECONDS };
  }

  authenticate(token: string): SessionClaims {
    const claims = verifySession(token, this.secret());
    if (!claims) {
      throw new DomainException(401, 'SESSION_INVALID', 'session token is missing, malformed, or expired');
    }
    return claims;
  }
}
