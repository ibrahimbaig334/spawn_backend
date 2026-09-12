# Spawn Backend

NestJS API, chain indexer, WS broadcaster, and outbox worker for the **Spawn launchpad**
protocol (singleton `MilestoneHook` on Base: fixed-supply token launches, a bonding curve
that graduates into a decaying milestone ladder, and payout-plugin settlement).

## Processes

| Process         | Script                          | Role                                                                                                                                                                                |
| --------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **API**         | `yarn start` / `yarn start:dev` | Token registry, trusted-operator launch flow, profiles, comments, read views over the committed data layer                                                                          |
| **Indexer**     | `yarn start:indexer`            | Decodes every protocol event (27 hook events + PoolManager swaps + token burns + NFT + registry + controller), maintains facts/state/aggregates, reorg rollback + aggregate rebuild |
| **Broadcaster** | `yarn start:broadcaster`        | `pg LISTEN` → WebSocket hub (`/ws?pool=0x…`): `tick`/`bar`/`bar_close` per the frozen stream contract (BACKEND_GUIDE §4)                                                            |
| **Worker**      | `yarn start:worker`             | Outbox dispatcher + `leaderboard_daily` materialized-view refresh every 30 s                                                                                                        |

## Protocol facts the code encodes (current handoff)

- `LaunchConfig` = `{ creator, name, symbol, uri, totalSupply, devBuyShareWad, payoutPlan, deadline }`;
  EIP-712 domain `SpawnLaunchpad` v1, verifying contract = hook. Total supply is **pinned to
  1,000,000,000e18** (`SupplyNotFixed` otherwise). `configHash` (deadline-free) feeds the
  CREATE2 salt `keccak256(configHash, creator)`.
- **Trusted-operator launches:** creators never sign. The protocol's on-chain `trustedOperator`
  — a key this backend operates (BACKEND_GUIDE §6.1) — signs each relayed `LaunchConfig`
  (`UnauthorizedLaunchSigner` otherwise). Set `TRUSTED_OPERATOR_PRIVATE_KEY`; rotation runs
  through `ProtocolController.scheduleTrustedOperator`. Setting the operator to zero disables
  relayed launches (surfaced via `/protocol/watermark` → `trustedOperator` / `protocol_state`).
- `level = -tick`; `price(token→ETH) = 2^192 / sqrtPriceX96²` (the INVERSE: highest ETH price
  = lowest sqrt). Candle/aggregate OHLC is stored on the raw sqrt axis and converted at read.
- Curve: 32 nested positions, 13,862 levels (4× opening), **2 ETH opening FDV**. Graduation
  split 20 % LP seed / 70 % creator / 10 % protocol, seeding a bounded full-range position
  ($5,100→$150B FDV, hard floor) plus an 880,000-level token-only **wall** (`wallLiquidity`
  on `Graduated`).
- Ladder: 22 core bands, decaying steps `max(2235, 6932 − 391·i)` above graduation, 447-wide;
  top ≈ 2,900× graduation (~$58M @ $2,500 ETH reference). ≤30 fee-funded extensions at floor.
- Economics defaults: harvest service fee 10 % (cap 20 %), quote fees 75 % creator /
  25 % protocol (cap 90 %), **token fees 100 % milestone fund** (cap 100 %; burn at zero
  extension capacity). Flush tip: `pot/100`, new pots only.
- Flush paths: `flushTo(poolId, tipTo)` and `flushBatch(pools, tipTo)` (tip to an explicit
  recipient — Multicall3-safe), `claimCreatorPathBatch(pools)`, plus `flushGasCeiling` /
  `creatorPathGasCeiling` views.
- Addresses come **only** from the deployment manifest (`deployments/<chainId>.json` synced
  into `deployment_manifests` via `yarn manifest:sync`) or `SPAWN_*_ADDRESS` overrides.

## Data layer (backend/BACKEND_GUIDE.md is normative)

State (`tokens`, `pools`, `bands`, `pots`, `plugin_registry`, `economic_configs`,
`protocol_state`), sink-maintained aggregates (`pool_stats`, `pool_minute/hour/day_stats`,
`protocol_day_stats`, `protocol_stats`), insert-only facts keyed by
`ordinal_key = "<block>:<log>"` (`launches`, `graduations`, `swaps`+fees, accrual/claim/
payout facts, `token_burns`, …), and derived views (`pool_metrics`, `candles_5m/15m/4h`,
`leaderboard_daily` matview). Notify-only triggers (`spawn_trades`, `spawn_pools`) feed the
broadcaster — never mutate sink aggregates or add triggers to them.

## Prerequisites

Node ≥ 24, Yarn (1.22), PostgreSQL 17, Redis, a Base RPC (archival recommended for the indexer).

## Setup

```powershell
yarn install
Copy-Item .env.example .env   # edit: DATABASE_URL, CHAIN_RPC_URLS, TRUSTED_OPERATOR_PRIVATE_KEY…
yarn prisma:generate
yarn db:migrate
```

After a protocol deployment:

```powershell
yarn manifest:sync 8453 spawn-integration-handoff/deployments/8453.json
# .env: INDEXER_START_BLOCK=<deployment block>
yarn start:indexer
yarn start:broadcaster
```

Pre-deployment the API degrades cleanly (manifest-gated endpoints 404/503 with stable codes);
the indexer refuses to start without an address book.

## Verify pipeline

`yarn prisma:validate`, `yarn format:check`, `yarn lint`, `yarn typecheck`, `yarn test`,
`yarn build`, `yarn openapi:check`.

## API surface (base `/api/v1`)

- Tokens: `POST/GET /tokens`, `/tokens/featured`, `GET /tokens/:tokenRef` (+`/trades`,
  `/candles` with `1m|5m|15m|1h|4h|1d` — ETH prices converted from the sqrt axis, raw sqrt
  also returned, `/milestones` full decaying ladder incl. `PENDING`/`SKIPPED`, `/revenue`
  per-pool fact ledgers, `/price`, `/quote` via V4Quoter, `/depth` curve/bands/wall).
- Launch: `POST /launch/prepare` (validate, metadata → on-chain `uri`, predict CREATE2
  address, digest, dev-buy quote) → `POST /launch/relay` (operator signs + broadcasts) →
  `GET /launch/records/:launchId` (status incl. onchain bind via configHash).
- Protocol: `GET /protocol/addresses|economics|plugins|governance|revenue|revenue/history|stats|watermark`.
- Keepers: `GET /keepers/jobs` (flushTo/graduate/collectFees signals + incentives + multicall3).
- Profiles (`/tokens`, `/revenue-streams`) and comments — unchanged contract.
- Health: `/health/live`, `/health/ready`. Swagger at `/api/docs`.

## Conventions

`{ data, meta }` success envelope; RFC-7807 problem+json errors; lowercase hex; 256-bit
values and WAD numbers as decimal strings; ISO-8601 timestamps. `poolId` is bytes32. WS
messages: `tick` / `bar` / `bar_close` (1 m bars, 250 ms throttle), reconnect → REST.

See `FRONTEND_INTEGRATION_GUIDE.md` for the full contract.
