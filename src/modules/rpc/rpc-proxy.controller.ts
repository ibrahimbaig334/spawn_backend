import { Body, Controller, HttpCode, Inject, Post, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { APP_ENVIRONMENT } from '../../config/config.constants';
import type { Environment } from '../../config/environment';
import { RateLimit } from '../../infrastructure/rate-limit/rate-limit.decorator';
import { RATE_LIMIT_POLICIES } from '../../infrastructure/rate-limit/rate-limit.policy';

/**
 * Same-origin JSON-RPC proxy for the browser bundle.
 *
 * The local dev node exposes no CORS headers, so direct browser RPC fails
 * (see chains.ts / wallet.tsx). The frontend points NEXT_PUBLIC_RPC_URL here;
 * every JSON-RPC payload (reads and wallet-signed writes) is forwarded
 * untouched to the chain RPC. Local-dev convenience: production deployments
 * should restrict methods/origins.
 */
@ApiTags('rpc')
@Controller('rpc')
export class RpcProxyController {
  private readonly target: string;

  constructor(@Inject(APP_ENVIRONMENT) environment: Environment) {
    const chainId = environment.DEFAULT_CHAIN_ID;
    const perChain = process.env[`RPC_URLS_${chainId}`]
      ?.split(',')
      .map((url) => url.trim())
      .filter(Boolean);
    const target = perChain?.[0] ?? environment.chainRpcUrls[0];
    if (!target) throw new Error('No chain RPC URL configured for the RPC proxy');
    this.target = target;
  }

  @Post()
  @HttpCode(200)
  @RateLimit(RATE_LIMIT_POLICIES.rpcProxy)
  @ApiOperation({ operationId: 'proxyRpc' })
  async proxy(@Body() body: unknown, @Res() reply: FastifyReply): Promise<void> {
    let upstream: Response;
    try {
      upstream = await fetch(this.target, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      reply.status(503).send({
        type: 'https://api.spawn.local/problems/rpc_unavailable',
        title: 'rpc unavailable',
        status: 503,
        code: 'RPC_UNAVAILABLE',
        detail: (error as Error).message,
      });
      return;
    }
    const text = await upstream.text();
    reply.header('content-type', 'application/json').status(upstream.status).send(text);
  }
}
