-- CreateEnum
CREATE TYPE "OnchainPhase" AS ENUM ('NONE', 'BONDING_CURVE', 'GRADUATED');

-- CreateEnum
CREATE TYPE "Timeframe" AS ENUM ('H1', 'H24', 'D7', 'D30', 'ALL');

-- CreateEnum
CREATE TYPE "TradeSide" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "CandleInterval" AS ENUM ('M1', 'M5', 'M15', 'H1', 'H4', 'D1');

-- CreateEnum
CREATE TYPE "MilestoneKind" AS ENUM ('CORE', 'EXTENSION');

-- CreateEnum
CREATE TYPE "MilestoneState" AS ENUM ('PENDING', 'DEPLOYED', 'SKIPPED', 'HARVESTED');

-- CreateEnum
CREATE TYPE "AccrualSource" AS ENUM ('CURVE_PROCEEDS', 'SWAP_FEES', 'MILESTONE_HARVEST');

-- CreateEnum
CREATE TYPE "PayoutOutcome" AS ENUM ('DELIVERED', 'CARRIED', 'REDIRECTED');

-- CreateEnum
CREATE TYPE "GovernanceAction" AS ENUM ('SET_ECONOMIC_CONFIG', 'SET_PROTOCOL_RECIPIENT', 'REGISTER_PLUGIN', 'SET_PLUGIN_SUSPENDED', 'SET_GOVERNANCE_DELAY');

-- CreateEnum
CREATE TYPE "GovernanceStatus" AS ENUM ('SCHEDULED', 'CANCELLED', 'EXECUTED');

-- CreateEnum
CREATE TYPE "IdempotencyState" AS ENUM ('IN_PROGRESS', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "LaunchMode" AS ENUM ('CREATOR_DIRECT', 'RELAYED');

-- CreateEnum
CREATE TYPE "LaunchRecordState" AS ENUM ('PENDING_SIGNATURE', 'SUBMITTED', 'CONFIRMED', 'REORGED', 'FAILED');

-- CreateTable
CREATE TABLE "profiles" (
    "walletAddress" VARCHAR(42) NOT NULL,
    "username" VARCHAR(32),
    "usernameFolded" VARCHAR(32),
    "bio" VARCHAR(1200),
    "imageUri" VARCHAR(512),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "profiles_pkey" PRIMARY KEY ("walletAddress")
);

-- CreateTable
CREATE TABLE "tokens" (
    "id" UUID NOT NULL,
    "chainId" INTEGER NOT NULL,
    "claimedCreatorWallet" VARCHAR(42) NOT NULL,
    "name" VARCHAR(320) NOT NULL,
    "symbol" VARCHAR(12) NOT NULL,
    "description" VARCHAR(8000) NOT NULL,
    "imageUri" VARCHAR(512) NOT NULL,
    "ipfsUri" VARCHAR(512) NOT NULL,
    "gatewayUrl" VARCHAR(2048) NOT NULL,
    "socials" JSONB,
    "configHash" VARCHAR(66),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "launch_records" (
    "id" UUID NOT NULL,
    "chainId" INTEGER NOT NULL,
    "creatorWallet" VARCHAR(42) NOT NULL,
    "name" VARCHAR(320) NOT NULL,
    "symbol" VARCHAR(12) NOT NULL,
    "totalSupply" DECIMAL(78,0) NOT NULL,
    "devBuyShareWad" DECIMAL(38,18) NOT NULL,
    "payoutPlan" DECIMAL(78,0) NOT NULL,
    "deadline" BIGINT NOT NULL,
    "configHash" VARCHAR(66) NOT NULL,
    "predictedToken" VARCHAR(42) NOT NULL,
    "signature" TEXT,
    "digest" VARCHAR(66) NOT NULL,
    "mode" "LaunchMode" NOT NULL,
    "state" "LaunchRecordState" NOT NULL DEFAULT 'PENDING_SIGNATURE',
    "transactionHash" VARCHAR(66),
    "submittedAt" TIMESTAMPTZ(6),
    "confirmedAt" TIMESTAMPTZ(6),
    "blockNumber" BIGINT,
    "failureReason" VARCHAR(1000),
    "tokenId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "launch_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_requests" (
    "id" UUID NOT NULL,
    "scope" VARCHAR(128) NOT NULL,
    "walletAddress" VARCHAR(42) NOT NULL,
    "key" VARCHAR(128) NOT NULL,
    "requestHash" VARCHAR(66) NOT NULL,
    "state" "IdempotencyState" NOT NULL DEFAULT 'IN_PROGRESS',
    "responseStatus" INTEGER,
    "responseBody" JSONB,
    "resourceId" UUID,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "idempotency_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "topic" VARCHAR(128) NOT NULL,
    "aggregateId" VARCHAR(128) NOT NULL,
    "attemptVersion" INTEGER,
    "payload" JSONB NOT NULL,
    "availableAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseOwner" VARCHAR(128),
    "leaseExpiresAt" TIMESTAMPTZ(6),
    "publishedAt" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" VARCHAR(1000),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "domain_generations" (
    "domain" VARCHAR(128) NOT NULL,
    "generation" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "domain_generations_pkey" PRIMARY KEY ("domain")
);

-- CreateTable
CREATE TABLE "deployment_manifests" (
    "chainId" INTEGER NOT NULL,
    "document" JSONB NOT NULL,
    "syncedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deployment_manifests_pkey" PRIMARY KEY ("chainId")
);

-- CreateTable
CREATE TABLE "chain_cursors" (
    "chainId" INTEGER NOT NULL,
    "nextBlock" BIGINT NOT NULL,
    "headBlock" BIGINT NOT NULL,
    "headBlockHash" VARCHAR(66) NOT NULL,
    "headBlockTime" TIMESTAMPTZ(6) NOT NULL,
    "safeDepth" INTEGER NOT NULL DEFAULT 64,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "chain_cursors_pkey" PRIMARY KEY ("chainId")
);

-- CreateTable
CREATE TABLE "block_receipts" (
    "chainId" INTEGER NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "blockHash" VARCHAR(66) NOT NULL,
    "blockTime" TIMESTAMPTZ(6) NOT NULL,
    "parentHash" VARCHAR(66) NOT NULL,
    "transactionCount" INTEGER NOT NULL,
    "version" BIGINT NOT NULL,
    "ingestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "block_receipts_pkey" PRIMARY KEY ("chainId","blockNumber")
);

-- CreateTable
CREATE TABLE "raw_chain_events" (
    "chainId" INTEGER NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "transactionIndex" INTEGER NOT NULL,
    "transactionHash" VARCHAR(66) NOT NULL,
    "address" VARCHAR(42) NOT NULL,
    "topic0" VARCHAR(66) NOT NULL,
    "topics" VARCHAR(66)[],
    "data" VARCHAR(8192) NOT NULL,
    "eventName" VARCHAR(64),
    "blockHash" VARCHAR(66) NOT NULL,
    "blockTime" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "raw_chain_events_pkey" PRIMARY KEY ("chainId","blockNumber","logIndex")
);

-- CreateTable
CREATE TABLE "chain_watermarks" (
    "chainId" INTEGER NOT NULL,
    "committedVersion" BIGINT NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "blockHash" VARCHAR(66) NOT NULL,
    "blockTime" TIMESTAMPTZ(6) NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "chain_watermarks_pkey" PRIMARY KEY ("chainId")
);

-- CreateTable
CREATE TABLE "economic_config_records" (
    "chainId" INTEGER NOT NULL,
    "version" BIGINT NOT NULL,
    "harvestServiceFeeWad" DECIMAL(38,18) NOT NULL,
    "quoteCreatorShareWad" DECIMAL(38,18) NOT NULL,
    "tokenMilestoneFundShareWad" DECIMAL(38,18) NOT NULL,
    "activatedAtBlock" BIGINT NOT NULL,
    "blockTime" TIMESTAMPTZ(6) NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "economic_config_records_pkey" PRIMARY KEY ("chainId")
);

-- CreateTable
CREATE TABLE "plugin_registry_entries" (
    "chainId" INTEGER NOT NULL,
    "index" INTEGER NOT NULL,
    "plugin" VARCHAR(42) NOT NULL,
    "takeWad" DECIMAL(38,18) NOT NULL,
    "gasLimit" INTEGER NOT NULL,
    "codeHash" VARCHAR(66) NOT NULL,
    "role" INTEGER NOT NULL,
    "suspended" BOOLEAN NOT NULL DEFAULT false,
    "registeredAtBlock" BIGINT NOT NULL,
    "blockTime" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "plugin_registry_entries_pkey" PRIMARY KEY ("chainId","index")
);

-- CreateTable
CREATE TABLE "governance_operations" (
    "chainId" INTEGER NOT NULL,
    "operationId" VARCHAR(66) NOT NULL,
    "action" "GovernanceAction" NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "GovernanceStatus" NOT NULL DEFAULT 'SCHEDULED',
    "readyAtBlock" BIGINT,
    "readyAt" TIMESTAMPTZ(6),
    "executedAtBlock" BIGINT,
    "cancelledAtBlock" BIGINT,
    "blockTime" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "governance_operations_pkey" PRIMARY KEY ("chainId","operationId")
);

-- CreateTable
CREATE TABLE "token_chain_states" (
    "tokenId" UUID NOT NULL,
    "chainId" INTEGER NOT NULL,
    "phase" "OnchainPhase" NOT NULL,
    "contractAddress" VARCHAR(42) NOT NULL,
    "poolId" VARCHAR(66) NOT NULL,
    "launchCreatorWallet" VARCHAR(42) NOT NULL,
    "creatorRevenueNftId" DECIMAL(78,0),
    "creatorRevenueOwner" VARCHAR(42),
    "revenueNftMintedAt" TIMESTAMPTZ(6),
    "launchedAt" TIMESTAMPTZ(6) NOT NULL,
    "graduatedAt" TIMESTAMPTZ(6),
    "totalSupply" DECIMAL(78,0) NOT NULL,
    "currentSupply" DECIMAL(78,0) NOT NULL,
    "decimals" INTEGER NOT NULL,
    "openingLevel" INTEGER NOT NULL,
    "farLevel" INTEGER NOT NULL,
    "graduationLevel" INTEGER,
    "payoutPlan" DECIMAL(78,0) NOT NULL,
    "devBuyShareWad" DECIMAL(38,18) NOT NULL,
    "configHash" VARCHAR(66) NOT NULL,
    "curveSupplyShareBps" INTEGER NOT NULL DEFAULT 2500,
    "ladderSupplyShareBps" INTEGER NOT NULL DEFAULT 6500,
    "fullRangeSupplyShareBps" INTEGER NOT NULL DEFAULT 1000,
    "curvePositions" INTEGER NOT NULL DEFAULT 32,
    "curveDeployed" INTEGER NOT NULL DEFAULT 0,
    "coreBandCount" INTEGER NOT NULL DEFAULT 30,
    "maxFeeFundedBands" INTEGER NOT NULL DEFAULT 30,
    "deployedBands" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "completedBands" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "completedMilestones" INTEGER NOT NULL DEFAULT 0,
    "completedExtensionMilestones" INTEGER NOT NULL DEFAULT 0,
    "feeFundedBandsCreated" INTEGER NOT NULL DEFAULT 0,
    "bandLevelSpacing" INTEGER NOT NULL DEFAULT 2235,
    "bandWidthLevels" INTEGER NOT NULL DEFAULT 447,
    "carriedInventory" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "milestoneFundAccrued" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "payoutPot" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "payoutPotFundedCount" INTEGER NOT NULL DEFAULT 0,
    "directCreatorClaimable" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "creatorPathClaimable" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "pluginCarryBitmap" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "lastPriceLevel" INTEGER,
    "lastSqrtPriceX96" DECIMAL(78,0),
    "projectionVersion" BIGINT NOT NULL,
    "sourceBlockNumber" BIGINT NOT NULL,
    "sourceBlockHash" VARCHAR(66) NOT NULL,
    "sourceBlockTime" TIMESTAMPTZ(6) NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "token_chain_states_pkey" PRIMARY KEY ("tokenId")
);

-- CreateTable
CREATE TABLE "token_metrics" (
    "tokenId" UUID NOT NULL,
    "chainId" INTEGER NOT NULL,
    "timeframe" "Timeframe" NOT NULL,
    "priceEth" DECIMAL(100,36),
    "priceUsd" DECIMAL(100,36),
    "marketCapEth" DECIMAL(100,36),
    "marketCapUsd" DECIMAL(100,36),
    "volumeEth" DECIMAL(100,36),
    "volumeUsd" DECIMAL(100,36),
    "priceChangePct" DECIMAL(38,18),
    "tradeCount" BIGINT,
    "holderCount" BIGINT,
    "projectionVersion" BIGINT NOT NULL,
    "sourceBlockNumber" BIGINT NOT NULL,
    "sourceBlockTime" TIMESTAMPTZ(6) NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "token_metrics_pkey" PRIMARY KEY ("tokenId","chainId","timeframe")
);

-- CreateTable
CREATE TABLE "trades" (
    "chainId" INTEGER NOT NULL,
    "transactionHash" VARCHAR(66) NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "transactionIndex" INTEGER NOT NULL,
    "tokenId" UUID NOT NULL,
    "side" "TradeSide" NOT NULL,
    "traderWallet" VARCHAR(42) NOT NULL,
    "tokenAmountRaw" DECIMAL(78,0) NOT NULL,
    "quoteAmountRaw" DECIMAL(78,0) NOT NULL,
    "priceLevel" INTEGER NOT NULL,
    "sqrtPriceX96" DECIMAL(78,0) NOT NULL,
    "priceUsd" DECIMAL(100,36),
    "valueUsd" DECIMAL(100,36),
    "lpFee" INTEGER NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "blockHash" VARCHAR(66) NOT NULL,
    "blockTime" TIMESTAMPTZ(6) NOT NULL,
    "projectionVersion" BIGINT NOT NULL,

    CONSTRAINT "trades_pkey" PRIMARY KEY ("chainId","transactionHash","logIndex")
);

-- CreateTable
CREATE TABLE "candles" (
    "tokenId" UUID NOT NULL,
    "chainId" INTEGER NOT NULL,
    "interval" "CandleInterval" NOT NULL,
    "bucketStart" TIMESTAMPTZ(6) NOT NULL,
    "open" DECIMAL(100,36) NOT NULL,
    "high" DECIMAL(100,36) NOT NULL,
    "low" DECIMAL(100,36) NOT NULL,
    "close" DECIMAL(100,36) NOT NULL,
    "volumeEth" DECIMAL(100,36) NOT NULL,
    "volumeUsd" DECIMAL(100,36),
    "tradeCount" BIGINT NOT NULL,
    "projectionVersion" BIGINT NOT NULL,

    CONSTRAINT "candles_pkey" PRIMARY KEY ("tokenId","chainId","interval","bucketStart")
);

-- CreateTable
CREATE TABLE "milestones" (
    "tokenId" UUID NOT NULL,
    "chainId" INTEGER NOT NULL,
    "kind" "MilestoneKind" NOT NULL,
    "index" INTEGER NOT NULL,
    "state" "MilestoneState" NOT NULL,
    "levelLower" INTEGER NOT NULL,
    "levelUpper" INTEGER NOT NULL,
    "liquidity" DECIMAL(78,0),
    "tokenInventoryRaw" DECIMAL(78,0) NOT NULL,
    "tokenRemainingRaw" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "quoteProceedsRaw" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "grossHarvestRaw" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "serviceFeeRaw" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "netPotRaw" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "economicVersion" BIGINT,
    "harvestedAt" TIMESTAMPTZ(6),
    "deployedAt" TIMESTAMPTZ(6),
    "skippedAt" TIMESTAMPTZ(6),
    "projectionVersion" BIGINT NOT NULL,
    "sourceBlockNumber" BIGINT NOT NULL,
    "sourceBlockTime" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "milestones_pkey" PRIMARY KEY ("tokenId","chainId","kind","index")
);

-- CreateTable
CREATE TABLE "holdings" (
    "walletAddress" VARCHAR(42) NOT NULL,
    "tokenId" UUID NOT NULL,
    "chainId" INTEGER NOT NULL,
    "balanceRaw" DECIMAL(78,0) NOT NULL,
    "valueUsd" DECIMAL(100,36),
    "lastActivityAt" TIMESTAMPTZ(6) NOT NULL,
    "projectionVersion" BIGINT NOT NULL,
    "sourceBlockNumber" BIGINT NOT NULL,
    "sourceBlockTime" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "holdings_pkey" PRIMARY KEY ("walletAddress","tokenId","chainId")
);

-- CreateTable
CREATE TABLE "revenue_events" (
    "id" UUID NOT NULL,
    "chainId" INTEGER NOT NULL,
    "tokenId" UUID,
    "poolId" VARCHAR(66) NOT NULL,
    "milestoneIndex" INTEGER,
    "kind" VARCHAR(48) NOT NULL,
    "outcome" "PayoutOutcome",
    "source" "AccrualSource",
    "economicVersion" BIGINT,
    "walletAddress" VARCHAR(42),
    "pluginIndex" INTEGER,
    "amountRaw" DECIMAL(78,0) NOT NULL,
    "carriedAmountRaw" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "transactionHash" VARCHAR(66) NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "blockTime" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "revenue_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comments" (
    "id" UUID NOT NULL,
    "tokenId" UUID NOT NULL,
    "walletAddress" VARCHAR(42) NOT NULL,
    "parentId" UUID,
    "rootId" UUID NOT NULL,
    "depth" INTEGER NOT NULL,
    "text" VARCHAR(8000),
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "likeCount" INTEGER NOT NULL DEFAULT 0,
    "replyCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comment_likes" (
    "commentId" UUID NOT NULL,
    "walletAddress" VARCHAR(42) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comment_likes_pkey" PRIMARY KEY ("commentId","walletAddress")
);

-- CreateIndex
CREATE UNIQUE INDEX "profiles_username_key" ON "profiles"("username");

-- CreateIndex
CREATE UNIQUE INDEX "profiles_usernameFolded_key" ON "profiles"("usernameFolded");

-- CreateIndex
CREATE INDEX "tokens_claimedCreatorWallet_createdAt_idx" ON "tokens"("claimedCreatorWallet", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "tokens_createdAt_idx" ON "tokens"("createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "tokens_chainId_configHash_key" ON "tokens"("chainId", "configHash");

-- CreateIndex
CREATE UNIQUE INDEX "launch_records_tokenId_key" ON "launch_records"("tokenId");

-- CreateIndex
CREATE INDEX "launch_records_creatorWallet_state_idx" ON "launch_records"("creatorWallet", "state");

-- CreateIndex
CREATE INDEX "launch_records_state_createdAt_idx" ON "launch_records"("state", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "launch_records_chainId_configHash_creatorWallet_key" ON "launch_records"("chainId", "configHash", "creatorWallet");

-- CreateIndex
CREATE INDEX "idempotency_requests_expiresAt_idx" ON "idempotency_requests"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_requests_scope_walletAddress_key_key" ON "idempotency_requests"("scope", "walletAddress", "key");

-- CreateIndex
CREATE INDEX "outbox_events_publishedAt_availableAt_idx" ON "outbox_events"("publishedAt", "availableAt");

-- CreateIndex
CREATE INDEX "raw_chain_events_address_topic0_blockNumber_idx" ON "raw_chain_events"("address", "topic0", "blockNumber");

-- CreateIndex
CREATE INDEX "raw_chain_events_chainId_blockNumber_logIndex_idx" ON "raw_chain_events"("chainId", "blockNumber" DESC, "logIndex" DESC);

-- CreateIndex
CREATE INDEX "plugin_registry_entries_chainId_plugin_idx" ON "plugin_registry_entries"("chainId", "plugin");

-- CreateIndex
CREATE INDEX "governance_operations_chainId_status_idx" ON "governance_operations"("chainId", "status");

-- CreateIndex
CREATE INDEX "token_chain_states_phase_sourceBlockTime_idx" ON "token_chain_states"("phase", "sourceBlockTime");

-- CreateIndex
CREATE INDEX "token_chain_states_chainId_launchCreatorWallet_idx" ON "token_chain_states"("chainId", "launchCreatorWallet");

-- CreateIndex
CREATE UNIQUE INDEX "token_chain_states_chainId_contractAddress_key" ON "token_chain_states"("chainId", "contractAddress");

-- CreateIndex
CREATE UNIQUE INDEX "token_chain_states_chainId_poolId_key" ON "token_chain_states"("chainId", "poolId");

-- CreateIndex
CREATE INDEX "token_metrics_timeframe_volumeUsd_idx" ON "token_metrics"("timeframe", "volumeUsd" DESC);

-- CreateIndex
CREATE INDEX "token_metrics_timeframe_marketCapUsd_idx" ON "token_metrics"("timeframe", "marketCapUsd" DESC);

-- CreateIndex
CREATE INDEX "trades_tokenId_chainId_blockNumber_transactionIndex_logInde_idx" ON "trades"("tokenId", "chainId", "blockNumber" DESC, "transactionIndex" DESC, "logIndex" DESC);

-- CreateIndex
CREATE INDEX "trades_tokenId_chainId_tokenAmountRaw_idx" ON "trades"("tokenId", "chainId", "tokenAmountRaw" DESC);

-- CreateIndex
CREATE INDEX "milestones_tokenId_chainId_state_kind_index_idx" ON "milestones"("tokenId", "chainId", "state", "kind", "index");

-- CreateIndex
CREATE INDEX "holdings_walletAddress_valueUsd_idx" ON "holdings"("walletAddress", "valueUsd" DESC);

-- CreateIndex
CREATE INDEX "holdings_walletAddress_lastActivityAt_idx" ON "holdings"("walletAddress", "lastActivityAt" DESC);

-- CreateIndex
CREATE INDEX "revenue_events_tokenId_chainId_blockNumber_logIndex_idx" ON "revenue_events"("tokenId", "chainId", "blockNumber", "logIndex");

-- CreateIndex
CREATE INDEX "revenue_events_poolId_kind_blockNumber_idx" ON "revenue_events"("poolId", "kind", "blockNumber");

-- CreateIndex
CREATE INDEX "revenue_events_walletAddress_blockNumber_idx" ON "revenue_events"("walletAddress", "blockNumber" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "revenue_events_chainId_transactionHash_logIndex_key" ON "revenue_events"("chainId", "transactionHash", "logIndex");

-- CreateIndex
CREATE INDEX "comments_tokenId_parentId_createdAt_idx" ON "comments"("tokenId", "parentId", "createdAt");

-- CreateIndex
CREATE INDEX "comments_tokenId_rootId_createdAt_idx" ON "comments"("tokenId", "rootId", "createdAt");

-- CreateIndex
CREATE INDEX "comments_tokenId_parentId_likeCount_createdAt_idx" ON "comments"("tokenId", "parentId", "likeCount" DESC, "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "comments_id_tokenId_key" ON "comments"("id", "tokenId");

-- AddForeignKey
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_claimedCreatorWallet_fkey" FOREIGN KEY ("claimedCreatorWallet") REFERENCES "profiles"("walletAddress") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "launch_records" ADD CONSTRAINT "launch_records_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "tokens"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_chain_states" ADD CONSTRAINT "token_chain_states_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_metrics" ADD CONSTRAINT "token_metrics_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candles" ADD CONSTRAINT "candles_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "holdings" ADD CONSTRAINT "holdings_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revenue_events" ADD CONSTRAINT "revenue_events_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_walletAddress_fkey" FOREIGN KEY ("walletAddress") REFERENCES "profiles"("walletAddress") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "comments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_likes" ADD CONSTRAINT "comment_likes_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_likes" ADD CONSTRAINT "comment_likes_walletAddress_fkey" FOREIGN KEY ("walletAddress") REFERENCES "profiles"("walletAddress") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Application invariants: extensions, checks, partial indexes, roles, grants
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Address/hex format checks (all addresses lowercase hex).
ALTER TABLE "profiles" ADD CONSTRAINT profiles_wallet_format CHECK ("walletAddress" ~ '^0x[0-9a-f]{40}$');
ALTER TABLE "tokens" ADD CONSTRAINT tokens_creator_format CHECK ("claimedCreatorWallet" ~ '^0x[0-9a-f]{40}$');
ALTER TABLE "token_chain_states" ADD CONSTRAINT tcs_contract_format CHECK ("contractAddress" ~ '^0x[0-9a-f]{40}$');
ALTER TABLE "token_chain_states" ADD CONSTRAINT tcs_pool_format CHECK ("poolId" ~ '^0x[0-9a-f]{64}$');
ALTER TABLE "token_chain_states" ADD CONSTRAINT tcs_owner_format CHECK ("creatorRevenueOwner" IS NULL OR "creatorRevenueOwner" ~ '^0x[0-9a-f]{40}$');
ALTER TABLE "trades" ADD CONSTRAINT trades_trader_format CHECK ("traderWallet" ~ '^0x[0-9a-f]{40}$');
ALTER TABLE "holdings" ADD CONSTRAINT holdings_wallet_format CHECK ("walletAddress" ~ '^0x[0-9a-f]{40}$');
ALTER TABLE "revenue_events" ADD CONSTRAINT revenue_pool_format CHECK ("poolId" ~ '^0x[0-9a-f]{64}$');
ALTER TABLE "revenue_events" ADD CONSTRAINT revenue_wallet_format CHECK ("walletAddress" IS NULL OR "walletAddress" ~ '^0x[0-9a-f]{40}$');
ALTER TABLE "launch_records" ADD CONSTRAINT launch_creator_format CHECK ("creatorWallet" ~ '^0x[0-9a-f]{40}$');
ALTER TABLE "launch_records" ADD CONSTRAINT launch_predicted_format CHECK ("predictedToken" ~ '^0x[0-9a-f]{40}$');
ALTER TABLE "launch_records" ADD CONSTRAINT launch_confighash_format CHECK ("configHash" ~ '^0x[0-9a-f]{64}$');

-- Non-negative onchain amounts.
ALTER TABLE "token_chain_states" ADD CONSTRAINT tcs_amounts_nonneg CHECK (
  "totalSupply" >= 0 AND "currentSupply" >= 0 AND "payoutPot" >= 0 AND "directCreatorClaimable" >= 0
  AND "creatorPathClaimable" >= 0 AND "pluginCarryBitmap" >= 0 AND "carriedInventory" >= 0
  AND "milestoneFundAccrued" >= 0
);
ALTER TABLE "trades" ADD CONSTRAINT trades_amounts_nonneg CHECK ("tokenAmountRaw" >= 0 AND "quoteAmountRaw" >= 0);
ALTER TABLE "holdings" ADD CONSTRAINT holdings_balance_nonneg CHECK ("balanceRaw" >= 0);
ALTER TABLE "milestones" ADD CONSTRAINT milestones_amounts_nonneg CHECK (
  "tokenInventoryRaw" >= 0 AND "tokenRemainingRaw" >= 0 AND "quoteProceedsRaw" >= 0
  AND "grossHarvestRaw" >= 0 AND "serviceFeeRaw" >= 0 AND "netPotRaw" >= 0
);
ALTER TABLE "revenue_events" ADD CONSTRAINT revenue_amount_nonneg CHECK ("amountRaw" >= 0 AND "carriedAmountRaw" >= 0);

-- Level geometry: opening below far; bands ascending when present.
ALTER TABLE "token_chain_states" ADD CONSTRAINT tcs_levels CHECK ("openingLevel" < "farLevel");
ALTER TABLE "milestones" ADD CONSTRAINT milestones_levels CHECK ("levelLower" < "levelUpper");

-- Economics tuple bounds (immutable protocol caps).
ALTER TABLE "economic_config_records" ADD CONSTRAINT economics_bounds CHECK (
  "harvestServiceFeeWad" >= 0 AND "harvestServiceFeeWad" <= 0.2
  AND "quoteCreatorShareWad" >= 0 AND "quoteCreatorShareWad" <= 0.9
  AND "tokenMilestoneFundShareWad" >= 0 AND "tokenMilestoneFundShareWad" <= 0.5
);

-- Comment tombstone consistency.
ALTER TABLE "comments" ADD CONSTRAINT comments_tombstone CHECK (
  ("isDeleted" = false AND "deletedAt" IS NULL)
  OR ("isDeleted" = true AND "deletedAt" IS NOT NULL AND "text" IS NULL)
);
ALTER TABLE "comments" ADD CONSTRAINT comments_depth CHECK ("depth" >= 0 AND "depth" <= 3);
ALTER TABLE "comments" ADD CONSTRAINT comment_like_counts CHECK ("likeCount" >= 0 AND "replyCount" >= 0);

-- Launch records.
ALTER TABLE "launch_records" ADD CONSTRAINT launch_devbuy_cap CHECK ("devBuyShareWad" >= 0 AND "devBuyShareWad" <= 0.1);
ALTER TABLE "launch_records" ADD CONSTRAINT launch_supply_pos CHECK ("totalSupply" > 0);

-- Partial index for outbox dispatch.
CREATE INDEX outbox_unpublished_idx ON "outbox_events"("availableAt") WHERE "publishedAt" IS NULL;

-- Fuzzy/FTS search indexes for token discovery.
CREATE INDEX tokens_name_symbol_trgm_idx ON "tokens" USING gin ((("name" || ' ' || "symbol")) gin_trgm_ops);
CREATE INDEX tokens_name_symbol_fts_idx ON "tokens" USING gin (to_tsvector('simple', "name" || ' ' || "symbol"));

-- Comments ancestry: (parentId, tokenId) and (rootId, tokenId) must be consistent pairs.
ALTER TABLE "comments" ADD CONSTRAINT comments_parent_token_pair UNIQUE ("parentId", "tokenId");
ALTER TABLE "comments" ADD CONSTRAINT comments_root_token_pair UNIQUE ("rootId", "tokenId");

CREATE OR REPLACE FUNCTION enforce_comment_ancestry() RETURNS trigger AS $$
DECLARE
  parent_depth INTEGER;
  parent_root UUID;
  parent_token UUID;
BEGIN
  IF NEW."parentId" IS NULL THEN
    NEW."depth" := 0;
    NEW."rootId" := NEW."id";
  ELSE
    SELECT c."depth", c."rootId", c."tokenId" INTO parent_depth, parent_root, parent_token
    FROM "comments" c WHERE c."id" = NEW."parentId" AND c."tokenId" = NEW."tokenId" AND c."isDeleted" = false;
    IF parent_depth IS NULL THEN
      RAISE EXCEPTION 'parent comment not found on this token or is deleted';
    END IF;
    NEW."depth" := parent_depth + 1;
    NEW."rootId" := parent_root;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER comments_ancestry_trigger BEFORE INSERT ON "comments"
  FOR EACH ROW EXECUTE FUNCTION enforce_comment_ancestry();

-- ---------------------------------------------------------------------------
-- Role-based access control. The API role must not write indexer-owned tables and
-- the indexer role must not touch API-owned tables. Secrets (none at baseline) and
-- restricted objects are granted only where needed.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'spawn_owner') THEN
    CREATE ROLE spawn_owner NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'spawn_migration') THEN
    CREATE ROLE spawn_migration NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'spawn_api') THEN
    CREATE ROLE spawn_api NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'spawn_seed') THEN
    CREATE ROLE spawn_seed NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'spawn_indexer') THEN
    CREATE ROLE spawn_indexer NOLOGIN;
  END IF;
END
$$;

GRANT ALL ON SCHEMA public TO spawn_owner;
GRANT USAGE ON SCHEMA public TO spawn_migration, spawn_api, spawn_seed, spawn_indexer;

-- Migration role: owns DDL (Prisma migrate deploy connects as the database owner in
-- most deployments; the role exists for explicit role separation).
GRANT ALL ON ALL TABLES IN SCHEMA public TO spawn_migration;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO spawn_migration;

-- API-owned tables: full DML for the API role.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "profiles", "tokens", "launch_records", "idempotency_requests", "outbox_events",
  "domain_generations", "comments", "comment_likes"
TO spawn_api;

-- Indexer-owned tables: API read-only, indexer full DML.
GRANT SELECT ON
  "deployment_manifests", "chain_cursors", "block_receipts", "raw_chain_events",
  "chain_watermarks", "economic_config_records", "plugin_registry_entries",
  "governance_operations", "token_chain_states", "token_metrics", "trades",
  "candles", "milestones", "holdings", "revenue_events"
TO spawn_api;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  "deployment_manifests", "chain_cursors", "block_receipts", "raw_chain_events",
  "chain_watermarks", "economic_config_records", "plugin_registry_entries",
  "governance_operations", "token_chain_states", "token_metrics", "trades",
  "candles", "milestones", "holdings", "revenue_events"
TO spawn_indexer;

-- Tokens table is co-owned: API writes offchain rows, the indexer attaches
-- projections keyed by tokenId. Grants already cover both.
GRANT SELECT, INSERT, UPDATE ON "tokens" TO spawn_indexer;

-- Seed role: destructive dev seeding needs everything.
GRANT ALL ON ALL TABLES IN SCHEMA public TO spawn_seed;

-- Default privileges for future objects.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO spawn_api;
