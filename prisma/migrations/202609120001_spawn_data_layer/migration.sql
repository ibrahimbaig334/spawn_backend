-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Timeframe" AS ENUM ('H1', 'H24', 'D7', 'D30', 'ALL');

-- CreateEnum
CREATE TYPE "PoolStatus" AS ENUM ('bonding', 'graduated');

-- CreateEnum
CREATE TYPE "BandStatus" AS ENUM ('live', 'completed');

-- CreateEnum
CREATE TYPE "PluginRole" AS ENUM ('INVALID', 'PAYOUT', 'CREATOR_SYSTEM', 'UTILITY');

-- CreateEnum
CREATE TYPE "AccrualSource" AS ENUM ('CURVE_PROCEEDS', 'SWAP_FEES', 'MILESTONE_HARVEST');

-- CreateEnum
CREATE TYPE "PayoutOutcome" AS ENUM ('delivered', 'carried', 'redirected');

-- CreateEnum
CREATE TYPE "ClaimType" AS ENUM ('creator', 'creatorPath', 'protocol');

-- CreateEnum
CREATE TYPE "GovernanceAction" AS ENUM ('SET_ECONOMIC_CONFIG', 'SET_PROTOCOL_RECIPIENT', 'REGISTER_PLUGIN', 'SET_PLUGIN_SUSPENDED', 'SET_GOVERNANCE_DELAY', 'SET_TRUSTED_OPERATOR');

-- CreateEnum
CREATE TYPE "GovernanceStatus" AS ENUM ('SCHEDULED', 'CANCELLED', 'EXECUTED');

-- CreateEnum
CREATE TYPE "IdempotencyState" AS ENUM ('IN_PROGRESS', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "LaunchRecordState" AS ENUM ('PENDING_RELAY', 'SUBMITTED', 'CONFIRMED', 'REORGED', 'FAILED');

-- CreateEnum
CREATE TYPE "TokenSource" AS ENUM ('API', 'INDEXER');

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
    "chain_id" INTEGER NOT NULL DEFAULT 8453,
    "token" VARCHAR(42),
    "name" VARCHAR(320) NOT NULL,
    "symbol" VARCHAR(12) NOT NULL,
    "uri" VARCHAR(2048) NOT NULL DEFAULT '',
    "description" VARCHAR(8000),
    "imageUri" VARCHAR(512),
    "ipfsUri" VARCHAR(512),
    "gatewayUrl" VARCHAR(2048),
    "socials" JSONB,
    "claimedCreatorWallet" VARCHAR(42),
    "source" "TokenSource" NOT NULL DEFAULT 'INDEXER',
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
    "uri" VARCHAR(2048) NOT NULL,
    "description" VARCHAR(8000) NOT NULL,
    "imageUri" VARCHAR(512) NOT NULL,
    "ipfsUri" VARCHAR(512),
    "gatewayUrl" VARCHAR(2048),
    "socials" JSONB,
    "totalSupply" DECIMAL(78,0) NOT NULL,
    "devBuyShareWad" DECIMAL(38,18) NOT NULL,
    "payoutPlan" DECIMAL(78,0) NOT NULL,
    "deadline" BIGINT NOT NULL,
    "configHash" VARCHAR(66) NOT NULL,
    "predictedToken" VARCHAR(42) NOT NULL,
    "digest" VARCHAR(66) NOT NULL,
    "state" "LaunchRecordState" NOT NULL DEFAULT 'PENDING_RELAY',
    "transactionHash" VARCHAR(66),
    "blockNumber" BIGINT,
    "submittedAt" TIMESTAMPTZ(6),
    "confirmedAt" TIMESTAMPTZ(6),
    "failureReason" VARCHAR(1000),
    "tokenDbId" UUID,
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
CREATE TABLE "comments" (
    "id" UUID NOT NULL,
    "tokenDbId" UUID NOT NULL,
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
    "chain_id" INTEGER NOT NULL,
    "block_number" BIGINT NOT NULL,
    "log_index" INTEGER NOT NULL,
    "transaction_index" INTEGER NOT NULL,
    "tx_hash" VARCHAR(66) NOT NULL,
    "address" VARCHAR(42) NOT NULL,
    "topic0" VARCHAR(66) NOT NULL,
    "topics" VARCHAR(66)[],
    "data" VARCHAR(8192) NOT NULL,
    "event_name" VARCHAR(64),
    "block_hash" VARCHAR(66) NOT NULL,
    "timestamp" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "raw_chain_events_pkey" PRIMARY KEY ("chain_id","block_number","log_index")
);

-- CreateTable
CREATE TABLE "pools" (
    "chain_id" INTEGER NOT NULL DEFAULT 8453,
    "pool_id" VARCHAR(66) NOT NULL,
    "status" "PoolStatus" NOT NULL DEFAULT 'bonding',
    "token" VARCHAR(42) NOT NULL,
    "creator" VARCHAR(42) NOT NULL,
    "total_supply" DECIMAL(78,0) NOT NULL,
    "opening_level" INTEGER NOT NULL,
    "far_level" INTEGER NOT NULL,
    "graduation_level" INTEGER,
    "payout_plan" DECIMAL(78,0) NOT NULL,
    "dev_buy_share_wad" DECIMAL(38,18) NOT NULL,
    "config_hash" VARCHAR(66) NOT NULL,
    "wall_liquidity" DECIMAL(78,0),
    "wall_full_range_liquidity" DECIMAL(78,0),
    "revenue_nft_owner" VARCHAR(42),
    "revenue_nft_token_id" DECIMAL(78,0),
    "launch_block" BIGINT NOT NULL,
    "launch_time" TIMESTAMPTZ(6) NOT NULL,
    "graduation_block" BIGINT,
    "graduation_time" TIMESTAMPTZ(6),
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "tokenDbId" UUID,

    CONSTRAINT "pools_pkey" PRIMARY KEY ("chain_id","pool_id")
);

-- CreateTable
CREATE TABLE "bands" (
    "chain_id" INTEGER NOT NULL DEFAULT 8453,
    "pool_id" VARCHAR(66) NOT NULL,
    "band_index" INTEGER NOT NULL,
    "status" "BandStatus" NOT NULL DEFAULT 'live',
    "level_lower" INTEGER NOT NULL,
    "level_upper" INTEGER NOT NULL,
    "liquidity" DECIMAL(78,0) NOT NULL,
    "token_inventory" DECIMAL(78,0) NOT NULL,
    "deployed_block" BIGINT NOT NULL,
    "deployed_time" TIMESTAMPTZ(6) NOT NULL,
    "completed_block" BIGINT,
    "completed_time" TIMESTAMPTZ(6),

    CONSTRAINT "bands_pkey" PRIMARY KEY ("chain_id","pool_id","band_index")
);

-- CreateTable
CREATE TABLE "pots" (
    "chain_id" INTEGER NOT NULL DEFAULT 8453,
    "pool_id" VARCHAR(66) NOT NULL,
    "balance" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "funded_total" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "service_fee_total" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pots_pkey" PRIMARY KEY ("chain_id","pool_id")
);

-- CreateTable
CREATE TABLE "plugin_registry" (
    "chain_id" INTEGER NOT NULL DEFAULT 8453,
    "registry_index" INTEGER NOT NULL,
    "plugin" VARCHAR(42) NOT NULL,
    "take_wad" DECIMAL(38,18) NOT NULL,
    "gas_limit" INTEGER NOT NULL,
    "code_hash" VARCHAR(66) NOT NULL,
    "role" "PluginRole" NOT NULL,
    "suspended" BOOLEAN NOT NULL DEFAULT false,
    "registered_block" BIGINT NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "plugin_registry_pkey" PRIMARY KEY ("chain_id","registry_index")
);

-- CreateTable
CREATE TABLE "economic_configs" (
    "chain_id" INTEGER NOT NULL DEFAULT 8453,
    "version" BIGINT NOT NULL,
    "harvest_service_fee_wad" DECIMAL(38,18) NOT NULL,
    "quote_creator_share_wad" DECIMAL(38,18) NOT NULL,
    "token_milestone_fund_share_wad" DECIMAL(38,18) NOT NULL,
    "effective_block" BIGINT NOT NULL,
    "effective_time" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "economic_configs_pkey" PRIMARY KEY ("chain_id","version")
);

-- CreateTable
CREATE TABLE "protocol_state" (
    "chain_id" INTEGER NOT NULL DEFAULT 8453,
    "economic_version" BIGINT NOT NULL DEFAULT 1,
    "protocol_recipient" VARCHAR(42),
    "trusted_operator" VARCHAR(42),
    "trusted_operator_set_block" BIGINT,
    "administrator" VARCHAR(42),
    "pending_administrator" VARCHAR(42),
    "governance_delay_seconds" BIGINT,
    "last_indexed_block" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "protocol_state_pkey" PRIMARY KEY ("chain_id")
);

-- CreateTable
CREATE TABLE "governance_operations" (
    "chain_id" INTEGER NOT NULL DEFAULT 8453,
    "operation_id" VARCHAR(66) NOT NULL,
    "action" "GovernanceAction" NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "GovernanceStatus" NOT NULL DEFAULT 'SCHEDULED',
    "ready_at" TIMESTAMPTZ(6),
    "executed_at_block" BIGINT,
    "cancelled_at_block" BIGINT,
    "timestamp" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "governance_operations_pkey" PRIMARY KEY ("chain_id","operation_id")
);

-- CreateTable
CREATE TABLE "pool_stats" (
    "chain_id" INTEGER NOT NULL DEFAULT 8453,
    "pool_id" VARCHAR(66) NOT NULL,
    "buy_volume_eth" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "sell_volume_eth" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "buy_volume_tokens" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "sell_volume_tokens" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "swap_count" BIGINT NOT NULL DEFAULT 0,
    "last_price_sqrt_x96" DECIMAL(78,0) NOT NULL,
    "ath_sqrt_x96" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "creator_revenue_total" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "creator_revenue_curve" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "creator_revenue_swap_fees" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "protocol_revenue_total" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "protocol_revenue_curve" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "protocol_revenue_swap_fees" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "protocol_revenue_harvest_fees" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "creator_path_revenue_total" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "plugin_revenue_total" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "pot_funded_total" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "tips_total" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "bands_deployed" INTEGER NOT NULL DEFAULT 0,
    "harvest_count" INTEGER NOT NULL DEFAULT 0,
    "harvest_quote_total" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "swap_fee_burned_tokens" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "burned_total" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "last_swap_block" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pool_stats_pkey" PRIMARY KEY ("chain_id","pool_id")
);

-- CreateTable
CREATE TABLE "pool_minute_stats" (
    "chain_id" BIGINT NOT NULL DEFAULT 8453,
    "pool_id" VARCHAR(66) NOT NULL,
    "minute" TIMESTAMPTZ(6) NOT NULL,
    "open_sqrt_x96" DECIMAL(78,0) NOT NULL,
    "close_sqrt_x96" DECIMAL(78,0) NOT NULL,
    "high_sqrt_x96" DECIMAL(78,0) NOT NULL,
    "low_sqrt_x96" DECIMAL(78,0) NOT NULL,
    "buy_volume_eth" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "sell_volume_eth" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "buy_volume_tokens" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "sell_volume_tokens" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "swap_count" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pool_minute_stats_pkey" PRIMARY KEY ("chain_id","pool_id","minute")
);

-- CreateTable
CREATE TABLE "pool_hour_stats" (
    "chain_id" BIGINT NOT NULL DEFAULT 8453,
    "pool_id" VARCHAR(66) NOT NULL,
    "hour" TIMESTAMPTZ(6) NOT NULL,
    "open_sqrt_x96" DECIMAL(78,0) NOT NULL,
    "close_sqrt_x96" DECIMAL(78,0) NOT NULL,
    "high_sqrt_x96" DECIMAL(78,0) NOT NULL,
    "low_sqrt_x96" DECIMAL(78,0) NOT NULL,
    "buy_volume_eth" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "sell_volume_eth" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "buy_volume_tokens" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "sell_volume_tokens" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "swap_count" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pool_hour_stats_pkey" PRIMARY KEY ("chain_id","pool_id","hour")
);

-- CreateTable
CREATE TABLE "pool_day_stats" (
    "chain_id" BIGINT NOT NULL DEFAULT 8453,
    "pool_id" VARCHAR(66) NOT NULL,
    "day" TIMESTAMPTZ(6) NOT NULL,
    "open_sqrt_x96" DECIMAL(78,0) NOT NULL,
    "close_sqrt_x96" DECIMAL(78,0) NOT NULL,
    "high_sqrt_x96" DECIMAL(78,0) NOT NULL,
    "low_sqrt_x96" DECIMAL(78,0) NOT NULL,
    "buy_volume_eth" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "sell_volume_eth" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "buy_volume_tokens" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "sell_volume_tokens" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "swap_count" BIGINT NOT NULL DEFAULT 0,
    "creator_revenue_eth" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "protocol_revenue_eth" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pool_day_stats_pkey" PRIMARY KEY ("chain_id","pool_id","day")
);

-- CreateTable
CREATE TABLE "protocol_day_stats" (
    "chain_id" BIGINT NOT NULL DEFAULT 8453,
    "day" TIMESTAMPTZ(6) NOT NULL,
    "buy_volume_eth" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "sell_volume_eth" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "swap_count" BIGINT NOT NULL DEFAULT 0,
    "creator_revenue_eth" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "protocol_revenue_eth" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "harvest_fees_eth" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "graduation_count" INTEGER NOT NULL DEFAULT 0,
    "launch_count" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "protocol_day_stats_pkey" PRIMARY KEY ("chain_id","day")
);

-- CreateTable
CREATE TABLE "protocol_stats" (
    "chain_id" BIGINT NOT NULL DEFAULT 8453,
    "protocol_revenue_curve" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "protocol_revenue_swap_fees" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "protocol_revenue_harvest_fees" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "protocol_revenue_total" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "claimed_total" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "protocol_stats_pkey" PRIMARY KEY ("chain_id")
);

-- CreateTable
CREATE TABLE "launches" (
    "chain_id" INTEGER NOT NULL DEFAULT 8453,
    "ordinal_key" VARCHAR(40) NOT NULL,
    "pool_id" VARCHAR(66) NOT NULL,
    "creator" VARCHAR(42) NOT NULL,
    "token" VARCHAR(42) NOT NULL,
    "name" VARCHAR(320) NOT NULL,
    "symbol" VARCHAR(12) NOT NULL,
    "uri" VARCHAR(2048) NOT NULL,
    "total_supply" DECIMAL(78,0) NOT NULL,
    "opening_level" INTEGER NOT NULL,
    "far_level" INTEGER NOT NULL,
    "config_hash" VARCHAR(66) NOT NULL,
    "tx_hash" VARCHAR(66) NOT NULL,
    "log_index" INTEGER NOT NULL,
    "block_number" BIGINT NOT NULL,
    "timestamp" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "launches_pkey" PRIMARY KEY ("chain_id","ordinal_key")
);

-- CreateTable
CREATE TABLE "graduations" (
    "chain_id" INTEGER NOT NULL DEFAULT 8453,
    "ordinal_key" VARCHAR(40) NOT NULL,
    "pool_id" VARCHAR(66) NOT NULL,
    "graduation_level" INTEGER NOT NULL,
    "quote_proceeds" DECIMAL(78,0) NOT NULL,
    "lp_seed_quote" DECIMAL(78,0) NOT NULL,
    "creator_quote" DECIMAL(78,0) NOT NULL,
    "protocol_quote" DECIMAL(78,0) NOT NULL,
    "full_range_liquidity" DECIMAL(78,0) NOT NULL,
    "wall_liquidity" DECIMAL(78,0) NOT NULL,
    "tx_hash" VARCHAR(66) NOT NULL,
    "log_index" INTEGER NOT NULL,
    "block_number" BIGINT NOT NULL,
    "timestamp" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "graduations_pkey" PRIMARY KEY ("chain_id","ordinal_key")
);

-- CreateTable
CREATE TABLE "swaps" (
    "chain_id" INTEGER NOT NULL DEFAULT 8453,
    "ordinal_key" VARCHAR(40) NOT NULL,
    "pool_id" VARCHAR(66) NOT NULL,
    "sender" VARCHAR(42) NOT NULL,
    "is_buy" BOOLEAN NOT NULL,
    "amount0_eth" DECIMAL(78,0) NOT NULL,
    "amount1_tokens" DECIMAL(78,0) NOT NULL,
    "sqrt_price_x96" DECIMAL(78,0) NOT NULL,
    "tick" INTEGER NOT NULL,
    "fee" INTEGER NOT NULL,
    "fee_eth" DECIMAL(78,0) NOT NULL,
    "fee_tokens" DECIMAL(78,0) NOT NULL,
    "tx_hash" VARCHAR(66) NOT NULL,
    "log_index" INTEGER NOT NULL,
    "block_number" BIGINT NOT NULL,
    "timestamp" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "swaps_pkey" PRIMARY KEY ("chain_id","ordinal_key")
);

-- CreateTable
CREATE TABLE "curve_deployments" (
    "chain_id" INTEGER NOT NULL DEFAULT 8453,
    "ordinal_key" VARCHAR(40) NOT NULL,
    "pool_id" VARCHAR(66) NOT NULL,
    "minted" DECIMAL(78,0) NOT NULL,
    "deployed" DECIMAL(78,0) NOT NULL,
    "token_settled" DECIMAL(78,0) NOT NULL,
    "tx_hash" VARCHAR(66) NOT NULL,
    "log_index" INTEGER NOT NULL,
    "block_number" BIGINT NOT NULL,
    "timestamp" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "curve_deployments_pkey" PRIMARY KEY ("chain_id","ordinal_key")
);

-- CreateTable
CREATE TABLE "milestone_harvests" (
    "chain_id" INTEGER NOT NULL DEFAULT 8453,
    "ordinal_key" VARCHAR(40) NOT NULL,
    "pool_id" VARCHAR(66) NOT NULL,
    "band_index" INTEGER NOT NULL,
    "quote_proceeds" DECIMAL(78,0) NOT NULL,
    "token_residue" DECIMAL(78,0) NOT NULL,
    "completed_milestones" INTEGER NOT NULL,
    "tx_hash" VARCHAR(66) NOT NULL,
    "log_index" INTEGER NOT NULL,
    "block_number" BIGINT NOT NULL,
    "timestamp" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "milestone_harvests_pkey" PRIMARY KEY ("chain_id","ordinal_key")
);

-- CreateTable
CREATE TABLE "harvest_payouts" (
    "chain_id" INTEGER NOT NULL DEFAULT 8453,
    "ordinal_key" VARCHAR(40) NOT NULL,
    "pool_id" VARCHAR(66) NOT NULL,
    "milestone_index" INTEGER NOT NULL,
    "gross_quote" DECIMAL(78,0) NOT NULL,
    "service_fee" DECIMAL(78,0) NOT NULL,
    "net_quote" DECIMAL(78,0) NOT NULL,
    "economic_version" BIGINT NOT NULL,
    "tx_hash" VARCHAR(66) NOT NULL,
    "log_index" INTEGER NOT NULL,
    "block_number" BIGINT NOT NULL,
    "timestamp" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "harvest_payouts_pkey" PRIMARY KEY ("chain_id","ordinal_key")
);

-- CreateTable
CREATE TABLE "band_skips" (
    "chain_id" INTEGER NOT NULL DEFAULT 8453,
    "ordinal_key" VARCHAR(40) NOT NULL,
    "pool_id" VARCHAR(66) NOT NULL,
    "band_index" INTEGER NOT NULL,
    "carried_inventory" DECIMAL(78,0) NOT NULL,
    "tx_hash" VARCHAR(66) NOT NULL,
    "log_index" INTEGER NOT NULL,
    "block_number" BIGINT NOT NULL,
    "timestamp" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "band_skips_pkey" PRIMARY KEY ("chain_id","ordinal_key")
);

-- CreateTable
CREATE TABLE "dev_buys" (
    "chain_id" INTEGER NOT NULL DEFAULT 8453,
    "ordinal_key" VARCHAR(40) NOT NULL,
    "pool_id" VARCHAR(66) NOT NULL,
    "tokens_bought" DECIMAL(78,0) NOT NULL,
    "eth_spent" DECIMAL(78,0) NOT NULL,
    "tx_hash" VARCHAR(66) NOT NULL,
    "log_index" INTEGER NOT NULL,
    "block_number" BIGINT NOT NULL,
    "timestamp" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "dev_buys_pkey" PRIMARY KEY ("chain_id","ordinal_key")
);

-- CreateTable
CREATE TABLE "dev_buy_skips" (
    "chain_id" INTEGER NOT NULL DEFAULT 8453,
    "ordinal_key" VARCHAR(40) NOT NULL,
    "pool_id" VARCHAR(66) NOT NULL,
    "relayer" VARCHAR(42) NOT NULL,
    "tokens_requested" DECIMAL(78,0) NOT NULL,
    "tx_hash" VARCHAR(66) NOT NULL,
    "log_index" INTEGER NOT NULL,
    "block_number" BIGINT NOT NULL,
    "timestamp" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "dev_buy_skips_pkey" PRIMARY KEY ("chain_id","ordinal_key")
);

-- CreateTable
CREATE TABLE "payout_pot_fundings" (
    "chain_id" INTEGER NOT NULL DEFAULT 8453,
    "ordinal_key" VARCHAR(40) NOT NULL,
    "pool_id" VARCHAR(66) NOT NULL,
    "milestone_index" INTEGER NOT NULL,
    "gross_quote" DECIMAL(78,0) NOT NULL,
    "service_fee" DECIMAL(78,0) NOT NULL,
    "net_quote" DECIMAL(78,0) NOT NULL,
    "economic_version" BIGINT NOT NULL,
    "tx_hash" VARCHAR(66) NOT NULL,
    "log_index" INTEGER NOT NULL,
    "block_number" BIGINT NOT NULL,
    "timestamp" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "payout_pot_fundings_pkey" PRIMARY KEY ("chain_id","ordinal_key")
);

-- CreateTable
CREATE TABLE "payout_pot_redemptions" (
    "chain_id" INTEGER NOT NULL DEFAULT 8453,
    "ordinal_key" VARCHAR(40) NOT NULL,
    "pool_id" VARCHAR(66) NOT NULL,
    "amount" DECIMAL(78,0) NOT NULL,
    "tx_hash" VARCHAR(66) NOT NULL,
    "log_index" INTEGER NOT NULL,
    "block_number" BIGINT NOT NULL,
    "timestamp" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "payout_pot_redemptions_pkey" PRIMARY KEY ("chain_id","ordinal_key")
);

-- CreateTable
CREATE TABLE "payout_tips" (
    "chain_id" INTEGER NOT NULL DEFAULT 8453,
    "ordinal_key" VARCHAR(40) NOT NULL,
    "pool_id" VARCHAR(66) NOT NULL,
    "recipient" VARCHAR(42) NOT NULL,
    "amount" DECIMAL(78,0) NOT NULL,
    "tx_hash" VARCHAR(66) NOT NULL,
    "log_index" INTEGER NOT NULL,
    "block_number" BIGINT NOT NULL,
    "timestamp" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "payout_tips_pkey" PRIMARY KEY ("chain_id","ordinal_key")
);

-- CreateTable
CREATE TABLE "plugin_payouts" (
    "chain_id" INTEGER NOT NULL DEFAULT 8453,
    "ordinal_key" VARCHAR(40) NOT NULL,
    "pool_id" VARCHAR(66) NOT NULL,
    "plugin_index" INTEGER NOT NULL,
    "plugin" VARCHAR(42),
    "outcome" "PayoutOutcome" NOT NULL,
    "current_share" DECIMAL(78,0) NOT NULL,
    "previous_carry" DECIMAL(78,0) NOT NULL,
    "amount" DECIMAL(78,0) NOT NULL,
    "tx_hash" VARCHAR(66) NOT NULL,
    "log_index" INTEGER NOT NULL,
    "block_number" BIGINT NOT NULL,
    "timestamp" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "plugin_payouts_pkey" PRIMARY KEY ("chain_id","ordinal_key")
);

-- CreateTable
CREATE TABLE "creator_accruals" (
    "chain_id" INTEGER NOT NULL DEFAULT 8453,
    "ordinal_key" VARCHAR(40) NOT NULL,
    "pool_id" VARCHAR(66) NOT NULL,
    "amount" DECIMAL(78,0) NOT NULL,
    "source" "AccrualSource" NOT NULL,
    "economic_version" BIGINT NOT NULL,
    "tx_hash" VARCHAR(66) NOT NULL,
    "log_index" INTEGER NOT NULL,
    "block_number" BIGINT NOT NULL,
    "timestamp" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "creator_accruals_pkey" PRIMARY KEY ("chain_id","ordinal_key")
);

-- CreateTable
CREATE TABLE "protocol_accruals" (
    "chain_id" INTEGER NOT NULL DEFAULT 8453,
    "ordinal_key" VARCHAR(40) NOT NULL,
    "pool_id" VARCHAR(66) NOT NULL,
    "amount" DECIMAL(78,0) NOT NULL,
    "source" "AccrualSource" NOT NULL,
    "economic_version" BIGINT NOT NULL,
    "tx_hash" VARCHAR(66) NOT NULL,
    "log_index" INTEGER NOT NULL,
    "block_number" BIGINT NOT NULL,
    "timestamp" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "protocol_accruals_pkey" PRIMARY KEY ("chain_id","ordinal_key")
);

-- CreateTable
CREATE TABLE "creator_path_accruals" (
    "chain_id" INTEGER NOT NULL DEFAULT 8453,
    "ordinal_key" VARCHAR(40) NOT NULL,
    "pool_id" VARCHAR(66) NOT NULL,
    "amount" DECIMAL(78,0) NOT NULL,
    "tx_hash" VARCHAR(66) NOT NULL,
    "log_index" INTEGER NOT NULL,
    "block_number" BIGINT NOT NULL,
    "timestamp" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "creator_path_accruals_pkey" PRIMARY KEY ("chain_id","ordinal_key")
);

-- CreateTable
CREATE TABLE "claims" (
    "chain_id" INTEGER NOT NULL DEFAULT 8453,
    "ordinal_key" VARCHAR(40) NOT NULL,
    "pool_id" VARCHAR(66) NOT NULL,
    "claim_type" "ClaimType" NOT NULL,
    "holder" VARCHAR(42) NOT NULL,
    "amount" DECIMAL(78,0) NOT NULL,
    "tx_hash" VARCHAR(66) NOT NULL,
    "log_index" INTEGER NOT NULL,
    "block_number" BIGINT NOT NULL,
    "timestamp" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "claims_pkey" PRIMARY KEY ("chain_id","ordinal_key")
);

-- CreateTable
CREATE TABLE "creator_path_claim_failures" (
    "chain_id" INTEGER NOT NULL DEFAULT 8453,
    "ordinal_key" VARCHAR(40) NOT NULL,
    "pool_id" VARCHAR(66) NOT NULL,
    "holder" VARCHAR(42) NOT NULL,
    "amount" DECIMAL(78,0) NOT NULL,
    "tx_hash" VARCHAR(66) NOT NULL,
    "log_index" INTEGER NOT NULL,
    "block_number" BIGINT NOT NULL,
    "timestamp" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "creator_path_claim_failures_pkey" PRIMARY KEY ("chain_id","ordinal_key")
);

-- CreateTable
CREATE TABLE "fee_collections" (
    "chain_id" INTEGER NOT NULL DEFAULT 8453,
    "ordinal_key" VARCHAR(40) NOT NULL,
    "pool_id" VARCHAR(66) NOT NULL,
    "caller" VARCHAR(42) NOT NULL,
    "quote_fees" DECIMAL(78,0) NOT NULL,
    "token_fees" DECIMAL(78,0) NOT NULL,
    "tx_hash" VARCHAR(66) NOT NULL,
    "log_index" INTEGER NOT NULL,
    "block_number" BIGINT NOT NULL,
    "timestamp" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "fee_collections_pkey" PRIMARY KEY ("chain_id","ordinal_key")
);

-- CreateTable
CREATE TABLE "fee_routings" (
    "chain_id" INTEGER NOT NULL DEFAULT 8453,
    "ordinal_key" VARCHAR(40) NOT NULL,
    "pool_id" VARCHAR(66) NOT NULL,
    "creator_quote" DECIMAL(78,0) NOT NULL,
    "protocol_quote" DECIMAL(78,0) NOT NULL,
    "diverted_to_next_band" DECIMAL(78,0) NOT NULL,
    "tokens_burned" DECIMAL(78,0) NOT NULL,
    "economic_version" BIGINT NOT NULL,
    "tx_hash" VARCHAR(66) NOT NULL,
    "log_index" INTEGER NOT NULL,
    "block_number" BIGINT NOT NULL,
    "timestamp" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "fee_routings_pkey" PRIMARY KEY ("chain_id","ordinal_key")
);

-- CreateTable
CREATE TABLE "token_burns" (
    "chain_id" INTEGER NOT NULL DEFAULT 8453,
    "ordinal_key" VARCHAR(40) NOT NULL,
    "pool_id" VARCHAR(66),
    "token" VARCHAR(42) NOT NULL,
    "burner" VARCHAR(42) NOT NULL,
    "amount" DECIMAL(78,0) NOT NULL,
    "tx_hash" VARCHAR(66) NOT NULL,
    "log_index" INTEGER NOT NULL,
    "block_number" BIGINT NOT NULL,
    "timestamp" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "token_burns_pkey" PRIMARY KEY ("chain_id","ordinal_key")
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
CREATE UNIQUE INDEX "tokens_chain_id_token_key" ON "tokens"("chain_id", "token");

-- CreateIndex
CREATE INDEX "launch_records_creatorWallet_state_idx" ON "launch_records"("creatorWallet", "state");

-- CreateIndex
CREATE INDEX "launch_records_state_createdAt_idx" ON "launch_records"("state", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "launch_records_chainId_configHash_creatorWallet_key" ON "launch_records"("chainId", "configHash", "creatorWallet");

-- CreateIndex
CREATE UNIQUE INDEX "launch_records_tokenDbId_key" ON "launch_records"("tokenDbId");

-- CreateIndex
CREATE INDEX "idempotency_requests_expiresAt_idx" ON "idempotency_requests"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_requests_scope_walletAddress_key_key" ON "idempotency_requests"("scope", "walletAddress", "key");

-- CreateIndex
CREATE INDEX "outbox_events_publishedAt_availableAt_idx" ON "outbox_events"("publishedAt", "availableAt");

-- CreateIndex
CREATE INDEX "comments_tokenDbId_parentId_createdAt_idx" ON "comments"("tokenDbId", "parentId", "createdAt");

-- CreateIndex
CREATE INDEX "comments_tokenDbId_rootId_createdAt_idx" ON "comments"("tokenDbId", "rootId", "createdAt");

-- CreateIndex
CREATE INDEX "comments_tokenDbId_parentId_likeCount_createdAt_idx" ON "comments"("tokenDbId", "parentId", "likeCount" DESC, "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "comments_id_tokenDbId_key" ON "comments"("id", "tokenDbId");

-- CreateIndex
CREATE INDEX "raw_chain_events_address_topic0_block_number_idx" ON "raw_chain_events"("address", "topic0", "block_number");

-- CreateIndex
CREATE INDEX "raw_chain_events_chain_id_block_number_log_index_idx" ON "raw_chain_events"("chain_id", "block_number" DESC, "log_index" DESC);

-- CreateIndex
CREATE INDEX "pools_status_launch_time_idx" ON "pools"("status", "launch_time" DESC);

-- CreateIndex
CREATE INDEX "pools_creator_idx" ON "pools"("creator");

-- CreateIndex
CREATE UNIQUE INDEX "pools_chain_id_token_key" ON "pools"("chain_id", "token");

-- CreateIndex
CREATE INDEX "bands_chain_id_pool_id_status_idx" ON "bands"("chain_id", "pool_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "plugin_registry_chain_id_plugin_key" ON "plugin_registry"("chain_id", "plugin");

-- CreateIndex
CREATE INDEX "governance_operations_chain_id_status_idx" ON "governance_operations"("chain_id", "status");

-- CreateIndex
CREATE INDEX "pool_minute_stats_pool_id_minute_idx" ON "pool_minute_stats"("pool_id", "minute" DESC);

-- CreateIndex
CREATE INDEX "pool_hour_stats_pool_id_hour_idx" ON "pool_hour_stats"("pool_id", "hour" DESC);

-- CreateIndex
CREATE INDEX "pool_day_stats_pool_id_day_idx" ON "pool_day_stats"("pool_id", "day" DESC);

-- CreateIndex
CREATE INDEX "launches_pool_id_idx" ON "launches"("pool_id");

-- CreateIndex
CREATE INDEX "graduations_pool_id_idx" ON "graduations"("pool_id");

-- CreateIndex
CREATE INDEX "idx_swaps_pool_time" ON "swaps"("pool_id", "timestamp" DESC, "log_index" DESC);

-- CreateIndex
CREATE INDEX "curve_deployments_pool_id_idx" ON "curve_deployments"("pool_id");

-- CreateIndex
CREATE INDEX "milestone_harvests_pool_id_band_index_idx" ON "milestone_harvests"("pool_id", "band_index");

-- CreateIndex
CREATE INDEX "harvest_payouts_pool_id_idx" ON "harvest_payouts"("pool_id");

-- CreateIndex
CREATE INDEX "band_skips_pool_id_idx" ON "band_skips"("pool_id");

-- CreateIndex
CREATE INDEX "dev_buys_pool_id_idx" ON "dev_buys"("pool_id");

-- CreateIndex
CREATE INDEX "dev_buy_skips_pool_id_idx" ON "dev_buy_skips"("pool_id");

-- CreateIndex
CREATE INDEX "payout_pot_fundings_pool_id_idx" ON "payout_pot_fundings"("pool_id");

-- CreateIndex
CREATE INDEX "payout_pot_redemptions_pool_id_idx" ON "payout_pot_redemptions"("pool_id");

-- CreateIndex
CREATE INDEX "payout_tips_pool_id_idx" ON "payout_tips"("pool_id");

-- CreateIndex
CREATE INDEX "plugin_payouts_pool_id_idx" ON "plugin_payouts"("pool_id");

-- CreateIndex
CREATE INDEX "creator_accruals_pool_id_source_idx" ON "creator_accruals"("pool_id", "source");

-- CreateIndex
CREATE INDEX "protocol_accruals_pool_id_source_idx" ON "protocol_accruals"("pool_id", "source");

-- CreateIndex
CREATE INDEX "creator_path_accruals_pool_id_idx" ON "creator_path_accruals"("pool_id");

-- CreateIndex
CREATE INDEX "claims_holder_timestamp_idx" ON "claims"("holder", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "claims_pool_id_claim_type_idx" ON "claims"("pool_id", "claim_type");

-- CreateIndex
CREATE INDEX "creator_path_claim_failures_pool_id_idx" ON "creator_path_claim_failures"("pool_id");

-- CreateIndex
CREATE INDEX "fee_collections_pool_id_idx" ON "fee_collections"("pool_id");

-- CreateIndex
CREATE INDEX "fee_routings_pool_id_idx" ON "fee_routings"("pool_id");

-- CreateIndex
CREATE INDEX "token_burns_pool_id_idx" ON "token_burns"("pool_id");

-- AddForeignKey
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_claimedCreatorWallet_fkey" FOREIGN KEY ("claimedCreatorWallet") REFERENCES "profiles"("walletAddress") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "launch_records" ADD CONSTRAINT "launch_records_tokenDbId_fkey" FOREIGN KEY ("tokenDbId") REFERENCES "tokens"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_tokenDbId_fkey" FOREIGN KEY ("tokenDbId") REFERENCES "tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_walletAddress_fkey" FOREIGN KEY ("walletAddress") REFERENCES "profiles"("walletAddress") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "comments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_likes" ADD CONSTRAINT "comment_likes_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_likes" ADD CONSTRAINT "comment_likes_walletAddress_fkey" FOREIGN KEY ("walletAddress") REFERENCES "profiles"("walletAddress") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pools" ADD CONSTRAINT "pools_chain_id_token_fkey" FOREIGN KEY ("chain_id", "token") REFERENCES "tokens"("chain_id", "token") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bands" ADD CONSTRAINT "bands_chain_id_pool_id_fkey" FOREIGN KEY ("chain_id", "pool_id") REFERENCES "pools"("chain_id", "pool_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pots" ADD CONSTRAINT "pots_chain_id_pool_id_fkey" FOREIGN KEY ("chain_id", "pool_id") REFERENCES "pools"("chain_id", "pool_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pool_stats" ADD CONSTRAINT "pool_stats_chain_id_pool_id_fkey" FOREIGN KEY ("chain_id", "pool_id") REFERENCES "pools"("chain_id", "pool_id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===========================================================================
-- Data layer views, triggers, materialized views, role matrix (appended)
-- ===========================================================================
-- Derived views per the backend guide (pool_metrics, candles roll-ups,
-- leaderboard). Views are read-only surfaces over sink tables.
-- ===========================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE OR REPLACE VIEW pool_metrics AS
SELECT
  p."chain_id",
  p."pool_id",
  p.status,
  p.token,
  p.creator,
  p."total_supply",
  (p."total_supply" - COALESCE(s.burned_total, 0)) AS "circulating_supply",
  p."opening_level",
  p."far_level",
  p."graduation_level",
  p."payout_plan",
  p."dev_buy_share_wad",
  p."config_hash",
  p."wall_liquidity",
  p."revenue_nft_owner",
  p."launch_block",
  p."launch_time",
  p."graduation_block",
  p."graduation_time",
  t.name,
  t.symbol,
  t.uri,
  s."buy_volume_eth",
  s."sell_volume_eth",
  s."swap_count",
  s."last_price_sqrt_x96",
  s."ath_sqrt_x96",
  s."creator_revenue_total",
  s."protocol_revenue_total",
  CASE WHEN s."last_price_sqrt_x96" > 0
    THEN (p."total_supply" * (2::numeric ^ 192)) / (s."last_price_sqrt_x96" * s."last_price_sqrt_x96")
  END AS "fdv_wei",
  CASE WHEN s."last_price_sqrt_x96" > 0
    THEN ((p."total_supply" - COALESCE(s.burned_total, 0)) * (2::numeric ^ 192)) / (s."last_price_sqrt_x96" * s."last_price_sqrt_x96")
  END AS "mcap_wei",
  CASE WHEN s."ath_sqrt_x96" > 0
    THEN ((p."total_supply" - COALESCE(s.burned_total, 0)) * (2::numeric ^ 192)) / (s."ath_sqrt_x96" * s."ath_sqrt_x96")
  END AS "ath_mcap_wei"
FROM pools p
JOIN tokens t ON t."chain_id" = p."chain_id" AND t.token = p.token
LEFT JOIN pool_stats s ON s."chain_id" = p."chain_id" AND s."pool_id" = p."pool_id";

CREATE OR REPLACE VIEW pool_candles AS
SELECT
  d."chain_id",
  d."pool_id",
  d.day AS "time",
  d."open_sqrt_x96",
  d."high_sqrt_x96",
  d."low_sqrt_x96",
  d."close_sqrt_x96",
  d."buy_volume_eth" + d."sell_volume_eth" AS "volume_eth",
  d.swap_count
FROM pool_day_stats d;

CREATE OR REPLACE VIEW protocol_metrics_daily AS
SELECT
  "chain_id",
  day AS "time",
  "buy_volume_eth",
  "sell_volume_eth",
  swap_count,
  "creator_revenue_eth",
  "protocol_revenue_eth",
  "graduation_count",
  launch_count
FROM protocol_day_stats;

-- OHLC roll-ups over the minute/hour base tables. high = max sqrt (lowest ETH price)
-- and low = min sqrt, exactly as stored; ETH-price OHLC is a read-side conversion.
CREATE OR REPLACE VIEW candles_5m AS
WITH b AS (
  SELECT "chain_id", "pool_id",
         "minute" - make_interval(mins => EXTRACT(minute FROM "minute")::int % 5) AS bucket,
         "minute", "open_sqrt_x96", "close_sqrt_x96", "high_sqrt_x96", "low_sqrt_x96",
         "buy_volume_eth", "sell_volume_eth", "buy_volume_tokens", "sell_volume_tokens", swap_count
  FROM pool_minute_stats)
SELECT "chain_id", "pool_id", date_trunc('hour', bucket) + (EXTRACT(minute FROM bucket)::int / 5) * interval '5 minutes' AS bucket,
       (array_agg("open_sqrt_x96"  ORDER BY "minute"))[1]      AS open_sqrt_x96,
       (array_agg("close_sqrt_x96" ORDER BY "minute" DESC))[1] AS close_sqrt_x96,
       max("high_sqrt_x96") AS high_sqrt_x96, min("low_sqrt_x96") AS low_sqrt_x96,
       sum("buy_volume_eth") AS buy_volume_eth, sum("sell_volume_eth") AS sell_volume_eth,
       sum("buy_volume_tokens") AS buy_volume_tokens, sum("sell_volume_tokens") AS sell_volume_tokens,
       sum(swap_count) AS swap_count
FROM b GROUP BY "chain_id", "pool_id", bucket;

CREATE OR REPLACE VIEW candles_15m AS
WITH b AS (
  SELECT "chain_id", "pool_id",
         date_trunc('hour', "minute") + make_interval(mins => (FLOOR(EXTRACT(minute FROM "minute")::int / 15) * 15)::int) AS bucket,
         "minute", "open_sqrt_x96", "close_sqrt_x96", "high_sqrt_x96", "low_sqrt_x96",
         "buy_volume_eth", "sell_volume_eth", swap_count
  FROM pool_minute_stats)
SELECT "chain_id", "pool_id", bucket,
       (array_agg("open_sqrt_x96"  ORDER BY "minute"))[1]      AS open_sqrt_x96,
       (array_agg("close_sqrt_x96" ORDER BY "minute" DESC))[1] AS close_sqrt_x96,
       max("high_sqrt_x96") AS high_sqrt_x96, min("low_sqrt_x96") AS low_sqrt_x96,
       sum("buy_volume_eth") AS buy_volume_eth, sum("sell_volume_eth") AS sell_volume_eth,
       sum(swap_count) AS swap_count
FROM b GROUP BY "chain_id", "pool_id", bucket;

CREATE OR REPLACE VIEW candles_4h AS
WITH b AS (
  SELECT "chain_id", "pool_id",
         date_trunc('hour', "hour") + make_interval(hours => (FLOOR(EXTRACT(hour FROM "hour")::int / 4) * 4)::int) AS bucket,
         "hour", "open_sqrt_x96", "close_sqrt_x96", "high_sqrt_x96", "low_sqrt_x96",
         "buy_volume_eth", "sell_volume_eth", swap_count
  FROM pool_hour_stats)
SELECT "chain_id", "pool_id", bucket,
       (array_agg("open_sqrt_x96"  ORDER BY "hour"))[1]      AS open_sqrt_x96,
       (array_agg("close_sqrt_x96" ORDER BY "hour" DESC))[1] AS close_sqrt_x96,
       max("high_sqrt_x96") AS high_sqrt_x96, min("low_sqrt_x96") AS low_sqrt_x96,
       sum("buy_volume_eth") AS buy_volume_eth, sum("sell_volume_eth") AS sell_volume_eth,
       sum(swap_count) AS swap_count
FROM b GROUP BY "chain_id", "pool_id", bucket;

-- Leaderboard materialized view: refreshed every ~30s by the worker sidecar.
CREATE MATERIALIZED VIEW leaderboard_daily AS
SELECT
  p."chain_id",
  p."pool_id",
  p.status,
  p.token,
  p.creator,
  p."launch_time",
  t.name,
  t.symbol,
  (s."buy_volume_eth" + s."sell_volume_eth") AS total_volume_eth,
  COALESCE(d."buy_volume_eth", 0) + COALESCE(d."sell_volume_eth", 0) AS daily_volume_eth,
  s."creator_revenue_total",
  s."protocol_revenue_total"
FROM pools p
JOIN tokens t ON t."chain_id" = p."chain_id" AND t.token = p.token
LEFT JOIN pool_stats s ON s."chain_id" = p."chain_id" AND s."pool_id" = p."pool_id"
LEFT JOIN (
  SELECT "chain_id", "pool_id", sum("buy_volume_eth") AS "buy_volume_eth", sum("sell_volume_eth") AS "sell_volume_eth"
  FROM pool_minute_stats
  WHERE "minute" >= date_trunc('day', now())
  GROUP BY "chain_id", "pool_id"
) d ON d."chain_id" = p."chain_id" AND d."pool_id" = p."pool_id";

CREATE UNIQUE INDEX leaderboard_daily_uidx ON leaderboard_daily ("chain_id", "pool_id");
REFRESH MATERIALIZED VIEW leaderboard_daily;

-- ===========================================================================
-- Live-stream triggers: notify-only, exception-guarded (never fail a flush).
-- ===========================================================================

CREATE OR REPLACE FUNCTION notify_spawn_trade() RETURNS trigger AS $$
BEGIN
  BEGIN
    PERFORM pg_notify('spawn_trades', json_build_object(
      'pool_id', NEW."pool_id",
      'chain_id', NEW."chain_id",
      'is_buy', NEW.is_buy,
      'eth', NEW."amount0_eth"::text,
      'tokens', NEW."amount1_tokens"::text,
      'sqrt', NEW."sqrt_price_x96"::text,
      'tick', NEW.tick,
      'fee_eth', NEW."fee_eth"::text,
      'fee_tokens', NEW."fee_tokens"::text,
      'ts', EXTRACT(epoch FROM NEW."timestamp")::bigint,
      'block', NEW."block_number"::bigint,
      'tx', NEW."tx_hash",
      'log_index', NEW."log_index"
    )::text);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_notify_spawn_trade AFTER INSERT ON swaps
  FOR EACH ROW EXECUTE FUNCTION notify_spawn_trade();

CREATE OR REPLACE FUNCTION notify_spawn_pool() RETURNS trigger AS $$
BEGIN
  BEGIN
    PERFORM pg_notify('spawn_pools', json_build_object(
      'pool_id', NEW."pool_id",
      'chain_id', NEW."chain_id",
      'status', NEW.status,
      'token', NEW.token,
      'creator', NEW.creator,
      'opening_level', NEW."opening_level",
      'far_level', NEW."far_level",
      'graduation_level', NEW."graduation_level",
      'block', NEW."launch_block"::bigint,
      'ts', EXTRACT(epoch FROM NEW."launch_time")::bigint
    )::text);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_notify_spawn_pool AFTER INSERT OR UPDATE ON pools
  FOR EACH ROW EXECUTE FUNCTION notify_spawn_pool();

-- ===========================================================================
-- Role-based access control (same matrix as before, extended for broadcaster).
-- ===========================================================================

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
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'spawn_broadcaster') THEN
    CREATE ROLE spawn_broadcaster NOLOGIN;
  END IF;
END
$$;

GRANT ALL ON SCHEMA public TO spawn_owner;
GRANT USAGE ON SCHEMA public TO spawn_migration, spawn_api, spawn_seed, spawn_indexer, spawn_broadcaster;
GRANT ALL ON ALL TABLES IN SCHEMA public TO spawn_migration;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO spawn_migration;

-- API: full DML on offchain tables, read-only on everything indexer-owned.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "profiles", "tokens", "launch_records", "idempotency_requests", "outbox_events",
  "domain_generations", "comments", "comment_likes"
TO spawn_api;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO spawn_api;

-- Indexer: DML over state/aggregate/fact/infra tables (sink-owned).
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "deployment_manifests", "chain_cursors", "chain_watermarks", "block_receipts", "raw_chain_events",
  "pools", "bands", "pots", "plugin_registry", "economic_configs", "protocol_state", "governance_operations",
  "pool_stats", "pool_minute_stats", "pool_hour_stats", "pool_day_stats", "protocol_day_stats", "protocol_stats",
  "launches", "graduations", "swaps", "curve_deployments", "milestone_harvests", "harvest_payouts",
  "band_skips", "dev_buys", "dev_buy_skips", "payout_pot_fundings", "payout_pot_redemptions", "payout_tips",
  "plugin_payouts", "creator_accruals", "protocol_accruals", "creator_path_accruals", "claims",
  "creator_path_claim_failures", "fee_collections", "fee_routings", "token_burns"
TO spawn_indexer;
GRANT SELECT, INSERT, UPDATE, DELETE ON "tokens" TO spawn_indexer;

-- Broadcaster: read + LISTEN (LISTEN needs no grant; channels are public).
GRANT SELECT ON "swaps", "pools", "pool_minute_stats" TO spawn_broadcaster;

-- Seed role: destructive dev seeding (API-owned + projections; kept for parity).
GRANT ALL ON ALL TABLES IN SCHEMA public TO spawn_seed;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO spawn_api;