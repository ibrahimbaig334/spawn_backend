# Spawn Backend

NestJS API, chain indexer, and outbox worker for the **Spawn launchpad** protocol
(singleton `MilestoneHook` on Base: signed-config token launches, a bonding curve that
graduates into a milestone ladder, and payout-plugin settlement).

The backend has three processes:

| Process     | Script                                    | Role                                                                                                                                                                                 |
| ----------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **API**     | `yarn start` / `yarn start:dev`           | Offchain token records, launch preparation + optional relaying, profiles, comments, idempotency, and read views over committed onchain projections                                   |
| **Indexer** | `yarn start:indexer` / `yarn indexer:dev` | Ingests blocks, decodes all protocol events, maintains the onchain projections (token states, trades, candles, milestones, holdings, revenue events, governance) with reorg rollback |
| **Worker**  | `yarn start:worker` / `yarn worker:dev`   | Outbox dispatcher (cache-generation invalidation)                                                                                                                                    |

## Protocol facts the code encodes

- One `MilestoneHook` serves every launch; per-launch state is keyed by `PoolId`.
  Native ETH is `currency0`, the launch token is `currency1`, static 1% fee, tick spacing 1.
- **`level = -tick`** — all user-facing math runs in level space; the sign flips exactly once
  at the pool boundary (`src/protocol/protocol-math.ts`, `src/protocol/tick-math.ts`).
- `FDV = totalSupply × 1.0001^level`; curve geometry (32 nested positions, span 6931) and
  ladder geometry (30 core + up to 30 fee-funded bands, spacing 2235, width 447) are exact
  ports of `CurveLib`/`LadderLib`.
- EIP-712 launch domain: `SpawnLaunchpad`, version `"1"`, verifying contract = hook.
  `configHash` (no deadline) drives the CREATE2 salt `keccak256(configHash, creator)` —
  a re-signed deadline never moves the token address.
- Contract addresses come **only** from the deployment manifest (`deployments/<chainId>.json`,
  synced into `deployment_manifests` via `yarn manifest:sync`) or `SPAWN_*_ADDRESS` env
  overrides. Nothing is hardcoded.

## Prerequisites

- Node >= 24, Yarn (classic 1.22), PostgreSQL 17, Redis (standalone).
- An RPC endpoint for Base (indexer + live reads). Archival-grade recommended.

## Setup

```powershell
npm install -g yarn
yarn install --frozen-lockfile
Copy-Item .env.example .env   # then edit values
yarn prisma:generate
yarn db:migrate
```

Once contracts are deployed, sync the deployment manifest and point the indexer at the
deployment block:

```powershell
yarn manifest:sync 8453 path/to/deployments/8453.json
# .env: CHAIN_RPC_URLS=..., INDEXER_START_BLOCK=<deployment block>
yarn start:indexer
```

## Verify pipeline

```powershell
yarn prisma:generate
yarn prisma:validate
yarn format:check
yarn lint
yarn typecheck
yarn test
yarn build
yarn openapi:check
```

## API surface (base `/api/v1`)

- `POST/GET /tokens`, `GET /tokens/featured`, `GET /tokens/:tokenRef` (detail), `/trades`,
  `/candles`, `/milestones`, `/revenue` — token records + committed projections.
- `POST /launch/prepare` — validates a launch config against protocol bounds and the live
  registry, predicts the CREATE2 token address, computes the EIP-712 digest, quotes the
  optional dev buy, and persists a launch record.
- `POST /launch/relay` — optionally broadcasts the creator-signed launch through the
  backend relayer (`RELAYER_ENABLED=true` + `RELAYER_PRIVATE_KEY`; 503 when disabled).
- `GET /launch/records/:launchId` — submission status; links onchain state via configHash.
- `GET /tokens/:tokenRef/price` — live level/price/FDV (StateView slot0 + oracle USD).
- `GET /tokens/:tokenRef/quote` — V4Quoter swap quotes.
- `GET /tokens/:tokenRef/depth` — curve positions + ladder bands around spot.
- `GET /protocol/addresses|economics|plugins|governance/operations|revenue|watermark`.
- `GET /keepers/jobs` — flush / graduate / collectFees candidates with poll signals.
- `GET|PUT /profiles/:walletAddress`, `/profiles/:walletAddress/tokens`, `/portfolio`.
- Comments: `POST/GET /tokens/:tokenRef/comments`, `/comments/:id/replies`,
  `DELETE /comments/:id`, likes under `/comments/:id/likes/:walletAddress`.
- Health: `/health/live`, `/health/ready`.

Swagger UI: `/api/docs`; OpenAPI JSON: `/api/openapi.json` (committed at `openapi.json`).

## Conventions

- Success responses are `{ data, meta }`; errors are RFC-7807 `application/problem+json`.
- Addresses/hashes are lowercase hex; 256-bit values and WAD fixed-points are **decimal
  strings**; timestamps are UTC ISO-8601.
- Projection reads are gated by `chain_watermarks.committedVersion` (a stable read cut);
  `stale: true` flags watermarks older than `CHAIN_STALE_AFTER_SECONDS`.

See `FRONTEND_INTEGRATION_GUIDE.md` for the full request/response contract and
`spawn-integration-handoff/docs/technical/integration.md` for the protocol integration
reference.
