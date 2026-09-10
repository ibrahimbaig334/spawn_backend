# Spawn backend

NestJS API and outbox worker for the Spawn token launchpad. The API owns offchain token creation, synchronous Thirdweb/IPFS metadata upload, deployment-signer custody, profiles, comments, and idempotency. A separate indexer owns authoritative onchain projections in PostgreSQL.

## Prerequisites

- Node.js 24.18.1+
- pnpm 12.3.4 through Corepack
- PostgreSQL 17
- Redis (single primary/standalone)

## Setup

```powershell
corepack enable
corepack prepare pnpm@12.3.4 --activate
pnpm install --frozen-lockfile
Copy-Item .env.example .env
pnpm prisma:generate
pnpm db:migrate
```

Replace every placeholder in `.env`. The API uses `DATABASE_URL`; the guarded fixture command uses separately privileged `SEED_DATABASE_URL`. The API requires `THIRDWEB_SECRET_KEY`, a canonical base64-encoded 32-byte `PRIVATE_KEY_ENCRYPTION_KEY`, and `PRIVATE_KEY_ENCRYPTION_KEY_ID`.

## Run

```powershell
# API (development)
pnpm start:dev

# Comment cache outbox worker (second terminal)
pnpm worker:dev
```

The API defaults to `http://localhost:3000/api/v1`. Swagger UI is at `/api/docs` and OpenAPI JSON is at `/api/openapi.json`.

## Database and fixtures

```powershell
pnpm db:migrate
$env:ALLOW_DESTRUCTIVE_SEED = 'true'
$env:SEED_DATABASE_URL = 'postgresql://spawn_seed:change-me@localhost:5432/spawn?schema=public'
$env:SEED_REFERENCE_TIME = (Get-Date).ToUniversalTime().ToString('o')
pnpm db:seed
```

The seed is intentionally gated because it reconciles deterministic development fixtures. Fixture contract addresses are explicit mock display values with synthetic provenance; they are not chain truth or deployment records. Do not enable the seed against production data.

## Verify and build

```powershell
pnpm prisma:generate
pnpm prisma:validate
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm openapi:check
```

Start production builds with `pnpm start` and `pnpm start:worker`. Liveness and dependency readiness are available at `/api/v1/health/live` and `/api/v1/health/ready`.

See [FRONTEND_INTEGRATION_GUIDE.md](FRONTEND_INTEGRATION_GUIDE.md) for routes, request types, exact numeric handling, and examples.
