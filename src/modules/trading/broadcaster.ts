import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { Client } from 'pg';
import { sqrtToEthString } from './price';

export type PgClientFactory = () => Client;

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
  sellEth: bigint;
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
  private readonly clients = new Map<WebSocket, Set<string>>();
  private readonly recentTicks = new Map<string, Record<string, unknown>[]>();
  private connected = false;

  private pg!: Client;
  private heartbeat?: ReturnType<typeof setInterval>;

  constructor(
    private readonly pgFactory: PgClientFactory,
    private readonly port: number,
  ) {}

  async start(): Promise<void> {
    await this.connectPg();

    this.server = createServer();
    this.wss = new WebSocketServer({
      server: this.server,
      path: '/ws',
      perMessageDeflate: { threshold: 512 },
    });
    this.wss.on('connection', (socket, request) => {
      const url = new URL(request.url ?? '/ws', 'http://localhost');
      const legacy = url.searchParams.get('pool')?.toLowerCase() ?? null;
      const subs = new Set<string>(legacy ? [legacy] : []);
      this.clients.set(socket, subs);
      socket.on('pong', () => {
        (socket as WebSocket & { isAlive?: boolean }).isAlive = true;
      });
      socket.on('message', (raw) => {
        let msg: { op?: string; pools?: unknown };
        try {
          msg = JSON.parse(String(raw)) as { op?: string; pools?: unknown };
        } catch {
          return;
        }
        const pools = Array.isArray(msg.pools)
          ? msg.pools.filter((p): p is string => typeof p === 'string').map((p) => p.toLowerCase())
          : [];
        if (msg.op === 'sub') {
          for (const pool of pools) {
            subs.add(pool);
            // Snapshot on subscribe: current bar + recent ticks, so clients
            // render immediately instead of REST-refetching.
            const bar = this.bars.get(pool);
            if (bar) socket.send(JSON.stringify(barMessage(pool, bar, false)));
            for (const tick of this.recentTicks.get(pool) ?? []) {
              socket.send(JSON.stringify(tick));
            }
          }
        } else if (msg.op === 'unsub') {
          for (const pool of pools) subs.delete(pool);
        }
      });
      socket.on('close', () => this.clients.delete(socket));
      socket.on('error', () => this.clients.delete(socket));
      if (legacy) {
        const bar = this.bars.get(legacy);
        if (bar) socket.send(JSON.stringify(barMessage(legacy, bar, false)));
      }
    });
    // Heartbeat: terminate sockets that miss two pongs so dead TCP peers
    // (laptops asleep, dropped NAT) stop lingering as "connected".
    this.heartbeat = setInterval(() => {
      for (const socket of this.clients.keys()) {
        const alive = socket as WebSocket & { isAlive?: boolean };
        if (alive.isAlive === false) {
          socket.terminate();
          this.clients.delete(socket);
          continue;
        }
        alive.isAlive = false;
        socket.ping();
      }
    }, 30_000);
    this.heartbeat.unref?.();
    await new Promise<void>((resolve) => this.server!.listen(this.port, '0.0.0.0', resolve));
    this.connected = true;
    console.log(`broadcaster listening on :${this.port}/ws (pool param optional)`);
  }

  /** Connects the LISTEN client; reconnects with backoff on any failure. */
  private async connectPg(): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        this.pg = this.pgFactory();
        await this.pg.connect();
        await this.pg.query('LISTEN spawn_trades');
        await this.pg.query('LISTEN spawn_pools');
    await this.pg.query('LISTEN spawn_harvests');
    await this.pg.query('LISTEN spawn_comments');
        this.pg.on('notification', (msg) => this.onNotification(msg.channel ?? '', msg.payload));
        this.pg.on('error', (error) => {
          console.error('broadcaster pg error:', error.message);
          void this.reconnectPg();
        });
        this.pg.on('end', () => {
          void this.reconnectPg();
        });
        if (attempt > 0) console.log('broadcaster pg reconnected');
        return;
      } catch (error) {
        const delay = Math.min(1_000 * 2 ** Math.min(attempt, 5), 30_000);
        console.error(
          `broadcaster pg connect failed (attempt ${attempt + 1}):`,
          error instanceof Error ? error.message : error,
          `- retrying in ${delay}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  private reconnecting = false;

  private async reconnectPg(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    try {
      await this.pg.end().catch(() => undefined);
    } catch {
      /* already dead */
    }
    await this.connectPg();
    this.reconnecting = false;
  }

  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const bar of this.bars.values()) if (bar.timer) clearTimeout(bar.timer);
    this.wss?.close();
    this.server?.close();
    void this.pg.end().catch(() => undefined);
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
    else if (channel === 'spawn_comments') {
      // Comments are keyed by offchain token UUID; clients invalidate their
      // comment queries on this rare event (no per-pool routing needed).
      this.broadcast({ type: 'comment', tokenDbId: str(data.token_db_id), ts: data.ts });
    }
    else if (channel === 'spawn_harvests') {
      this.broadcast({
        type: 'harvest',
        pool: str(data.pool_id).toLowerCase(),
        bandIndex: Number(data.band_index ?? 0),
        grossQuoteWei: str(data.gross_quote),
        ts: data.ts,
      });
    }
  }

  private onTrade(t: Record<string, unknown>): void {
    const pool = str(t.pool_id).toLowerCase();
    const sqrt = BigInt(str(t.sqrt));
    const isBuy = Boolean(t.is_buy);
    const eth = BigInt(str(t.eth));
    const tsSec = Number(str(t.ts));
    const priceEth = sqrt > 0n ? sqrtToEthString(sqrt) : null;

    const tick = {
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
    };
    const ring = this.recentTicks.get(pool);
    if (ring) {
      ring.push(tick);
      if (ring.length > 30) ring.shift();
    } else {
      this.recentTicks.set(pool, [tick]);
    }
    this.broadcast(tick, pool);

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
        sellEth: 0n,
        trades: 0,
        lastPushAt: 0,
      };
      this.bars.set(pool, bar);
    }
    bar.close = sqrt;
    bar.highSqrt = sqrt > bar.highSqrt ? sqrt : bar.highSqrt;
    bar.lowSqrt = sqrt < bar.lowSqrt ? sqrt : bar.lowSqrt;
    if (isBuy) bar.buyEth += eth;
    else bar.sellEth += eth;
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
    for (const [socket, subs] of this.clients) {
      // Ticks/bars go only to subscribers of that pool; lifecycle events
      // (onlyPool undefined) reach everyone — they are rare.
      if (onlyPool && !subs.has(onlyPool)) continue;
      if (socket.readyState !== socket.OPEN) continue;
      // Backpressure: slow consumers get skipped before they balloon memory;
      // pathologically stalled ones are culled outright.
      if (socket.bufferedAmount > 8_000_000) {
        socket.terminate();
        this.clients.delete(socket);
        continue;
      }
      if (socket.bufferedAmount > 1_000_000) continue;
      socket.send(text);
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
    volEth: (bar.buyEth + bar.sellEth).toString(),
    buyVolEth: bar.buyEth.toString(),
    sellVolEth: bar.sellEth.toString(),
    trades: bar.trades,
  };
}
