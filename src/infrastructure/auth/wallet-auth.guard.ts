import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { WalletAuthService } from './wallet-auth.service';

/**
 * Requires a valid wallet session token: `Authorization: Bearer <jwt>`.
 * Attaches the authenticated wallet (lowercase) to the request as
 * `walletAddress`. Handlers must derive the actor from this property —
 * never from the body or URL.
 */
export const WALLET_AUTH_REQUEST = 'walletAddress';

@Injectable()
export class WalletAuthGuard implements CanActivate {
  constructor(private readonly auth: WalletAuthService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      walletAddress?: string;
    }>();
    const header = request.headers.authorization;
    const raw = Array.isArray(header) ? header[0] : header;
    if (typeof raw !== 'string' || !raw.startsWith('Bearer ')) {
      return false;
    }
    const claims = this.auth.authenticate(raw.slice('Bearer '.length).trim());
    request.walletAddress = claims.sub;
    return true;
  }
}
