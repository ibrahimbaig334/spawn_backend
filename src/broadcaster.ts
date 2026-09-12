import { Client } from 'pg';
import { Broadcaster } from './modules/trading/broadcaster';

/**
 * Broadcaster entrypoint: LISTEN/NOTIFY → WebSocket hub (see guide §4).
 * Run with PROCESS_ROLE=broadcaster / `yarn start:broadcaster`.
 */

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is required for the broadcaster');
  process.exit(1);
}

const port = Number(process.env.BROADCASTER_WS_PORT ?? 3001);
const pg = new Client({ connectionString });
const broadcaster = new Broadcaster(pg, port);

void broadcaster.start().catch((error) => {
  console.error('broadcaster failed to start:', error);
  process.exit(1);
});

const shutdown = () => {
  broadcaster.stop();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
