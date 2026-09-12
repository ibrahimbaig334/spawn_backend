import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { Client } from 'pg';
import { sqrtToEthString } from './price';

/**
 * WS broadcaster (backend guide §4): Postgres is the source of truth; the stream
 * is delivery.
 *
 *  - LISTENs on the sink's notify-only triggers (`spawn_trades`, `spawn_pools`).
 *  - Maintains the current 1m bar per active pool in memory with the sink's delta
 *    algebra (open = first, close = set, high = max-ETH/min-sqrt, low = min-ETH/max-sqrt,
 *    volumes +=) and throttles `bar` pushes to ~250 ms per pool.
 *  - Emits `bar_close` at minute roll-over. Reconnect reconciliation is REST.
 *
 * Run as PROCESS_ROLE=broadcaster (or `yarn start:broadcaster`). WS path: /ws?pool=0x…
 */

type Bar = {
  start: number;
  open: bigint;
  close: bigint;
  highSqrt: bigint;
  lowSqrt: bigint;
  buyEth: bigint;
  trades: number;
  lastPushAt: number;
  timer?: ReturnType<typeof setTimeout>;
};

const MINUTE_MS = 60_000;
const BAR_THROTTLE_MS = 250;

function str(v: unknown): string {
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint') return v.toString();
  return '0';
}

export class Broadcaster {
  private wss?: WebSocketServer;
  private server?: Server;
  private readonly bars = new Map<string, Bar>();
  private readonly clients = new Map<WebSocket, string | null>();
  private connected = false;

  constructor(
    private readonly pg: Client,
    private readonly port: number,
  ) {}

  async start(): Promise<void> {
    await this.pg.connect();
    await this.pg.query('LISTEN spawn_trades');
    await this.pg.query('LISTEN spawn_pools');
    this.pg.on('notification', (msg) => this.onNotification(msg.channel ?? '', msg.payload));
    this.pg.on('error', (error) => {
      console.error('broadcaster pg error:', error.message);
    });

    this.server = createServer();
    this.wss = new WebSocketServer({ server: this.server, path: '/ws' });
    this.wss.on('connection', (socket, request) => {
      const url = new URL(request.url ?? '/ws', 'http://localhost');
      const pool = url.searchParams.get('pool')?.toLowerCase() ?? null;
      this.clients.set(socket, pool);
      socket.on('close', () => this.clients.delete(socket));
      socket.on('error', () => this.clients.delete(socket));
      if (pool) {
        const bar = this.bars.get(pool);
        if (bar) socket.send(JSON.stringify(barMessage(pool, bar, false)));
      }
    });
    await new Promise<void>((resolve) => this.server!.listen(this.port, '0.0.0.0', resolve));
    this.connected = true;
    console.log(`broadcaster listening on :${this.port}/ws (pool param optional)`);
  }

  stop(): void {
    for (const bar of this.bars.values()) if (bar.timer) clearTimeout(bar.timer);
    this.wss?.close();
    this.server?.close();
    void this.pg.end();
  }

  private onNotification(channel: string, payload: string | undefined): void {
    if (!payload) return;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return;
    }
    if (channel === 'spawn_trades') this.onTrade(data);
    else if (channel === 'spawn_pools') this.broadcast({ type: 'pool', ...data });
  }

  private onTrade(t: Record<string, unknown>): void {
    const pool = str(t.pool_id).toLowerCase();
    const sqrt = BigInt(str(t.sqrt));
    const isBuy = Boolean(t.is_buy);
    const eth = BigInt(str(t.eth));
    const tsSec = Number(str(t.ts));
    const priceEth = sqrt > 0n ? sqrtToEthString(sqrt) : null;

    this.broadcast(
      {
        type: 'tick',
        pool,
        isBuy,
        priceEth,
        sqrt: t.sqrt,
        eth: t.eth,
        tokens: t.tokens,
        ts: t.ts,
        block: t.block,
        tx: t.tx,
      },
      pool,
    );

    const bucketMs = tsSec * 1000 - ((tsSec * 1000) % MINUTE_MS);
    let bar = this.bars.get(pool);
    if (!bar || bar.start !== bucketMs) {
      if (bar) {
        this.broadcast({ ...barMessage(pool, bar, true) }, pool);
        if (bar.timer) clearTimeout(bar.timer);
      }
      bar = {
        start: bucketMs,
        open: sqrt,
        close: sqrt,
        highSqrt: sqrt,
        lowSqrt: sqrt,
        buyEth: 0n,
        trades: 0,
        lastPushAt: 0,
      };
      this.bars.set(pool, bar);
    }
    bar.close = sqrt;
    bar.highSqrt = sqrt > bar.highSqrt ? sqrt : bar.highSqrt;
    bar.lowSqrt = sqrt < bar.lowSqrt ? sqrt : bar.lowSqrt;
    if (isBuy) bar.buyEth += eth;
    bar.trades += 1;

    const now = Date.now();
    if (now - bar.lastPushAt >= BAR_THROTTLE_MS) {
      bar.lastPushAt = now;
      this.broadcast(barMessage(pool, bar, false), pool);
    }
    if (!bar.timer) {
      const ms = bar.start + MINUTE_MS - now + 50;
      bar.timer = setTimeout(
        () => {
          const current = this.bars.get(pool);
          if (current && current === bar) {
            this.broadcast(barMessage(pool, current, true), pool);
            this.bars.delete(pool);
          }
        },
        Math.max(ms, 100),
      );
      bar.timer.unref?.();
    }
  }

  private broadcast(message: unknown, onlyPool?: string): void {
    const text = JSON.stringify(message);
    for (const [socket, pool] of this.clients) {
      if (onlyPool && pool && pool !== onlyPool) continue;
      if (socket.readyState === socket.OPEN) socket.send(text);
    }
  }
}

function barMessage(pool: string, bar: Bar, final: boolean): Record<string, unknown> {
  return {
    type: final ? 'bar_close' : 'bar',
    interval: '1m',
    pool,
    start: Math.floor(bar.start / 1000),
    open: sqrtToEthString(bar.open),
    // ETH-axis inversion: highest ETH price = lowest sqrt.
    high: sqrtToEthString(bar.lowSqrt),
    low: sqrtToEthString(bar.highSqrt),
    close: sqrtToEthString(bar.close),
    volEth: bar.buyEth.toString(),
    trades: bar.trades,
  };
}
