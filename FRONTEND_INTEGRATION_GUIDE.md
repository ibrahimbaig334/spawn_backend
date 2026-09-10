# Frontend integration guide

## Conventions

Base URL: `/api/v1`. Successful non-collection responses are `{ data: T, meta: {} }`. Collections are `{ data: T[], meta: PageMeta }`. Errors use `application/problem+json` with `type`, `title`, `status`, `detail`, `code`, `requestId`, and optional `errors`.

Wallet addresses and hashes are normalized lowercase. EVM integers and fixed-point values are decimal strings; do not parse balances, supply, prices, market caps, or USD totals with JavaScript `Number`. Timestamps are UTC ISO-8601 strings.

```ts
export type OnchainPhase = 'NONE' | 'BONDING_CURVE' | 'GRADUATED';

export interface TokenSocials {
  website?: string;
  x?: string;
  telegram?: string;
  discord?: string;
}

export interface PageMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
}
```

`onchain: null` means no committed indexer projection and differs from `onchain.phase === 'NONE'`. `deploymentSignerAddress` is an EOA retained for a future deployment transaction; it is not the ERC-20 `contractAddress`. Uniswap v4 exposes a bytes32 `poolId`, not a pool address.

## Routes

| Method | Route                                | Inputs                   | Success |
| ------ | ------------------------------------ | ------------------------ | ------- |
| POST   | `/tokens`                            | body + `Idempotency-Key` | 201     |
| GET    | `/tokens`                            | search/filter/sort/page  | 200     |
| GET    | `/tokens/featured`                   | `chainId`                | 200     |
| GET    | `/tokens/:tokenRef`                  | timeframe/page/chain     | 200     |
| GET    | `/tokens/:tokenRef/trades`           | timeframe/side/page      | 200     |
| GET    | `/tokens/:tokenRef/candles`          | interval/range/limit     | 200     |
| GET    | `/tokens/:tokenRef/milestones`       | kind/state/page          | 200     |
| POST   | `/tokens/:tokenRef/comments`         | body + idempotency key   | 201     |
| GET    | `/tokens/:tokenRef/comments`         | sort/page                | 200     |
| GET    | `/comments/:id/replies`              | page                     | 200     |
| DELETE | `/comments/:id`                      | `walletAddress` query    | 200     |
| GET    | `/comments/:id/likes/:walletAddress` | —                        | 200     |
| PUT    | `/comments/:id/likes/:walletAddress` | —                        | 200     |
| DELETE | `/comments/:id/likes/:walletAddress` | —                        | 200     |
| GET    | `/profiles/:walletAddress`           | —                        | 200     |
| PUT    | `/profiles/:walletAddress`           | partial body             | 200     |
| GET    | `/profiles/:walletAddress/tokens`    | sort/page/chain          | 200     |
| GET    | `/profiles/:walletAddress/portfolio` | sort/page/chain          | 200     |

`tokenRef` is a token UUID or committed contract address. Contract lookup defaults to Base chain ID 8453.

## Token creation

```ts
interface CreateTokenRequest {
  creatorWalletAddress: `0x${string}`;
  name: string; // 1–80 code points
  symbol: string; // /^[A-Z0-9]{1,12}$/
  description: string; // 5–100 Unicode-whitespace-delimited words
  imageUri: `ipfs://${string}`;
  socials?: TokenSocials; // HTTPS URLs only
}
```

```ts
const response = await fetch('/api/v1/tokens', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
  body: JSON.stringify(input),
});
if (!response.ok) throw await response.json();
const { data } = await response.json();
```

Creation uploads metadata synchronously and returns `201` with `ipfsUri`, `gatewayUrl`, normalized socials, `deploymentSignerAddress`, and `contractAddress: null`. There is no metadata polling or retry endpoint. Reusing a key with the same normalized request returns the stored token without uploading again and sends `Idempotency-Replayed: true`; changing the body returns `409 IDEMPOTENCY_KEY_REUSED`. Upload failures return `503 METADATA_UPLOAD_FAILED` and create no token.

## Marketplace queries

`GET /tokens` accepts `q`, `creator`, `phase`, `hasOnchainProjection`, `sort=newest|oldest|market_cap|volume|graduated|relevance`, `timeframe=1h|24h|7d|30d|all`, `page`, `limit`, and `chainId`. `sort=relevance` requires `q`. Metric nulls sort last. Featured returns up to three deterministic, projected, non-stale tokens.

Trades support `side=BUY|SELL` and `sort=newest|oldest|amount`. Candle intervals are `1m|5m|15m|1h|4h|1d`; candle limits are capped at 1,000. Milestone `kind` is `CORE|EXTENSION`.

## Comments, profiles, and freshness

Comment text is 1–2,000 code points. `parentCommentId` creates a direct child; depth is capped at three. Deletion leaves a tombstone, and deleted comments cannot receive new likes or replies.

Profile updates use patch-like semantics despite `PUT`: omitted fields remain unchanged and explicit `null` clears `username`, `bio`, or `imageUri`. Usernames are 3–32 ASCII letters, digits, or underscores and unique case-insensitively.

Portfolio `sort` is `value|balance|recent`. Exact balances, nullable prices, source block data, watermarks, and `stale` must be preserved. Projection-derived responses can briefly reflect cached indexer data.

Common stable errors include `VALIDATION_FAILED`, `TOKEN_NOT_FOUND`, `PROFILE_NOT_FOUND`, `IDEMPOTENCY_KEY_REUSED`, `REQUEST_IN_PROGRESS`, `METADATA_UPLOAD_FAILED`, `RATE_LIMITED`, and `DEPENDENCY_UNAVAILABLE`.
