# Spawn API — Frontend Integration Guide (complete reference)

Base URL: **`/api/v1`** · Swagger UI: `/api/docs` · OpenAPI JSON: `/api/openapi.json`

This document covers every route with its parameters, request body, response
shape, status codes and semantics, plus the conventions that apply everywhere.

---

## 1. Global conventions

| Convention                                            | Rule                                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------- |
| Success envelope                                      | `{ "data": ..., "meta": ... }` (collections carry `PageMeta`)             |
| Errors                                                | RFC-7807 `application/problem+json` — see §13                             |
| Addresses                                             | `0x` + 40 hex, **lowercase**                                              |
| `poolId`                                              | `0x` + 64 hex (bytes32). NOT an address                                   |
| Hashes (`transactionHash`, `configHash`, `codeHash`)  | lowercase hex strings                                                     |
| 256-bit values (amounts, supply, prices-wei, bitsets) | **decimal strings** — never parse with JS `Number`                        |
| WAD shares (`takeWad`, `devBuyShareWad`, economics)   | fixed-point strings like `"0.05"` (18 implied decimals)                   |
| Timestamps                                            | UTC ISO-8601 (`2026-09-12T20:15:04.000Z`)                                 |
| Amount units                                          | **raw wei units everywhere** — divide by `10^18` at the display edge only |
| Token decimals                                        | fixed at 18 for every launch token                                        |

`PageMeta`: `{ "page": 1, "limit": 20, "total": 57, "totalPages": 3, "hasNext": true }`.

### 1.1 Identifier types (`:tokenRef`)

Every `:tokenRef` accepts **any one of**:

1. the offchain token UUID (`launch/prepare` returns it once bound; comment anchors),
2. the **token contract address** (`0x…`, 42 chars),
3. the **poolId** (`0x…`, 66 chars).

`launchId` (`:launchId`) is always the UUID returned by `launch/prepare`.

### 1.2 Staleness

Projection-backed endpoints may include `"stale": true` — the indexer watermark is
older than `CHAIN_STALE_AFTER_SECONDS` (default 30s). `featured` returns `data: []`
while stale (never show cards you can't verify). `GET /protocol/watermark` exposes
the raw numbers.

### 1.3 Price orientation — read this twice

The protocol quotes everything in **level space**: `level = -tick` and rises as the
token pumps. The pool's raw v4 price is **token-per-ETH**; the human price
(ETH per token) is its inverse:

```
priceETH(token) = 2^192 / sqrtPriceX96^2        // raw wei units
FDV_ETH        = totalSupply × 2^192 / sqrtPriceX96^2
```

Consequence for charts: **the highest ETH price corresponds to the LOWEST
sqrtPriceX96**. Candle/aggregate rows are stored on the raw sqrt axis; the API
returns both, already converted where named `*Eth` (§7).

---

## 2. Tokens — registration & listing

### 2.1 `POST /api/v1/tokens` — `createToken`

Creates the **offchain record** (metadata + IPFS upload + socials) so a token page,
comments and the creator's profile exist before/on top of the onchain launch.
This does NOT launch anything — see §3 for launch.

Header: **`Idempotency-Key`** (required, 1–128 printable chars). Reused key + same
body → the original response with header `Idempotency-Replayed: true` (HTTP 201 again).
Reused key + different body → `409 IDEMPOTENCY_KEY_REUSED`. In-flight duplicate → `409 REQUEST_IN_PROGRESS`.

Request:

```jsonc
{
  "creatorWalletAddress": "0xf3…", // becomes pool creator + first RevenueNFT holder
  "name": "My Token", // 1–80 code points, goes on-chain
  "symbol": "MTK", // ^[A-Z0-9]{1,12}$, goes on-chain
  "description": "…", // 5–100 words, offchain
  "imageUri": "ipfs://bafk…", // canonical ipfs:// CIDv1
  "socials": { "website": "https://…", "x": "https://x.com/…", "telegram": "…", "discord": "…" }, // all https, optional
}
```

`201` response (`Location` header set):

```jsonc
{
  "data": {
    "tokenId": "9b2f…-uuid",
    "chainId": 8453,
    "name": "My Token", "symbol": "MTK", "description": "…",
    "claimedCreatorWallet": "0xf3…",
    "imageUri": "ipfs://bafk…",
    "socials": { … } | null,
    "ipfsUri": "ipfs://bafk…",             // uploaded metadata JSON
    "gatewayUrl": "https://…",
    "contractAddress": null,               // filled when the pool launches & binds
    "createdAt": "2026-09-12T20:15:04.000Z"
  },
  "meta": {}
}
```

`503 METADATA_UPLOAD_FAILED` (nothing persisted) · `400 VALIDATION_FAILED` with `errors[]`.

### 2.2 `GET /api/v1/tokens` — `listTokens`

| Query     | Values                                                          | Default  |
| --------- | --------------------------------------------------------------- | -------- |
| `q`       | search over name/symbol (trigram/FTS ranked)                    | —        |
| `creator` | wallet address filter                                           | —        |
| `phase`   | `bonding` \| `graduated`                                        | —        |
| `sort`    | `newest` \| `oldest` \| `market_cap` \| `volume` \| `graduated` | `newest` |
| `page`    | ≥1                                                              | 1        |
| `limit`   | 1–100                                                           | 20       |
| `chainId` | ≥1                                                              | 8453     |

`market_cap` sorts by `mcap_wei` (circulating × price, ETH-wei); `volume` by
`buy_volume_eth + sell_volume_eth`; `graduated` puts graduated pools first.
Both sorts use committed values only.

Item shape (grid/card):

```jsonc
{
  "poolId": "0x…", "chainId": 8453,
  "status": "bonding" | "graduated",
  "token": "0x…", "creator": "0x…",
  "name": "My Token", "symbol": "MTK",
  "launchTime": "…",
  "totalSupply": "1000000000000000000000000000",       // raw wei string
  "circulatingSupply": "1000000000000000000000000000", // total − burned
  "priceEth": "0.000000000000000125",                  // ETH per whole token (18-dec string)
  "fdvEthWei": "1250000000000000000",                  // totalSupply × price (wei)
  "mcapEthWei": "1250000000000000000",                 // circulating × price (wei)
  "athMcapEthWei": "…",
  "buyVolumeEth": "…", "sellVolumeEth": "…", "swapCount": "…",
  "creatorRevenueTotal": "…", "protocolRevenueTotal": "…"
}
```

### 2.3 `GET /api/v1/tokens/featured` — `getFeaturedTokens`

Query: `chainId` (optional). Top 3 pools by trailing-24h volume from the
`leaderboard_daily` materialized view (refreshed every 30s). Empty array when stale
or pre-launch. Item: `{ pool_id, token, creator, status, name, symbol,
daily_volume_eth, total_volume_eth }` (raw wei strings).

### 2.4 `GET /api/v1/tokens/{tokenRef}` — `getToken`

Query: `chainId`, `tradePage`, `tradeLimit` (first trades page embedded).

Full detail:

```jsonc
{
  "poolId": "0x…", "chainId": 8453, "status": "bonding",
  "token": "0x…", "creator": "0x…",
  "name": "My Token", "symbol": "MTK",
  "description": "…", "imageUri": "ipfs://…", "uri": "https://…",   // uri = on-chain tokenURI
  "socials": { … } | null,
  "launchTime": "…",
  "totalSupply": "1e27-wei-string", "circulatingSupply": "…",
  "configHash": "0x…", "payoutPlan": "1",            // decimal-string bitset
  "devBuyShareWad": "0.05",
  "openingLevel": -200000, "farLevel": -186138, "graduationLevel": null,
  "wallLiquidity": null,                             // wei string, set at graduation
  "revenueNftOwner": "0x…",                          // current stream holder
  "priceEth": "…",
  "launchRecord": { "id": "…", "state": "CONFIRMED", "transactionHash": "0x…" } | null,
  "stats": {                                          // full pool_stats rollup, wei strings
    "buyVolumeEth": "…", "sellVolumeEth": "…", "buyVolumeTokens": "…", "sellVolumeTokens": "…",
    "swapCount": "…", "lastPriceSqrtX96": "…", "athSqrtX96": "…",
    "creatorRevenueTotal": "…", "creatorRevenueCurve": "…", "creatorRevenueSwapFees": "…",
    "protocolRevenueTotal": "…", "protocolRevenueCurve": "…", "protocolRevenueSwapFees": "…",
    "protocolRevenueHarvest": "…", "creatorPathRevenueTotal": "…", "pluginRevenueTotal": "…",
    "potFundedTotal": "…", "tipsTotal": "…", "bandsDeployed": 3, "harvestCount": 2,
    "harvestQuoteTotal": "…", "swapFeeBurnedTokens": "…", "burnedTotal": "…",
    "lastSwapBlock": "…"
  } | null,
  "pot": { "balance": "…", "fundedTotal": "…", "serviceFeeTotal": "…" },
  "milestones": { "live": 1, "completed": 2 },
  "trades": { "data": [ /* recent trades, §4 */ ], "meta": { … } },
  "stale": false
}
```

---

## 3. Launch flow

**Protocol model (current):** creators never sign. The backend operates the
protocol's on-chain **`trustedOperator`** key which signs each relayed
`LaunchConfig`; the creator wallet is declared in the config and receives the
RevenueNFT. Total supply is **pinned to 1,000,000,000e18** — any other value
400s with `SUPPLY_NOT_FIXED` (the chain reverts the same way, `SupplyNotFixed`).

### 3.1 `POST /api/v1/launch/prepare` — `prepareLaunch`

Validates everything, uploads metadata (the uploaded JSON URL becomes the
on-chain token `uri`), predicts the CREATE2 token address, computes the digest,
and quotes the optional dev buy. Persists a launch record. Rate-limited like
token creation.

```jsonc
// request
{
  "creatorWalletAddress": "0xf3…",
  "name": "My Token", "symbol": "MTK",
  "description": "…", "imageUri": "ipfs://…",
  "socials": { … },                       // optional
  "totalSupply": "1000000000000000000000000000",  // MUST equal 1e27 (pinned)
  "devBuyShareWad": "0",                  // decimal ≤ 0.1 — relayed launches skip dev buy
  "payoutPlan": "1",                      // decimal-string bitset; bit i = registry index i
  "deadline": 1900000000                  // unix seconds (signature freshness)
}
```

```jsonc
// 201 response
{
  "data": {
    "launchId": "3f2e…-uuid",
    "chainId": 8453,
    "config": { "creator": "0x…", "name": "…", "symbol": "…", "uri": "https://…",
                "totalSupply": "1000000000000000000000000000", "devBuyShareWad": "0",
                "payoutPlan": "1", "deadline": 1900000000 },
    "configHash": "0x…",                  // deadline-free identity = CREATE2 salt input
    "digest": "0x…",                       // EIP-712 digest the operator signs
    "domain": { "name": "SpawnLaunchpad", "version": "1", "chainId": 8453,
                "verifyingContract": "<hook>" },
    "predictedToken": "0x…",              // knowable-before-launch token address
    "openingLevel": -200000,
    "farLevel": -186138,
    "devBuyQuote": {                        // null unless devBuyShareWad > 0
      "tokensOut": "…", "ethCost": "…",
      "suggestedMsgValueWithHeadroom": "…",  // ethCost × 1.05
      "endLevel": -190000
    } | null,
    "metadata": { "ipfsUri": "ipfs://…", "gatewayUrl": "https://…" },
    "signatureNote": "The backend trusted operator signs…",
    "signaturePayload": { /* exact EIP-712 typed data, incl. uri field */ }
  }
}
```

Validation errors (all `400`): `SUPPLY_NOT_FIXED`, `DEV_BUY_ABOVE_CAP`,
`PAYOUT_PLAN_TOO_MANY_PLUGINS` (>8 bits), `PAYOUT_PLAN_ENTRY_SUSPENDED`,
`PAYOUT_PLAN_ENTRY_NOT_SELECTABLE` (non-PAYOUT role), `PAYOUT_TAKES_ABOVE_WAD`,
`OPENING_LEVEL_OUT_OF_RANGE`. `503`: `PROTOCOL_NOT_DEPLOYED`, `METADATA_UPLOAD_FAILED`.

Properties to lean on:

- A tampered config changes `digest` and the chain reverts — validate nothing client-side.
- **Re-signing never moves the address**: `deadline` is signed but outside `configHash`;
  if a deadline lapses, re-prepare and `predictedToken` is identical.
- `payoutPlan: "0"` is valid (everything to the creator path). Canonical plan = bit 0
  (buyback-and-burn, take `2WAD/9`).

### 3.2 `POST /api/v1/launch/relay` — `relayLaunch`

Header **`Idempotency-Key`** required.

```jsonc
// request: just the launch id
{ "launchId": "3f2e…-uuid" }
```

`202` — operator signs the config and broadcasts `MilestoneHook.launch(config,
signature)` (no value attached; relayed launches skip the dev buy):

```jsonc
{
  "data": {
    "launchId": "…",
    "state": "SUBMITTED",
    "transactionHash": "0x…",
    "predictedToken": "0x…",
    "configHash": "0x…",
  },
}
```

Errors: `404 LAUNCH_RECORD_NOT_FOUND` · `409 IDEMPOTENCY_KEY_REUSED` /
`REQUEST_IN_PROGRESS` · `503 OPERATOR_NOT_CONFIGURED` (no key provisioned) ·
`503 RELAY_DISABLED` (on-chain `trustedOperator` is zero — monitor
`/protocol/watermark`) · `502 LAUNCH_BROADCAST_FAILED` (revert reason in
`failureReason` after `GET record`).

**Direct creator launches** remain possible without the backend: the creator calls
`MilestoneHook.launch(config, "0x")` themselves with `msg.value` =
`devBuyQuote.suggestedMsgValueWithHeadroom` (unused ETH auto-refunds; emits
`DevBuyExecuted`). The indexer binds either path identically via `configHash`.

### 3.3 `GET /api/v1/launch/records/{launchId}` — `getLaunchRecord`

```jsonc
{
  "data": {
    "launchId": "…", "chainId": 8453, "creatorWallet": "0x…",
    "name": "…", "symbol": "…", "uri": "…",
    "totalSupply": "…", "devBuyShareWad": "…", "payoutPlan": "…", "deadline": "…",
    "configHash": "0x…", "predictedToken": "0x…", "digest": "0x…",
    "state": "PENDING_RELAY" | "SUBMITTED" | "CONFIRMED" | "REORGED" | "FAILED",
    "transactionHash": "0x…" | null,
    "blockNumber": "…" | null,
    "failureReason": "…" | null,
    "createdAt": "…",
    "onchain": { "token": "0x…", "poolId": "0x…", "status": "bonding" } | null
  }
}
```

`onchain` appears once the indexer has observed the pool's `Launched` event
(bind by `configHash`) — poll this endpoint or watch `bar`/`tick` silence +
`spawn_pools` WS messages.

### 3.4 `GET /api/v1/launch/records` — `listLaunchRecords`

Query: `creator` (address), `state`, `chainId`, `page`, `limit` (≤100).
Paginated array of the same record shape (`onchain: null` in list view).

---

## 4. Trade tape — `GET /api/v1/tokens/{tokenRef}/trades` — `listTokenTrades`

Query: `side` (`BUY`|`SELL`), `sort` (`newest`|`oldest`|`amount`), `page`, `limit` (≤100), `chainId`.

Semantics: a **buy** means ETH in, token out (`amount0 < 0` on-chain). Stored
amounts are **absolute**; `side` carries direction; volumes **include the 1%
input-side fee** (a buy's `ethAmount` = ETH paid incl. fee; `feeEth` is the
realized fee slice).

```jsonc
{
  "transactionHash": "0x…",
  "logIndex": 12,
  "blockNumber": "18000001",
  "timestamp": "…",
  "side": "BUY",
  "sender": "0x…", // swap caller (router EOA/contract)
  "ethAmount": "250000000000000000", // wei
  "tokenAmount": "5929000000000000000000", // raw 18-dec
  "sqrtPriceX96": "688…", // raw
  "level": 190011, // -tick
  "priceEth": "0.000000000000000131",
  "feePips": 10000,
  "feeEth": "2500000000000000",
  "feeTokens": "0",
}
```

Cache: 2s TTL — treat as a pollable tape; use the WS `tick` stream (§11) for realtime.

---

## 5. Milestone ladder — `GET /api/v1/tokens/{tokenRef}/milestones` — `listTokenMilestones`

Query: `page`, `limit` (≤100), `chainId`.

For bonding pools: empty list + `meta.total: 0` (the ladder begins at graduation).
For graduated pools: the **full expected ladder** — 22 core bands + up to 30
fee-funded extensions — with state:

| `state`     | Meaning                                             |
| ----------- | --------------------------------------------------- |
| `PENDING`   | geometry computed, never deployed yet               |
| `DEPLOYED`  | live one-sided sell band                            |
| `SKIPPED`   | price jumped past it — "milestone bypassed", normal |
| `HARVESTED` | crossed and burned into the payout pot              |

```jsonc
{
  "index": 0, "kind": "CORE" | "EXTENSION",
  "state": "DEPLOYED",
  "levelLower": -180468, "levelUpper": -180021,   // levels (from events when deployed)
  "liquidity": "…", "tokenInventory": "…",         // raw strings; null = not deployed
  "deployedAt": "…", "completedAt": "…" | null
}
```

Ladder geometry (decaying steps): band i+1 starts `max(2235, 6932 − 391·i)` levels
above band i (first step **2×** the graduation FDV, locking at **1.2504×**), each
band 447 levels wide. Top core band ≈ **2,900×** graduation (~$58M FDV @ $2,500 ETH ref).

---

## 6. Per-pool revenue — `GET /api/v1/tokens/{tokenRef}/revenue` — `listTokenRevenueEvents`

Query: `kind` (default `creatorAccruals`), `page`, `limit`, `chainId`. One of:

`creatorAccruals` · `protocolAccruals` · `creatorPathAccruals` · `claims` ·
`payoutTips` · `pluginPayouts` · `potFundings` · `potRedemptions` ·
`feeCollections` · `feeRoutings` · `tokenBurns` · `graduates`

Each is the insert-only fact row (exact event columns as JSON, lowercase addresses,
raw-wei numbers as strings, plus `transactionHash`, `logIndex`, `blockNumber`,
`timestamp`, `ordinalKey`).

> **Double-count warning (protocol design):** revenue **sums** must use
> `creatorAccruals` + `protocolAccruals` (+ `claims` for payouts). `graduates`,
> `feeRoutings`, `potFundings` carry amounts as audit detail — never add them with
> accruals. `payoutPlan` attribution per plugin: decode bits against
> `/protocol/plugins` (index = bit).

---

## 7. Candles — `GET /api/v1/tokens/{tokenRef}/candles` — `listTokenCandles`

Query: `interval` ∈ `1m | 5m | 15m | 1h | 4h | 1d` (default `1h`), `from`, `to`
(ISO), `limit` ≤ 1000 (default 500), `chainId`.

Rows ascending by time; zero-trade buckets return **no row** (render flat client-side —
do not server-fill gaps for large ranges):

```jsonc
{
  "time": "2026-09-12T20:15:00.000Z",
  "openEth": "0.0004201…",
  "closeEth": "0.0004217…",
  "highEth": "0.0004230…",
  "lowEth": "0.0004195…", // ETH per token, converted
  "openSqrtX96": "…",
  "highSqrtX96": "…",
  "lowSqrtX96": "…",
  "closeSqrtX96": "…",
  "buyVolumeEth": "…",
  "sellVolumeEth": "…",
  "swapCount": "37",
}
```

The raw sqrt axis is monotone-decreasing in price, so `highEth` derives from
`lowSqrtX96` — the conversion is done for you; use the `*SqrtX96` fields when you
need bit-exact recomputation.

**Sub-minute** (5s/10s/15s) is **not served**: build client-side from WS `tick`s (§11).
Arbitrary windows (e.g. 2h) = pull `1m` rows and aggregate client-side.

---

## 8. Price / quote / depth

### 8.1 `GET /api/v1/tokens/{tokenRef}/price` — `getTokenPrice`

```jsonc
{
  "poolId": "0x…", "chainId": 8453, "token": "0x…", "status": "bonding",
  "level": -198765, "tick": 198765, "sqrtPriceX96": "…",
  "priceEth": "0.000000000000000126",
  "fdvEthWei": "…", "mcapEthWei": "…",          // total vs circulating
  "athPriceEth": "…" | null,
  "openingLevel": -200000, "farLevel": -186138, "graduationLevel": null,
  "progress": 0.093,                              // curve completion 0–1; 1 = graduated
  "source": "live" | "indexer" | "opening"
}
```

`source: live` = fresh `StateView.getSlot0`; `indexer` = last indexed swap price;
`opening` = template anchor before any trade.

### 8.2 `GET /api/v1/tokens/{tokenRef}/quote` — `quoteTokenSwap`

Query (required): `side` = `BUY` | `SELL`, `amount` = decimal string raw wei
(BUY: ETH in; SELL: token in), `chainId`.

```jsonc
{
  "poolId": "…",
  "side": "BUY",
  "amountIn": "250000000000000000",
  "amountInCurrency": "ETH",
  "amountOut": "1894000000000000000000",
  "amountOutCurrency": "TOKEN",
  "gasEstimate": "412000",
  "note": "Quote runs the hook beforeSwap simulation (JIT curve/band deploys included). Gas estimates from a quote are not real-swap gas; re-quote on submission errors.",
}
```

Runs `V4Quoter.quoteExactInputSingle` against the hook pool. 404 `QUOTER_NOT_CONFIGURED`
when the manifest has no quoter. **Bounded buys near graduation**: the pool has no
liquidity above `farLevel` until graduation — an unbounded buy sweeps to the extreme;
show "graduation on next trade" when `level >= farLevel − 1` and route the trade
through a deliberate `graduate()` first.

### 8.3 `GET /api/v1/tokens/{tokenRef}/depth` — `getTokenDepth`

Query: `buckets` 1–32 (default 8), `chainId`. For **bonding** pools the response
carries `curvePositions: [{ position, startLevel, endLevel, liquidity }]` (positions
deploy JIT as buys approach them). For graduated pools it carries live **bands** above
spot + the two locked positions:

```jsonc
{
  "poolId": "…",
  "status": "graduated",
  "level": -180000,
  "graduationLevel": -186138,
  "bands": [
    {
      "index": 1,
      "levelLower": -179527,
      "levelUpper": -179080,
      "liquidity": "…",
      "tokenInventory": "…",
    },
  ],
  "fullRange": { "liquidity": "…", "tickLower": 28135, "tickUpper": 200114 },
  "wall": { "liquidity": "…", "levelLower": -186137, "levelUpper": 693863 },
}
```

The full-range is ETH-limited over an ~$5,100→$150B FDV band (hard price floor at
the bottom bound); the wall is token-only backing across 880,000 levels above
graduation — treat as deep inventory that sells only a thin layer per price move.

---

## 9. Protocol (chain state)

### 9.1 `GET /api/v1/protocol/addresses` — `getProtocolAddresses`

The **only** source of contract addresses (never hardcode): `hook`,
`launchSupport`, `revenueNft`, `payoutPluginRegistry`, `protocolController`,
`buybackAndBurnPlugin`, `poolManager`, `stateView`, `v4Quoter`, `multicall3`,
`canonicalPayoutPlan`, `hookSalt` (optional ones may be `null`). 404 `MANIFEST_NOT_SYNCED`.

### 9.2 `GET /api/v1/protocol/economics` — `getEconomicConfig`

Active tuple + version history + immutable caps. Fields:
`version`, `harvestServiceFeeWad` (def `0.1`, cap `0.2`),
`quoteCreatorShareWad` (def `0.75`, cap `0.9`),
`tokenMilestoneFundShareWad` (def **`1.0`**, cap `1.0`), `effectiveBlock/At`,
`history[]`, `source: indexer|live`. Pre-indexing and RPC-down: 404 `ECONOMICS_NOT_AVAILABLE`.

### 9.3 `GET /api/v1/protocol/plugins` — `listPayoutPlugins`

Registry mirror: `{ registryIndex, plugin, takeWad, gasLimit, codeHash,
role: INVALID|PAYOUT|CREATOR_SYSTEM|UTILITY, suspended, registeredAtBlock }`.
Decode a pool's `payoutPlan` bitset against `registryIndex` for attribution
(launch validation: ≤8 bits, only unsuspended `PAYOUT` entries, takes ≤ 1.0).

### 9.4 `GET /api/v1/protocol/governance` — `getGovernance`

Query `status` filter (`SCHEDULED|EXECUTED|CANCELLED`). Response:
`state: { economicVersion, protocolRecipient, trustedOperator,
trustedOperatorSetBlock, administrator, pendingAdministrator,
governanceDelaySeconds }` + `operations[]` (`operationId, action, status,
readyAt, executedAtBlock, cancelledAtBlock, blockTime`). Actions include
`SET_TRUSTED_OPERATOR` (rotation path) — monitor `trustedOperator` going zero
(relay disabled).

### 9.5 `GET /api/v1/protocol/revenue` — `getProtocolRevenue`

Global ledger: `totals { accrued, curve, swapFees, harvestFees, claimed }`,
`live { protocolClaimable, protocolClaimBacked }` (null without RPC),
`accruals[]` (200 newest, per-pool with `poolId`, `source`,
`economicVersion`), `claims[]`.

### 9.6 `GET /api/v1/protocol/revenue/history` — `getRevenueHistory`

Query: `kind` (`creator|protocol|claims|tips|pluginPayouts|pots`), `poolId`, `limit` (≤500).

### 9.7 `GET /api/v1/protocol/stats` — `getProtocolStats`

`daily[]` (60 newest days: `day, buyVolumeEth, sellVolumeEth, swapCount,
creatorRevenueEth, protocolRevenueEth, harvestFeesEth, graduationCount, launchCount`)

- `leaderboard[]` (top 20 by `daily_volume_eth` from the matview).

### 9.8 `GET /api/v1/protocol/watermark` — `getChainWatermark`

`{ committedVersion, blockNumber, blockHash, blockTime, lastIndexedBlock,
trustedOperator }`. 404 `WATERMARK_NOT_FOUND` before first commit. Poll `blockTime`
for freshness; `trustedOperator === 0x0…0` ⇒ relay disabled.

---

## 10. Keepers — `GET /api/v1/keepers/jobs` — `listKeeperJobs`

Query: `kind` (`flush|graduate|collectFees`), `limit`, `chainId`.

```jsonc
{ "data": { "chainId": 8453, "jobs": [ {
    "kind": "flush", "poolId": "0x…",
    "call": { "to": "<hook>", "function": "flushTo(bytes32,address)", "args": ["0x…","<tipTo>"] },
    "incentiveWei": "12340000000000000",    // floor 1% of the pot (new pots only)
    "signal": { "potBalanceWei": "1234000000000000000" }
  } ], "multicall3": "0xcA11…", "batchingNote": "flushTo routes the 1% tip to an explicit recipient… } }
```

| Job           | Signal                                                     | Call                                                  | Note                                                          |
| ------------- | ---------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------- |
| `flush`       | `pot.balance > 0` (carry needs `carryBitmap(poolId)` view) | `flushTo(poolId, tipTo)` / `flushBatch(pools, tipTo)` | tip recipient = keeper-controlled EOA/contract with receive() |
| `graduate`    | bonding && `level ≥ farLevel − 1`                          | `graduate(key)`                                       | permissionless, idempotent (2nd call reverts, no change)      |
| `collectFees` | swaps since last `FeesCollected`                           | `collectFees(key)`                                    | no incentive; zero-accrual is a silent no-op                  |

Zero-amount claims and empty flushes are **no-op successes**, so Multicall3
`aggregate3.allowFailure = false` batching is safe; gate each call on its signal.
Worst-case gas: `hook.flushGasCeiling(poolId)` / `flushBatchGasCeiling` /
`creatorPathGasCeiling(pools)` views. Creator dashboards: `claimCreatorPath(poolId)`
self-flushes (tip retained in the payout); one holder, many pools →
`claimCreatorPathBatch(pools)` (reverts if any ownership changed mid-flight).
`claimCreatorPath` returns `(success, attemptedAmount)`; `success == false` = the
recipient rejected the ETH transfer and the entitlement was **restored**, not lost.

---

## 11. Live streaming (WS broadcaster)

Endpoint: **`ws://<host>:<BROADCASTER_WS_PORT default 3001>/ws`** — optionally
`?pool=0x<POLIID>` to subscribe to one pool (server also routes pool-scoped
messages only to matching sockets; subscribe-less sockets see everything).

Messages (all JSON, values as strings/numbers per §1):

```jsonc
{ "type": "tick", "pool": "0x…", "isBuy": true,
  "priceEth": "0.0004217",          // 2^192/sqrt², converted server-side
  "sqrt": "688…", "eth": "250000000000000000", "tokens": "5929…",
  "ts": 1757001234, "block": 1800123, "tx": "0x…" }

{ "type": "bar", "interval": "1m", "pool": "0x…", "start": 1757001200,
  "open": "0.0004201", "high": "0.0004230", "low": "0.0004195",
  "close": "0.0004217", "volEth": "1.834", "trades": 37 }

{ "type": "bar_close", … }           // same fields, final bar of the minute

{ "type": "pool", … }                // launch/graduation status events
```

Client contract:

- Feed `series.update()` per message (the chart lib merges into the live candle) —
  no diffing, no polling.
- WS is at-most-once. **On reconnect: REST refetch** (`candles?interval=1m&limit=50`)
  and `series.update()` the splice, then resume. Postgres is the source of truth;
  the stream is delivery.
- The bar uses the sink's own algebra (open first, close last, high = min-sqrt ETH,
  low = max-sqrt ETH, volume/counts add).
- Indexer runs with confirmation depth ⇒ reorgs never reach the stream (Base
  finality). Nothing below 1m is stored server-side — sub-minute bars are built
  client-side from `tick`.

---

## 12. Profiles & comments

Wallet attribution is **self-declared** (no signature auth) and rate-limited; every
mutating comment/profile call also enforces per-IP and per-wallet limits
(`429 RATE_LIMITED` with `Retry-After`).

### 12.1 `GET /api/v1/profiles/{walletAddress}` — `getProfile`

`404 PROFILE_NOT_FOUND` otherwise. `data: { walletAddress, username, bio, imageUri, createdAt }`.

### 12.2 `PUT /api/v1/profiles/{walletAddress}` — `updateProfile`

Patch-like PUT; omitted = unchanged, explicit `null` clears:

```jsonc
{
  "username": "sparky", // 3–32 [A-Za-z0-9_], unique case-insensitive
  "bio": "…", // ≤ 300 code points
  "imageUri": "ipfs://…",
}
```

`409 USERNAME_TAKEN` on collision.

### 12.3 `GET /api/v1/profiles/{walletAddress}/tokens` — `listProfileTokens`

Pools where the wallet is creator (or launched through the backend). Query:
`sort` (`newest|oldest`), pagination, `chainId`. Item: `{ poolId, token, name,
symbol, status, launchTime, imageUri }`.

### 12.4 `GET /api/v1/profiles/{walletAddress}/revenue-streams` — `getProfileRevenueStreams`

RevenueNFTs currently held: `{ pool_id, status, token, name, symbol,
creator_revenue_total, creator_path_revenue_total, launch_time }` (wei strings —
lifetime totals; claimable balances come from chain views: `creatorClaimable`,
`creatorPathClaimable`, `claimCreatorPath` handles flushing).

### 12.5 Comments

| Route                                                 | Notes                                                                                                                                                                                                                                     |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /tokens/{tokenRef}/comments`                    | body `{ walletAddress, text (1–2000 cp), parentCommentId? }` + `Idempotency-Key`; depth ≤ 3 (`409 COMMENT_MAX_DEPTH`); parent must exist on same token (`404 COMMENT_PARENT_NOT_FOUND`) and not be deleted (`409 COMMENT_PARENT_DELETED`) |
| `GET /tokens/{tokenRef}/comments`                     | `sort` (`newest                                                                                                                                                                                                                           | top | oldest`), `page`, `limit`; roots with author + first 3 replies |
| `GET /comments/{id}/replies`                          | paged, chronological                                                                                                                                                                                                                      |
| `DELETE /comments/{id}?walletAddress=`                | author-only tombstone (`404 COMMENT_NOT_FOUND`); idempotent; likes/replies on tombstones rejected                                                                                                                                         |
| `GET/PUT/DELETE /comments/{id}/likes/{walletAddress}` | `PUT` idempotent like, `DELETE` unlike; `data: { commentId, walletAddress, liked, likeCount }`                                                                                                                                            |

List items carry the current cache generation implicitly (no client work needed).

---

## 13. Error catalog

All errors: HTTP status + `application/problem+json`
`{ type, title, status, detail?, instance, code, requestId, errors? }`.

| Code                                                                                                                                                                                                                         | Status | Meaning                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------- |
| `VALIDATION_FAILED`                                                                                                                                                                                                          | 400    | DTO validation (`errors[]` per field)                         |
| `INVALID_WALLET_ADDRESS` / `INVALID_IDEMPOTENCY_KEY`                                                                                                                                                                         | 400    | format                                                        |
| `RELEVANCE_REQUIRES_QUERY`                                                                                                                                                                                                   | 400    | sort needs `q`                                                |
| `SUPPLY_NOT_FIXED`                                                                                                                                                                                                           | 400    | totalSupply ≠ 1e27                                            |
| `DEV_BUY_ABOVE_CAP`                                                                                                                                                                                                          | 400    | > 0.1 WAD                                                     |
| `PAYOUT_PLAN_TOO_MANY_PLUGINS` / `PAYOUT_PLAN_ENTRY_SUSPENDED` / `PAYOUT_PLAN_ENTRY_NOT_SELECTABLE` / `PAYOUT_TAKES_ABOVE_WAD`                                                                                               | 400    | launch plan rules                                             |
| `OPENING_LEVEL_OUT_OF_RANGE`                                                                                                                                                                                                 | 400    | supply vs tick space                                          |
| `INVALID_CANDLE_RANGE` / `INVALID_REVENUE_KIND`                                                                                                                                                                              | 400    | query validation                                              |
| `TOKEN_NOT_FOUND` / `PROFILE_NOT_FOUND` / `COMMENT_NOT_FOUND` / `COMMENT_PARENT_NOT_FOUND` / `LAUNCH_RECORD_NOT_FOUND` / `MANIFEST_NOT_SYNCED` / `ECONOMICS_NOT_AVAILABLE` / `WATERMARK_NOT_FOUND` / `QUOTER_NOT_CONFIGURED` | 404    | not found / not provisioned                                   |
| `IDEMPOTENCY_KEY_REUSED` (different body) / `REQUEST_IN_PROGRESS` (same key in flight) / `USERNAME_TAKEN` / `COMMENT_PARENT_DELETED` / `COMMENT_MAX_DEPTH`                                                                   | 409    | conflicts                                                     |
| `RATE_LIMITED`                                                                                                                                                                                                               | 429    | with `Retry-After`; per-IP and per-wallet policies            |
| `METADATA_UPLOAD_FAILED` / `PROTOCOL_NOT_DEPLOYED` / `OPERATOR_NOT_CONFIGURED` / `RELAY_DISABLED` / `DEPENDENCY_UNAVAILABLE`                                                                                                 | 503    | upstream/ops not ready — safe to retry                        |
| `LAUNCH_BROADCAST_FAILED`                                                                                                                                                                                                    | 502    | relayer submission failed (see `failureReason` on the record) |
| `INTERNAL_ERROR`                                                                                                                                                                                                             | 500    | bug — report with `requestId`                                 |

Transient settlement locks: an onchain claim racing a launch/graduation/flush
reverts — nothing is lost; retry the transaction.

---

## 14. Quick-start recipes

```ts
// Card grid (newest bonding pools, 24 rows)
const { data: rows, meta } = await fetch('/api/v1/tokens?phase=bonding&sort=newest&limit=24').then(
  (r) => r.json(),
);

// Launch a token (creator wallet = revenue owner)
const prep = await fetch('/api/v1/launch/prepare', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    creatorWalletAddress: account,
    name,
    symbol,
    description,
    imageUri,
    socials,
    totalSupply: '1000000000000000000000000000',
    devBuyShareWad: '0',
    payoutPlan: '1',
    deadline: Math.floor(Date.now() / 1000) + 3600,
  }),
}).then((r) => r.json());
// show predictedToken + geometry while user confirms…
const relay = await fetch('/api/v1/launch/relay', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
  body: JSON.stringify({ launchId: prep.data.launchId }),
}).then((r) => r.json());
// poll until onchain: GET /api/v1/launch/records/{launchId}

// Chart (1m) + live splice
const bars = await fetch(`/api/v1/tokens/${poolId}/candles?interval=1m&limit=500`).then((r) =>
  r.json(),
);
series.setData(bars.data.candles.map(toPoint)); // time, openEth, highEth, lowEth, closeEth
const ws = new WebSocket(`wss://stream.host/ws?pool=${poolId}`);
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.type === 'bar' || m.type === 'bar_close') series.update(barPoint(m));
  if (m.type === 'tick') {
    tape.prepend(m);
    buildSubMinuteBar(m);
  }
};
ws.onopen = async () => {
  /* reconnect: REST ?limit=50 → series.update each → resume */
};
```
