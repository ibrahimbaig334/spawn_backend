-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "MetadataStatus" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'FAILED_RETRYABLE', 'FAILED_TERMINAL');

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
CREATE TYPE "MilestoneState" AS ENUM ('PENDING', 'DEPLOYED', 'PARTIAL', 'COMPLETED', 'HARVESTED');

-- CreateEnum
CREATE TYPE "IdempotencyState" AS ENUM ('IN_PROGRESS', 'COMPLETED', 'FAILED');

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
CREATE TABLE "profile_links" (
    "id" UUID NOT NULL,
    "walletAddress" VARCHAR(42) NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "url" VARCHAR(512) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "profile_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tokens" (
    "id" UUID NOT NULL,
    "claimedCreatorWallet" VARCHAR(42) NOT NULL,
    "name" VARCHAR(320) NOT NULL,
    "symbol" VARCHAR(12) NOT NULL,
    "description" VARCHAR(8000) NOT NULL,
    "imageUri" VARCHAR(512) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "token_metadata_operations" (
    "id" UUID NOT NULL,
    "tokenId" UUID NOT NULL,
    "status" "MetadataStatus" NOT NULL DEFAULT 'PENDING',
    "attemptVersion" INTEGER NOT NULL DEFAULT 1,
    "automatedAttempts" INTEGER NOT NULL DEFAULT 0,
    "manualGenerations" INTEGER NOT NULL DEFAULT 0,
    "metadataBytes" BYTEA NOT NULL,
    "metadataHash" VARCHAR(66) NOT NULL,
    "metadataUri" VARCHAR(512),
    "errorCode" VARCHAR(64),
    "errorMessage" VARCHAR(1000),
    "leaseOwner" VARCHAR(128),
    "leaseExpiresAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "token_metadata_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "token_deployment_signers" (
    "tokenId" UUID NOT NULL,
    "signerAddress" VARCHAR(42) NOT NULL,
    "algorithm" VARCHAR(32) NOT NULL DEFAULT 'secp256k1',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "token_deployment_signers_pkey" PRIMARY KEY ("tokenId")
);

-- CreateTable
CREATE TABLE "token_deployment_signer_secrets" (
    "tokenId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "algorithm" VARCHAR(32) NOT NULL,
    "keyId" VARCHAR(128) NOT NULL,
    "iv" BYTEA NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "authTag" BYTEA NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "token_deployment_signer_secrets_pkey" PRIMARY KEY ("tokenId")
);

-- CreateTable
CREATE TABLE "token_deployment_bindings" (
    "tokenId" UUID NOT NULL,
    "chainId" INTEGER NOT NULL,
    "signerAddress" VARCHAR(42) NOT NULL,
    "configHash" VARCHAR(66) NOT NULL,
    "transactionHash" VARCHAR(66) NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "contractAddress" VARCHAR(42),
    "poolId" VARCHAR(66),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "token_deployment_bindings_pkey" PRIMARY KEY ("tokenId")
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
CREATE TABLE "token_chain_states" (
    "tokenId" UUID NOT NULL,
    "chainId" INTEGER NOT NULL,
    "phase" "OnchainPhase" NOT NULL,
    "contractAddress" VARCHAR(42) NOT NULL,
    "poolId" VARCHAR(66) NOT NULL,
    "launchCreatorWallet" VARCHAR(42) NOT NULL,
    "creatorRevenueNftId" DECIMAL(78,0),
    "creatorRevenueOwner" VARCHAR(42),
    "totalSupply" DECIMAL(78,0) NOT NULL,
    "decimals" INTEGER NOT NULL,
    "curveAllocationBps" INTEGER NOT NULL DEFAULT 2500,
    "milestoneAllocationBps" INTEGER NOT NULL DEFAULT 6500,
    "fullRangeAllocationBps" INTEGER NOT NULL DEFAULT 1000,
    "creatorHarvestSplitWad" DECIMAL(38,18) NOT NULL,
    "buybackHarvestSplitWad" DECIMAL(38,18) NOT NULL,
    "protocolHarvestSplitWad" DECIMAL(38,18) NOT NULL,
    "lpHarvestSplitWad" DECIMAL(38,18) NOT NULL,
    "curveCount" INTEGER NOT NULL DEFAULT 32,
    "completedCoreMilestones" INTEGER NOT NULL DEFAULT 0,
    "completedExtraMilestones" INTEGER NOT NULL DEFAULT 0,
    "feeBps" INTEGER NOT NULL,
    "projectionVersion" BIGINT NOT NULL,
    "sourceBlockNumber" BIGINT NOT NULL,
    "sourceBlockHash" VARCHAR(66) NOT NULL,
    "sourceBlockTime" TIMESTAMPTZ(6) NOT NULL,
    "provenance" VARCHAR(64) NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "token_chain_states_pkey" PRIMARY KEY ("tokenId","chainId")
);

-- CreateTable
CREATE TABLE "token_metrics" (
    "tokenId" UUID NOT NULL,
    "chainId" INTEGER NOT NULL,
    "timeframe" "Timeframe" NOT NULL,
    "priceUsd" DECIMAL(100,36),
    "marketCapUsd" DECIMAL(100,36),
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
CREATE TABLE "token_watermarks" (
    "tokenId" UUID NOT NULL,
    "chainId" INTEGER NOT NULL,
    "committedVersion" BIGINT NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "blockHash" VARCHAR(66) NOT NULL,
    "blockTime" TIMESTAMPTZ(6) NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "token_watermarks_pkey" PRIMARY KEY ("tokenId","chainId")
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
    "priceUsd" DECIMAL(100,36),
    "valueUsd" DECIMAL(100,36),
    "blockNumber" BIGINT NOT NULL,
    "blockHash" VARCHAR(66) NOT NULL,
    "blockTime" TIMESTAMPTZ(6) NOT NULL,
    "canonical" BOOLEAN NOT NULL DEFAULT true,
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
    "volumeUsd" DECIMAL(100,36) NOT NULL,
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
    "lowerTick" INTEGER NOT NULL,
    "upperTick" INTEGER NOT NULL,
    "tokenInventoryRaw" DECIMAL(78,0) NOT NULL,
    "tokenRemainingRaw" DECIMAL(78,0) NOT NULL,
    "quoteProceedsRaw" DECIMAL(78,0) NOT NULL,
    "creatorHarvestRaw" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "buybackHarvestRaw" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "protocolHarvestRaw" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "lpHarvestRaw" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "feeBps" INTEGER NOT NULL,
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
CREATE UNIQUE INDEX "profile_links_walletAddress_kind_key" ON "profile_links"("walletAddress", "kind");

-- CreateIndex
CREATE INDEX "tokens_claimedCreatorWallet_createdAt_idx" ON "tokens"("claimedCreatorWallet", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "tokens_createdAt_idx" ON "tokens"("createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "token_metadata_operations_tokenId_key" ON "token_metadata_operations"("tokenId");

-- CreateIndex
CREATE INDEX "token_metadata_operations_status_leaseExpiresAt_idx" ON "token_metadata_operations"("status", "leaseExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "token_deployment_signers_signerAddress_key" ON "token_deployment_signers"("signerAddress");

-- CreateIndex
CREATE UNIQUE INDEX "token_deployment_bindings_signerAddress_key" ON "token_deployment_bindings"("signerAddress");

-- CreateIndex
CREATE UNIQUE INDEX "token_deployment_bindings_configHash_key" ON "token_deployment_bindings"("configHash");

-- CreateIndex
CREATE UNIQUE INDEX "token_deployment_bindings_chainId_transactionHash_logIndex_key" ON "token_deployment_bindings"("chainId", "transactionHash", "logIndex");

-- CreateIndex
CREATE UNIQUE INDEX "token_deployment_bindings_chainId_contractAddress_key" ON "token_deployment_bindings"("chainId", "contractAddress");

-- CreateIndex
CREATE UNIQUE INDEX "token_deployment_bindings_chainId_poolId_key" ON "token_deployment_bindings"("chainId", "poolId");

-- CreateIndex
CREATE INDEX "idempotency_requests_expiresAt_idx" ON "idempotency_requests"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_requests_scope_walletAddress_key_key" ON "idempotency_requests"("scope", "walletAddress", "key");

-- CreateIndex
CREATE INDEX "outbox_events_publishedAt_availableAt_idx" ON "outbox_events"("publishedAt", "availableAt");

-- CreateIndex
CREATE INDEX "token_chain_states_phase_sourceBlockTime_idx" ON "token_chain_states"("phase", "sourceBlockTime");

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
CREATE INDEX "comments_tokenId_parentId_createdAt_idx" ON "comments"("tokenId", "parentId", "createdAt");

-- CreateIndex
CREATE INDEX "comments_tokenId_rootId_createdAt_idx" ON "comments"("tokenId", "rootId", "createdAt");

-- CreateIndex
CREATE INDEX "comments_tokenId_parentId_likeCount_createdAt_idx" ON "comments"("tokenId", "parentId", "likeCount" DESC, "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "comments_id_tokenId_key" ON "comments"("id", "tokenId");

-- AddForeignKey
ALTER TABLE "profile_links" ADD CONSTRAINT "profile_links_walletAddress_fkey" FOREIGN KEY ("walletAddress") REFERENCES "profiles"("walletAddress") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_claimedCreatorWallet_fkey" FOREIGN KEY ("claimedCreatorWallet") REFERENCES "profiles"("walletAddress") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_metadata_operations" ADD CONSTRAINT "token_metadata_operations_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_deployment_signers" ADD CONSTRAINT "token_deployment_signers_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_deployment_signer_secrets" ADD CONSTRAINT "token_deployment_signer_secrets_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "token_deployment_signers"("tokenId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_deployment_bindings" ADD CONSTRAINT "token_deployment_bindings_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "tokens"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

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
ALTER TABLE "comments" ADD CONSTRAINT "comments_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_walletAddress_fkey" FOREIGN KEY ("walletAddress") REFERENCES "profiles"("walletAddress") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "comments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_likes" ADD CONSTRAINT "comment_likes_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_likes" ADD CONSTRAINT "comment_likes_walletAddress_fkey" FOREIGN KEY ("walletAddress") REFERENCES "profiles"("walletAddress") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Application invariants that Prisma cannot express.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE "profiles"
  ADD CONSTRAINT "profiles_wallet_address_check" CHECK ("walletAddress" ~ '^0x[0-9a-f]{40}$'),
  ADD CONSTRAINT "profiles_username_folded_check" CHECK ("usernameFolded" IS NULL OR "usernameFolded" = lower("usernameFolded"));
ALTER TABLE "profile_links"
  ADD CONSTRAINT "profile_links_wallet_address_check" CHECK ("walletAddress" ~ '^0x[0-9a-f]{40}$');
ALTER TABLE "tokens"
  ADD CONSTRAINT "tokens_creator_wallet_check" CHECK ("claimedCreatorWallet" ~ '^0x[0-9a-f]{40}$'),
  ADD CONSTRAINT "tokens_symbol_check" CHECK ("symbol" ~ '^[A-Z0-9]{1,12}$');
ALTER TABLE "token_metadata_operations"
  ADD CONSTRAINT "metadata_attempt_version_check" CHECK ("attemptVersion" >= 1),
  ADD CONSTRAINT "metadata_automated_attempts_check" CHECK ("automatedAttempts" BETWEEN 0 AND 5),
  ADD CONSTRAINT "metadata_manual_generations_check" CHECK ("manualGenerations" BETWEEN 0 AND 3),
  ADD CONSTRAINT "metadata_hash_check" CHECK ("metadataHash" ~ '^0x[0-9a-f]{64}$');
ALTER TABLE "token_deployment_signers"
  ADD CONSTRAINT "deployment_signer_address_check" CHECK ("signerAddress" ~ '^0x[0-9a-f]{40}$'),
  ADD CONSTRAINT "deployment_signer_algorithm_check" CHECK ("algorithm" = 'secp256k1');
ALTER TABLE "token_deployment_signer_secrets"
  ADD CONSTRAINT "deployment_secret_version_check" CHECK ("version" = 1),
  ADD CONSTRAINT "deployment_secret_algorithm_check" CHECK ("algorithm" = 'aes-256-gcm'),
  ADD CONSTRAINT "deployment_secret_iv_check" CHECK (octet_length("iv") = 12),
  ADD CONSTRAINT "deployment_secret_ciphertext_check" CHECK (octet_length("ciphertext") = 32),
  ADD CONSTRAINT "deployment_secret_tag_check" CHECK (octet_length("authTag") = 16);
ALTER TABLE "token_deployment_bindings"
  ADD CONSTRAINT "deployment_binding_chain_check" CHECK ("chainId" > 0),
  ADD CONSTRAINT "deployment_binding_signer_check" CHECK ("signerAddress" ~ '^0x[0-9a-f]{40}$'),
  ADD CONSTRAINT "deployment_binding_config_hash_check" CHECK ("configHash" ~ '^0x[0-9a-f]{64}$'),
  ADD CONSTRAINT "deployment_binding_transaction_hash_check" CHECK ("transactionHash" ~ '^0x[0-9a-f]{64}$'),
  ADD CONSTRAINT "deployment_binding_contract_check" CHECK ("contractAddress" IS NULL OR "contractAddress" ~ '^0x[0-9a-f]{40}$'),
  ADD CONSTRAINT "deployment_binding_pool_check" CHECK ("poolId" IS NULL OR "poolId" ~ '^0x[0-9a-f]{64}$'),
  ADD CONSTRAINT "deployment_binding_log_index_check" CHECK ("logIndex" >= 0);
ALTER TABLE "idempotency_requests"
  ADD CONSTRAINT "idempotency_wallet_check" CHECK ("walletAddress" ~ '^0x[0-9a-f]{40}$'),
  ADD CONSTRAINT "idempotency_key_check" CHECK ("key" ~ '^[ -~]{1,128}$'),
  ADD CONSTRAINT "idempotency_request_hash_check" CHECK ("requestHash" ~ '^0x[0-9a-f]{64}$');
ALTER TABLE "token_chain_states"
  ADD CONSTRAINT "chain_state_chain_check" CHECK ("chainId" > 0),
  ADD CONSTRAINT "chain_state_contract_check" CHECK ("contractAddress" ~ '^0x[0-9a-f]{40}$'),
  ADD CONSTRAINT "chain_state_pool_check" CHECK ("poolId" ~ '^0x[0-9a-f]{64}$'),
  ADD CONSTRAINT "chain_state_creator_check" CHECK ("launchCreatorWallet" ~ '^0x[0-9a-f]{40}$'),
  ADD CONSTRAINT "chain_state_owner_check" CHECK ("creatorRevenueOwner" IS NULL OR "creatorRevenueOwner" ~ '^0x[0-9a-f]{40}$'),
  ADD CONSTRAINT "chain_state_hash_check" CHECK ("sourceBlockHash" ~ '^0x[0-9a-f]{64}$'),
  ADD CONSTRAINT "chain_state_uints_check" CHECK ("totalSupply" >= 0 AND "totalSupply" <= 115792089237316195423570985008687907853269984665640564039457584007913129639935 AND ("creatorRevenueNftId" IS NULL OR ("creatorRevenueNftId" >= 0 AND "creatorRevenueNftId" <= 115792089237316195423570985008687907853269984665640564039457584007913129639935))),
  ADD CONSTRAINT "chain_state_decimals_check" CHECK ("decimals" BETWEEN 0 AND 255),
  ADD CONSTRAINT "chain_state_allocations_check" CHECK ("curveAllocationBps" = 2500 AND "milestoneAllocationBps" = 6500 AND "fullRangeAllocationBps" = 1000),
  ADD CONSTRAINT "chain_state_curve_count_check" CHECK ("curveCount" = 32),
  ADD CONSTRAINT "chain_state_milestones_check" CHECK ("completedCoreMilestones" BETWEEN 0 AND 30 AND "completedExtraMilestones" BETWEEN 0 AND 30),
  ADD CONSTRAINT "chain_state_fee_check" CHECK ("feeBps" IN (50, 75, 100)),
  ADD CONSTRAINT "chain_state_harvest_split_check" CHECK (
    "creatorHarvestSplitWad" BETWEEN 0 AND 0.7
    AND "buybackHarvestSplitWad" >= 0.1
    AND "protocolHarvestSplitWad" >= 0.05
    AND "lpHarvestSplitWad" >= 0
    AND "creatorHarvestSplitWad" + "buybackHarvestSplitWad" + "protocolHarvestSplitWad" + "lpHarvestSplitWad" = 1
  );
ALTER TABLE "token_metrics"
  ADD CONSTRAINT "token_metric_chain_check" CHECK ("chainId" > 0),
  ADD CONSTRAINT "token_metric_values_check" CHECK (("priceUsd" IS NULL OR "priceUsd" >= 0) AND ("marketCapUsd" IS NULL OR "marketCapUsd" >= 0) AND ("volumeUsd" IS NULL OR "volumeUsd" >= 0) AND ("tradeCount" IS NULL OR "tradeCount" >= 0) AND ("holderCount" IS NULL OR "holderCount" >= 0));
ALTER TABLE "chain_watermarks"
  ADD CONSTRAINT "chain_watermark_chain_check" CHECK ("chainId" > 0),
  ADD CONSTRAINT "chain_watermark_hash_check" CHECK ("blockHash" ~ '^0x[0-9a-f]{64}$');
ALTER TABLE "token_watermarks"
  ADD CONSTRAINT "token_watermark_chain_check" CHECK ("chainId" > 0),
  ADD CONSTRAINT "token_watermark_hash_check" CHECK ("blockHash" ~ '^0x[0-9a-f]{64}$');
ALTER TABLE "trades"
  ADD CONSTRAINT "trade_chain_check" CHECK ("chainId" > 0),
  ADD CONSTRAINT "trade_transaction_hash_check" CHECK ("transactionHash" ~ '^0x[0-9a-f]{64}$'),
  ADD CONSTRAINT "trade_block_hash_check" CHECK ("blockHash" ~ '^0x[0-9a-f]{64}$'),
  ADD CONSTRAINT "trade_wallet_check" CHECK ("traderWallet" ~ '^0x[0-9a-f]{40}$'),
  ADD CONSTRAINT "trade_indexes_check" CHECK ("logIndex" >= 0 AND "transactionIndex" >= 0),
  ADD CONSTRAINT "trade_amounts_check" CHECK ("tokenAmountRaw" >= 0 AND "tokenAmountRaw" <= 115792089237316195423570985008687907853269984665640564039457584007913129639935 AND "quoteAmountRaw" >= 0 AND "quoteAmountRaw" <= 115792089237316195423570985008687907853269984665640564039457584007913129639935),
  ADD CONSTRAINT "trade_values_check" CHECK (("priceUsd" IS NULL OR "priceUsd" >= 0) AND ("valueUsd" IS NULL OR "valueUsd" >= 0));
ALTER TABLE "candles"
  ADD CONSTRAINT "candle_chain_check" CHECK ("chainId" > 0),
  ADD CONSTRAINT "candle_values_check" CHECK ("open" >= 0 AND "high" >= "low" AND "low" >= 0 AND "close" >= 0 AND "volumeUsd" >= 0 AND "tradeCount" >= 0);
ALTER TABLE "milestones"
  ADD CONSTRAINT "milestone_chain_check" CHECK ("chainId" > 0),
  ADD CONSTRAINT "milestone_index_check" CHECK (("kind" = 'CORE' AND "index" BETWEEN 0 AND 29) OR ("kind" = 'EXTENSION' AND "index" BETWEEN 0 AND 29)),
  ADD CONSTRAINT "milestone_ticks_check" CHECK ("upperTick" > "lowerTick"),
  ADD CONSTRAINT "milestone_amounts_check" CHECK ("tokenInventoryRaw" >= 0 AND "tokenRemainingRaw" >= 0 AND "tokenRemainingRaw" <= "tokenInventoryRaw" AND "quoteProceedsRaw" >= 0 AND "creatorHarvestRaw" >= 0 AND "buybackHarvestRaw" >= 0 AND "protocolHarvestRaw" >= 0 AND "lpHarvestRaw" >= 0),
  ADD CONSTRAINT "milestone_fee_check" CHECK ("feeBps" IN (50, 75, 100));
ALTER TABLE "holdings"
  ADD CONSTRAINT "holding_wallet_check" CHECK ("walletAddress" ~ '^0x[0-9a-f]{40}$'),
  ADD CONSTRAINT "holding_chain_check" CHECK ("chainId" > 0),
  ADD CONSTRAINT "holding_values_check" CHECK ("balanceRaw" >= 0 AND "balanceRaw" <= 115792089237316195423570985008687907853269984665640564039457584007913129639935 AND ("valueUsd" IS NULL OR "valueUsd" >= 0));
ALTER TABLE "comments"
  ADD CONSTRAINT "comment_wallet_check" CHECK ("walletAddress" ~ '^0x[0-9a-f]{40}$'),
  ADD CONSTRAINT "comment_depth_check" CHECK ("depth" BETWEEN 0 AND 3),
  ADD CONSTRAINT "comment_counts_check" CHECK ("likeCount" >= 0 AND "replyCount" >= 0),
  ADD CONSTRAINT "comment_tombstone_check" CHECK (("isDeleted" AND "text" IS NULL AND "deletedAt" IS NOT NULL) OR (NOT "isDeleted" AND "text" IS NOT NULL AND "deletedAt" IS NULL));
ALTER TABLE "comment_likes"
  ADD CONSTRAINT "comment_like_wallet_check" CHECK ("walletAddress" ~ '^0x[0-9a-f]{40}$');

CREATE INDEX "tokens_search_trgm_idx" ON "tokens" USING GIN (("name" || ' ' || "symbol") gin_trgm_ops);
CREATE INDEX "tokens_search_fts_idx" ON "tokens" USING GIN (to_tsvector('simple', "name" || ' ' || "symbol"));
CREATE INDEX "candles_token_chain_interval_bucket_desc_idx" ON "candles" ("tokenId", "chainId", "interval", "bucketStart" DESC);
CREATE INDEX "outbox_unpublished_idx" ON "outbox_events" ("availableAt", "createdAt") WHERE "publishedAt" IS NULL;

ALTER TABLE "comments" DROP CONSTRAINT "comments_parentId_fkey";
ALTER TABLE "comments" ADD CONSTRAINT "comments_parent_token_fkey"
  FOREIGN KEY ("parentId", "tokenId") REFERENCES "comments"("id", "tokenId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "comments" ADD CONSTRAINT "comments_root_token_fkey"
  FOREIGN KEY ("rootId", "tokenId") REFERENCES "comments"("id", "tokenId") DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION enforce_comment_ancestry() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE parent_row "comments"%ROWTYPE;
BEGIN
  IF NEW."parentId" IS NULL THEN
    NEW."depth" := 0;
    NEW."rootId" := NEW."id";
  ELSE
    SELECT * INTO parent_row FROM "comments" WHERE "id" = NEW."parentId" AND "tokenId" = NEW."tokenId" FOR KEY SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'comment parent not found for token' USING ERRCODE = '23503'; END IF;
    IF parent_row."isDeleted" THEN RAISE EXCEPTION 'cannot reply to a deleted comment' USING ERRCODE = '23514'; END IF;
    IF parent_row."depth" >= 3 THEN RAISE EXCEPTION 'maximum comment depth exceeded' USING ERRCODE = '23514'; END IF;
    NEW."depth" := parent_row."depth" + 1;
    NEW."rootId" := parent_row."rootId";
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER comments_ancestry_before_write BEFORE INSERT OR UPDATE OF "parentId", "tokenId" ON "comments"
FOR EACH ROW EXECUTE FUNCTION enforce_comment_ancestry();
CREATE OR REPLACE FUNCTION insert_token_deployment_secret(
  p_token_id uuid,
  p_version integer,
  p_algorithm varchar,
  p_key_id varchar,
  p_iv bytea,
  p_ciphertext bytea,
  p_auth_tag bytea
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  INSERT INTO token_deployment_signer_secrets
    ("tokenId", "version", "algorithm", "keyId", "iv", "ciphertext", "authTag", "createdAt")
  VALUES
    (p_token_id, p_version, p_algorithm, p_key_id, p_iv, p_ciphertext, p_auth_tag, CURRENT_TIMESTAMP);
$$;
REVOKE ALL ON FUNCTION insert_token_deployment_secret(uuid, integer, varchar, varchar, bytea, bytea, bytea) FROM PUBLIC;
CREATE OR REPLACE FUNCTION has_token_deployment_secret(p_token_id uuid) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS(
    SELECT 1 FROM token_deployment_signer_secrets WHERE "tokenId" = p_token_id
  );
$$;
REVOKE ALL ON FUNCTION has_token_deployment_secret(uuid) FROM PUBLIC;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'spawn_owner') THEN CREATE ROLE spawn_owner NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'spawn_migration') THEN CREATE ROLE spawn_migration LOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'spawn_api') THEN CREATE ROLE spawn_api LOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'spawn_metadata_worker') THEN CREATE ROLE spawn_metadata_worker LOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'spawn_seed') THEN CREATE ROLE spawn_seed LOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'spawn_indexer') THEN CREATE ROLE spawn_indexer LOGIN; END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO spawn_api, spawn_metadata_worker, spawn_seed, spawn_indexer;
GRANT SELECT, INSERT, UPDATE, DELETE ON profiles, profile_links, tokens, token_metadata_operations,
  token_deployment_signers, idempotency_requests, outbox_events, domain_generations, comments, comment_likes TO spawn_api;
GRANT SELECT ON token_deployment_bindings, token_chain_states, token_metrics, chain_watermarks, token_watermarks,
  trades, candles, milestones, holdings TO spawn_api;
GRANT EXECUTE ON FUNCTION insert_token_deployment_secret(uuid, integer, varchar, varchar, bytea, bytea, bytea) TO spawn_api;
REVOKE ALL ON token_deployment_signer_secrets FROM spawn_api, spawn_metadata_worker, spawn_indexer;
GRANT SELECT, INSERT, UPDATE, DELETE ON profiles, tokens, token_metadata_operations, token_deployment_signers,
  token_deployment_bindings, outbox_events, domain_generations, token_chain_states, token_metrics,
  chain_watermarks, token_watermarks, trades, candles, milestones, holdings, comments, comment_likes TO spawn_seed;
GRANT EXECUTE ON FUNCTION insert_token_deployment_secret(uuid, integer, varchar, varchar, bytea, bytea, bytea) TO spawn_seed;
GRANT EXECUTE ON FUNCTION has_token_deployment_secret(uuid) TO spawn_seed;
GRANT SELECT, INSERT, UPDATE ON outbox_events TO spawn_metadata_worker;
GRANT SELECT, UPDATE ON token_metadata_operations TO spawn_metadata_worker;
GRANT SELECT ON tokens TO spawn_metadata_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON token_deployment_bindings, token_chain_states, token_metrics,
  chain_watermarks, token_watermarks, trades, candles, milestones, holdings TO spawn_indexer;
GRANT SELECT ON tokens, token_deployment_signers TO spawn_indexer;
REVOKE INSERT, UPDATE, DELETE ON token_deployment_bindings, token_chain_states, token_metrics,
  chain_watermarks, token_watermarks, trades, candles, milestones, holdings FROM spawn_api, spawn_metadata_worker;
