# Spawn API — Frontend Integration Guide

This guide covers the HTTP contract between the frontend and the Spawn backend.
The backend serves **offchain records** (token metadata, launch preparation, profiles,
comments) merged with **committed onchain projections** produced by the chain indexer.

Base URL: `/api/v1`. Swagger UI: `/api/docs`. OpenAPI JSON: `/api/openapi.json`.

## Conventions

- Success: `{ "data": T, "meta": {} }`; collections carry `meta: PageMeta`
  (`{ page, limit, total, totalPages, hasNext }`).
- Errors: `application/problem+json` with `{ type, title, status, detail?, code, requestId, errors? }`.
- Addresses/hashes: lowercase hex. Uniswap v4 `poolId` is a **bytes32 hex string** (66 chars), not an address.
- 256-bit integers and WAD fixed-points are **decimal strings** — never parse with JS `Number`.
- Timestamps: UTC ISO-8601.
- Reads are gated by the indexer watermark (`chain_watermarks.committedVersion`).
  Endpoints that depend on projections include the watermark and a `stale` boolean
  (`true` when the watermark is older than `CHAIN_STALE_AFTER_SECONDS`).
- `onchain: null` means "no committed projection yet", distinct from
  `onchain.phase === 'NONE'`.

### Levels, not ticks

All prices/geometry are **level space**: `level = -tick`, `price(token→ETH) = 1.0001^level`,
`FDV = totalSupply × 1.0001^level`. The backend converts once at the pool boundary; every
number the API returns (openingLevel, farLevel, graduationLevel, priceLevel, band
levelLower/levelUpper) is a **level** — it rises as the token pumps.

## Launch flow (the important one)

The on-chain launch is a signed EIP-712 configuration; **the creator signs, anyone relays**.
The recorded creator is always the recovered signer, never the relayer. The backend never
holds creator keys.

### 1. Prepare — `POST /api/v1/launch/prepare`

```jsonc
{
  "creatorWalletAddress": "0x…", // declared creator == EIP-712 signer
  "name": "My Token", // 1–80 chars, goes on-chain
  "symbol": "MTK", // 1–12 [A-Z0-9], goes on-chain
  "description": "…", // offchain metadata only
  "imageUri": "ipfs://…", // offchain metadata only (CIDv1)
  "socials": { "website": "https://…", "x": "https://…" }, // optional, offchain only
  "totalSupply": "1000000000000000000000000", // token-wei decimal string
  "devBuyShareWad": "0.05", // decimal; hard cap 0.1 (10% of supply)
  "payoutPlan": "1", // bitset of registry indices; bit i selects index i
  "deadline": 1900000000, // unix seconds for the signature
}
```

The backend validates the config (bounds + live registry state: ≤8 selected plugins, all
active `PAYOUT`-role entries, takes ≤ 100%), uploads metadata to IPFS, and returns:

```jsonc
{
  "launchId": "…",                    // use for relay + status
  "config": { … },                    // the exact fields that will be signed
  "configHash": "0x…",               // deadline-independent identity (CREATE2 salt input)
  "digest": "0x…",                   // what the creator signs
  "domain": { "name": "SpawnLaunchpad", "version": "1", "chainId": 8453, "verifyingContract": "<hook>" },
  "predictedToken": "0x…",           // deterministic token address, known before launch
  "openingLevel": -89876, "farLevel": -82945,
  "devBuyQuote": { "tokensOut": "…", "ethCost": "…", "suggestedMsgValueWithHeadroom": "…", "endLevel": -86188 },
  "signaturePayload": { "types": …, "primaryType": "LaunchConfig", "domain": …, "message": … }
}
```

Sign `signaturePayload` (EIP-712) with the creator wallet. Cross-check locally:
`hashTypedData(signaturePayload) === digest`.

Properties to lean on:

- **A relayer cannot alter any field** — any edit changes the digest and the protocol
  reverts with `CreatorMismatch`. Nothing to validate client-side.
- **Re-signing preserves the address** — `deadline` is signed but outside `configHash`;
  if the signature lapses, re-prepare with a fresh deadline and `predictedToken` is unchanged.
- **Dev buy** is creator-direct only (attach ETH to the launch tx). Relayed launches skip
  it (`DevBuySkipped`); the share stays curve inventory. `suggestedMsgValueWithHeadroom`
  already includes +5%; unused ETH refunds automatically.

### 2. Submit the launch

Either path is equivalent on-chain:

- **Backend relay** (optional): `POST /api/v1/launch/relay` with
  `{ "launchId": "…", "signature": "0x…" }` (65-byte hex) and an `Idempotency-Key` header.
  Returns `202 { launchId, state: "SUBMITTED", transactionHash, predictedToken, configHash }`.
  503 `RELAYER_DISABLED` when the relayer is not configured — then the frontend submits
  directly (below).
- **Creator self-send**: the frontend sends `MilestoneHook.launch(config, signature)`;
  attach `msg.value` for the dev buy (creator-direct). Idempotency-Key replays return
  `Idempotency-Replayed: true`.

### 3. Status — `GET /api/v1/launch/records/:launchId`

Returns the record plus `onchain` once the indexer observes the `Launched` event
(`{ tokenId, contractAddress, poolId, phase }`) — binding is by `configHash`.

## Tokens

- `POST /api/v1/tokens` — offchain-only token record (metadata + claimed creator) for
  pre-launch social/comment presence. Same idempotency contract as before
  (`Idempotency-Key` header; 409 `IDEMPOTENCY_KEY_REUSED` / `REQUEST_IN_PROGRESS`;
  503 `METADATA_UPLOAD_FAILED`).
- `GET /api/v1/tokens` — `q`, `creator`, `phase` (`NONE|BONDING_CURVE|GRADUATED`),
  `hasOnchainProjection`, `sort=newest|oldest|market_cap|volume|graduated|relevance`
  (`relevance` requires `q`), `timeframe=1h|24h|7d|30d|all`, `page`, `limit`, `chainId`.
- `GET /api/v1/tokens/featured` — top 3 by featured score (non-stale only).
- `GET /api/v1/tokens/:tokenRef` — full detail. `tokenRef` = token UUID **or** the
  on-chain token contract address. Includes `onchain` (see shape below), `metrics`
  per timeframe, `milestones` summary, first trades page, watermark, `stale`.
- `GET /api/v1/tokens/:tokenRef/trades` — `side=BUY|SELL`,
  `sort=newest|oldest|amount`, timeframe filter, paged.
- `GET /api/v1/tokens/:tokenRef/candles` — `interval=1m|5m|15m|1h|4h|1d`, optional
  `from`/`to`, `limit ≤ 1000`. OHLC is **in level space** (`open/high/low/close` are
  levels; convert to price client-side with `1.0001^level`), plus `volumeEth` (wei
  string, includes the 1% input fee) and `volumeUsd` when the oracle is configured.
- `GET /api/v1/tokens/:tokenRef/milestones` — `kind=CORE|EXTENSION`,
  `state=PENDING|DEPLOYED|SKIPPED|HARVESTED`. Geometry (`levelLower`, `levelUpper`)
  comes from `BandDeployed` events verbatim; harvest amounts are gross/service-fee/net
  with the `economicVersion` applied.
- `GET /api/v1/tokens/:tokenRef/revenue` — full value-flow ledger for the pool:
  accruals, claims, pot fundings/redeems, tips, plugin deliveries/carries/redirects,
  dev buys, graduation — filterable by `kind`.

### `onchain` shape (token detail / list items)

```jsonc
{
  "phase": "BONDING_CURVE", // NONE | BONDING_CURVE | GRADUATED
  "contractAddress": "0x…",
  "poolId": "0x…",
  "launchCreatorWallet": "0x…",
  "creatorRevenueOwner": "0x…", // current RevenueNFT holder (claim right)
  "totalSupply": "…",
  "currentSupply": "…", // wei; currentSupply falls on burns
  "openingLevel": -89876,
  "farLevel": -82945,
  "graduationLevel": null,
  "payoutPlan": "1",
  "devBuyShareWad": "0.05",
  "configHash": "0x…",
  "curvePositions": 32,
  "curveDeployed": 1,
  "coreBandCount": 30,
  "completedMilestones": 0,
  "completedExtensionMilestones": 0,
  "payoutPotWei": "0",
  "directCreatorClaimableWei": "0",
  "creatorPathClaimableWei": "0",
  "lastPriceLevel": -89876,
  "priceEthPerToken": "125.005771471429557958",
  "launchedAt": "…",
  "graduatedAt": null,
  "projectionVersion": "12345",
  "sourceBlockNumber": "12345",
  "sourceBlockTime": "…",
}
```

Semantics worth knowing:

- A pool **graduates** when the live level reaches `farLevel` (2× opening FDV);
  after graduation `graduationLevel` anchors the ladder: band `i` spans
  `[graduationLevel + (i+1)·2235, +447]`.
- `SKIPPED` milestones ("milestone bypassed") are normal protocol outcomes.
- Value flows: harvest = 10% service fee (cap 20%) to protocol + 90% to the pool's
  payout pot; quote fees = 75% creator / 25% protocol (cap 90%); token fees = 20% next
  band / 80% burn (100% burn at cap); graduation = 40/55/5; flush tip = 1% of a new pot.

## Trading reads

- `GET /api/v1/tokens/:tokenRef/price` — live `level`, `tick`, `sqrtPriceX96`,
  `priceEthPerToken`, `fdvEth` (wei), `fdvUsd` + `ethUsd` when the oracle is configured,
  and curve `progress` (0–1).
- `GET /api/v1/tokens/:tokenRef/quote?side=BUY|SELL&amount=…` — V4Quoter exact-input
  quote (`amount` = ETH-wei for BUY, token-wei for SELL). `gasEstimate` is informational
  only (real swaps pay for JIT deploys). 503 `QUOTER_NOT_CONFIGURED` when the manifest
  has no quoter address. Re-quote on submission errors instead of padding slippage.
- `GET /api/v1/tokens/:tokenRef/depth` — curve positions / ladder bands ahead of spot.

## Protocol

- `GET /api/v1/protocol/addresses` — the deployment-manifest address book (hook,
  launchSupport, revenueNft, registry, controller, poolManager, stateView, v4Quoter,
  multicall3, canonicalPayoutPlan). **Always take addresses from here**, never hardcode.
- `GET /api/v1/protocol/economics` — active `EconomicConfig` (version, service fee,
  quote creator share, token milestone fund share) with immutable caps.
- `GET /api/v1/protocol/plugins` — payout-plugin registry mirror (index, take, gas limit,
  role `INVALID|PAYOUT|CREATOR_SYSTEM|UTILITY`, suspended).
- `GET /api/v1/protocol/governance/operations` — scheduled/executed/cancelled controller ops.
- `GET /api/v1/protocol/revenue` — global protocol ledger totals + accrual/claim history.
- `GET /api/v1/protocol/watermark` — indexer head/committed version (staleness probe).

## Keepers

`GET /api/v1/keepers/jobs` — actionable jobs: `flush` (incentive = floor 1% of the new
pot; signal `payoutPot > 0 || carryBitmap ≠ 0`), `graduate` (level ≥ farLevel − 1),
`collectFees` (no on-chain incentive). All are safe to batch with Multicall3
(`aggregate3`, `allowFailure=false`); the response includes the `multicall3` address.
`claimCreatorPath` performs its own flush and pays the holder directly — no separate
flush needed on claim pages.

## Profiles & comments

Unchanged from the previous contract: `GET/PUT /profiles/:walletAddress` (patch-like PUT;
null clears), `GET /profiles/:walletAddress/tokens`, `GET /profiles/:walletAddress/portfolio`
(from on-chain holdings), comments CRUD with depth ≤ 3, tombstone deletion, likes.
Wallet attribution is self-declared and rate-limited; comments require an
`Idempotency-Key`.

## Stable error codes

`VALIDATION_FAILED`, `TOKEN_NOT_FOUND`, `PROFILE_NOT_FOUND`, `IDEMPOTENCY_KEY_REUSED`,
`REQUEST_IN_PROGRESS`, `METADATA_UPLOAD_FAILED`, `RATE_LIMITED`,
`DEPENDENCY_UNAVAILABLE`, `RELEVANCE_REQUIRES_QUERY`, `INVALID_CANDLE_RANGE`,
`USERNAME_TAKEN`, `COMMENT_*`, `INVALID_WALLET_ADDRESS`, `INVALID_IDEMPOTENCY_KEY`,
`PROTOCOL_NOT_DEPLOYED`, `RELAYER_DISABLED`, `LAUNCH_RECORD_NOT_FOUND`,
`LAUNCH_BROADCAST_FAILED`, `PAYOUT_PLAN_TOO_MANY_PLUGINS`,
`PAYOUT_PLAN_ENTRY_SUSPENDED`, `PAYOUT_PLAN_ENTRY_NOT_SELECTABLE`,
`PAYOUT_TAKES_ABOVE_WAD`, `DEV_BUY_ABOVE_CAP`, `OPENING_LEVEL_OUT_OF_RANGE`,
`FAR_LEVEL_OUT_OF_RANGE`, `QUOTER_NOT_CONFIGURED`, `MANIFEST_NOT_SYNCED`,
`WATERMARK_NOT_FOUND`, `ECONOMICS_NOT_AVAILABLE`.
