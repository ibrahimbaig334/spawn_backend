import { PrismaPg } from '@prisma/adapter-pg';
import {
  CandleInterval,
  MilestoneKind,
  MilestoneState,
  OnchainPhase,
  Prisma,
  PrismaClient,
  Timeframe,
  TradeSide,
  type Prisma as PrismaTypes,
} from '@prisma/client';
import { DeploymentSignerCustody } from '../src/common/crypto/deployment-signer-custody';

const databaseUrl = process.env.SEED_DATABASE_URL;
if (!databaseUrl) throw new Error('SEED_DATABASE_URL is required');
if (process.env.ALLOW_DESTRUCTIVE_SEED !== 'true') {
  throw new Error('Set ALLOW_DESTRUCTIVE_SEED=true to run the development seed');
}

const referenceTime = new Date(process.env.SEED_REFERENCE_TIME ?? '2026-01-01T00:00:00.000Z');
if (!Number.isFinite(referenceTime.getTime()))
  throw new Error('SEED_REFERENCE_TIME must be ISO-8601');

const encryptionKeyValue = process.env.PRIVATE_KEY_ENCRYPTION_KEY;
const encryptionKeyId = process.env.PRIVATE_KEY_ENCRYPTION_KEY_ID;
if (!encryptionKeyValue || !encryptionKeyId) {
  throw new Error('Seed requires PRIVATE_KEY_ENCRYPTION_KEY and PRIVATE_KEY_ENCRYPTION_KEY_ID');
}
const encryptionKey = Buffer.from(encryptionKeyValue, 'base64');
if (encryptionKey.length !== 32 || encryptionKey.toString('base64') !== encryptionKeyValue) {
  throw new Error('PRIVATE_KEY_ENCRYPTION_KEY must be canonical base64 for exactly 32 bytes');
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const custody = new DeploymentSignerCustody(encryptionKey, encryptionKeyId);
const CHAIN_ID = 8453;
const VERSION = 100n;
const UINT_ABOVE_SAFE_INTEGER = '900719925474099312345678901234567890';
const FIXTURE_CID = 'bafkreichokjv6eta5ab4ayd4ioi6iadnpcl3u5rg5ksjvvsg5ywlolnpna';

const PROTOCOL = Object.freeze({
  openingFdvEth: 125,
  curveAllocationBps: 2500,
  milestoneAllocationBps: 6500,
  fullRangeAllocationBps: 1000,
  curveCount: 32,
  tickSpacing: 2235,
  bandWidth: 447,
  coreMilestones: 30,
  maxExtensionMilestones: 30,
  maxDevBuyBps: 1000,
});
const TOKEN_IDS = {
  pending: '00000000-0000-4000-8000-000000000001',
  none: '00000000-0000-4000-8000-000000000002',
  early: '00000000-0000-4000-8000-000000000003',
  mid: '00000000-0000-4000-8000-000000000008',
  near: '00000000-0000-4000-8000-000000000004',
  dead: '00000000-0000-4000-8000-000000000005',
  graduated: '00000000-0000-4000-8000-000000000006',
  failed: '00000000-0000-4000-8000-000000000007',
} as const;

const MOCK_CONTRACT_ADDRESSES = {
  none: '0x0000000000000000000000000000000000000101',
  early: '0x0000000000000000000000000000000000000102',
  mid: '0x0000000000000000000000000000000000000103',
  near: '0x0000000000000000000000000000000000000104',
  dead: '0x0000000000000000000000000000000000000105',
  graduated: '0x0000000000000000000000000000000000000106',
} as const;

const WALLETS = {
  creator: '0x1000000000000000000000000000000000000001',
  secondCreator: '0x2000000000000000000000000000000000000002',
  holder: '0x3000000000000000000000000000000000000003',
  commenter: '0x4000000000000000000000000000000000000004',
  liker: '0x5000000000000000000000000000000000000005',
  revenueOwner: '0x6000000000000000000000000000000000000006',
} as const;

interface TokenFixture {
  key: keyof typeof TOKEN_IDS;
  name: string;
  symbol: string;
  phase: OnchainPhase | null;
  completedCore: number;
  completedExtra: number;
  feeBps: 50 | 75 | 100;
  volumeUsd: string | null;
  marketCapUsd: string | null;
  tradeCount: bigint | null;
  holderCount: bigint | null;
  staleHours?: number;
}

const TOKENS: TokenFixture[] = [
  {
    key: 'pending',
    name: 'Pending Launch',
    symbol: 'PEND',
    phase: null,
    completedCore: 0,
    completedExtra: 0,
    feeBps: 100,
    volumeUsd: null,
    marketCapUsd: null,
    tradeCount: null,
    holderCount: null,
  },
  {
    key: 'none',
    name: 'Indexed None',
    symbol: 'NONE',
    phase: OnchainPhase.NONE,
    completedCore: 0,
    completedExtra: 0,
    feeBps: 100,
    volumeUsd: '1000.125',
    marketCapUsd: '125000.5',
    tradeCount: 10n,
    holderCount: 7n,
  },
  {
    key: 'early',
    name: 'Early Curve',
    symbol: 'EARLY',
    phase: OnchainPhase.BONDING_CURVE,
    completedCore: 7,
    completedExtra: 0,
    feeBps: 100,
    volumeUsd: '93000.000000000000000001',
    marketCapUsd: '750000.125',
    tradeCount: 750n,
    holderCount: 240n,
  },
  {
    key: 'mid',
    name: 'Mid Curve',
    symbol: 'MID',
    phase: OnchainPhase.BONDING_CURVE,
    completedCore: 16,
    completedExtra: 0,
    feeBps: 50,
    volumeUsd: '160000.5',
    marketCapUsd: '1850000.25',
    tradeCount: 1400n,
    holderCount: 560n,
  },
  {
    key: 'near',
    name: 'Near Graduation',
    symbol: 'NEAR',
    phase: OnchainPhase.BONDING_CURVE,
    completedCore: 29,
    completedExtra: 12,
    feeBps: 50,
    volumeUsd: '250000.75',
    marketCapUsd: '3200000.5',
    tradeCount: 2200n,
    holderCount: 940n,
  },
  {
    key: 'dead',
    name: 'Dormant Curve',
    symbol: 'DEAD',
    phase: OnchainPhase.BONDING_CURVE,
    completedCore: 8,
    completedExtra: 0,
    feeBps: 75,
    volumeUsd: '0',
    marketCapUsd: '310000',
    tradeCount: 0n,
    holderCount: 18n,
    staleHours: 72,
  },
  {
    key: 'graduated',
    name: 'Graduated Pool',
    symbol: 'GRAD',
    phase: OnchainPhase.GRADUATED,
    completedCore: 30,
    completedExtra: 30,
    feeBps: 50,
    volumeUsd: '500000.5',
    marketCapUsd: '12500000.25',
    tradeCount: 4200n,
    holderCount: 1700n,
  },
  {
    key: 'failed',
    name: 'Failed Metadata',
    symbol: 'FAIL',
    phase: null,
    completedCore: 0,
    completedExtra: 0,
    feeBps: 100,
    volumeUsd: null,
    marketCapUsd: null,
    tradeCount: null,
    holderCount: null,
  },
];

function at(hoursFromReference: number): Date {
  return new Date(referenceTime.getTime() + hoursFromReference * 60 * 60 * 1_000);
}

function hex(seed: number): string {
  return `0x${seed.toString(16).padStart(64, '0')}`;
}

function fixtureUri(token: TokenFixture, file: 'image.png' | 'metadata.json'): string {
  return `ipfs://${FIXTURE_CID}/${token.key}/${file}`;
}

function gatewayUrl(token: TokenFixture): string {
  return fixtureUri(token, 'metadata.json').replace('ipfs://', 'https://ipfs.io/ipfs/');
}

function tokenDescription(token: TokenFixture): string {
  return `${token.name} demonstrates deterministic launchpad data for API and frontend development.`;
}

function commentId(index: number): string {
  return `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
}

function assertProtocolConstants(): void {
  const phaseValues = Object.values(OnchainPhase);
  if (
    PROTOCOL.openingFdvEth !== 125 ||
    PROTOCOL.curveAllocationBps !== 2500 ||
    PROTOCOL.milestoneAllocationBps !== 6500 ||
    PROTOCOL.fullRangeAllocationBps !== 1000 ||
    PROTOCOL.curveCount !== 32 ||
    PROTOCOL.tickSpacing !== 2235 ||
    PROTOCOL.bandWidth !== 447 ||
    PROTOCOL.coreMilestones !== 30 ||
    PROTOCOL.maxExtensionMilestones !== 30 ||
    PROTOCOL.maxDevBuyBps !== 1000 ||
    phaseValues.length !== 3 ||
    !phaseValues.includes(OnchainPhase.NONE) ||
    !phaseValues.includes(OnchainPhase.BONDING_CURVE) ||
    !phaseValues.includes(OnchainPhase.GRADUATED)
  ) {
    throw new Error('Seed protocol constants no longer match the product contract');
  }
}

async function upsertProfiles(tx: PrismaTypes.TransactionClient): Promise<void> {
  const profiles = [
    [WALLETS.creator, 'seed_creator', 'Deterministic launch creator'],
    [WALLETS.secondCreator, 'seed_second', 'Second deterministic creator'],
    [WALLETS.holder, 'seed_holder', 'Portfolio fixture holder'],
    [WALLETS.commenter, 'seed_commenter', 'Nested comment fixture author'],
    [WALLETS.liker, 'seed_liker', 'Comment like fixture profile'],
    [WALLETS.revenueOwner, 'seed_revenue', 'Creator revenue NFT owner'],
  ] as const;
  for (const [walletAddress, username, bio] of profiles) {
    await tx.profile.upsert({
      where: { walletAddress },
      create: { walletAddress, username, usernameFolded: username, bio },
      update: { username, usernameFolded: username, bio },
    });
  }
}

async function upsertTokens(tx: PrismaTypes.TransactionClient): Promise<void> {
  for (const [index, token] of TOKENS.entries()) {
    const tokenId = TOKEN_IDS[token.key];
    const creatorWallet = index % 2 === 0 ? WALLETS.creator : WALLETS.secondCreator;
    const data = {
      claimedCreatorWallet: creatorWallet,
      name: token.name,
      symbol: token.symbol,
      description: tokenDescription(token),
      imageUri: fixtureUri(token, 'image.png'),
      ipfsUri: fixtureUri(token, 'metadata.json'),
      gatewayUrl: gatewayUrl(token),
      socials:
        token.key === 'near'
          ? {
              website: 'https://example.com/near',
              x: 'https://x.com/spawn_near',
            }
          : Prisma.JsonNull,
      createdAt: at(-48 + index),
    };
    await tx.token.upsert({
      where: { id: tokenId },
      create: { id: tokenId, ...data },
      update: data,
    });
    await ensureSigner(tx, tokenId);
  }
}

async function ensureSigner(tx: PrismaTypes.TransactionClient, tokenId: string): Promise<void> {
  const existing = await tx.tokenDeploymentSigner.findUnique({ where: { tokenId } });
  if (existing) {
    const secretRows = await tx.$queryRaw<Array<{ exists: boolean }>>`
      SELECT has_token_deployment_secret(${tokenId}::uuid) AS "exists"
    `;
    if (secretRows[0]?.exists !== true) {
      throw new Error(`Deployment signer secret is missing for seed token ${tokenId}`);
    }
    return;
  }
  const signer = custody.generate(tokenId);
  try {
    await tx.tokenDeploymentSigner.create({
      data: { tokenId, signerAddress: signer.signerAddress },
    });
    await tx.$executeRaw`
      SELECT insert_token_deployment_secret(
        ${tokenId}::uuid,
        ${signer.version},
        ${signer.algorithm}::varchar,
        ${signer.keyId}::varchar,
        ${signer.iv},
        ${signer.ciphertext},
        ${signer.authTag}
      )
    `;
  } finally {
    signer.iv.fill(0);
    signer.ciphertext.fill(0);
    signer.authTag.fill(0);
  }
}

async function reconcileProjections(tx: PrismaTypes.TransactionClient): Promise<void> {
  const projected = TOKENS.filter(
    (token): token is TokenFixture & { phase: OnchainPhase } => token.phase !== null,
  );
  const projectedIds = projected.map((token) => TOKEN_IDS[token.key]);
  const unprojectedIds = Object.values(TOKEN_IDS).filter(
    (tokenId) => !projectedIds.includes(tokenId),
  );
  await tx.tokenMetric.deleteMany({
    where: { tokenId: { in: unprojectedIds }, chainId: CHAIN_ID },
  });
  await tx.tokenWatermark.deleteMany({
    where: { tokenId: { in: unprojectedIds }, chainId: CHAIN_ID },
  });
  await tx.tokenChainState.deleteMany({
    where: { tokenId: { in: unprojectedIds }, chainId: CHAIN_ID },
  });
  await tx.tokenDeploymentBinding.deleteMany({
    where: { tokenId: { in: Object.values(TOKEN_IDS) } },
  });
  for (const [index, token] of projected.entries()) {
    const tokenId = TOKEN_IDS[token.key];
    const contractAddress =
      MOCK_CONTRACT_ADDRESSES[token.key as keyof typeof MOCK_CONTRACT_ADDRESSES];
    if (!contractAddress) throw new Error(`Missing mock contract address for ${token.key}`);
    const poolId = hex(0x200 + index);
    const blockTime = at(-(token.staleHours ?? 0));
    await tx.tokenChainState.upsert({
      where: { tokenId_chainId: { tokenId, chainId: CHAIN_ID } },
      create: chainState(token, tokenId, index, contractAddress, poolId, blockTime),
      update: chainState(token, tokenId, index, contractAddress, poolId, blockTime),
    });
    await tx.tokenWatermark.upsert({
      where: { tokenId_chainId: { tokenId, chainId: CHAIN_ID } },
      create: {
        tokenId,
        chainId: CHAIN_ID,
        committedVersion: VERSION,
        blockNumber: 20_000_000n + BigInt(index),
        blockHash: hex(0x500 + index),
        blockTime,
      },
      update: {
        committedVersion: VERSION,
        blockNumber: 20_000_000n + BigInt(index),
        blockHash: hex(0x500 + index),
        blockTime,
      },
    });
    for (const timeframe of Object.values(Timeframe)) {
      await tx.tokenMetric.upsert({
        where: { tokenId_chainId_timeframe: { tokenId, chainId: CHAIN_ID, timeframe } },
        create: metricData(token, tokenId, timeframe, blockTime),
        update: metricData(token, tokenId, timeframe, blockTime),
      });
    }
  }
  await tx.chainWatermark.upsert({
    where: { chainId: CHAIN_ID },
    create: {
      chainId: CHAIN_ID,
      committedVersion: VERSION,
      blockNumber: 20_000_100n,
      blockHash: hex(0x5ff),
      blockTime: referenceTime,
    },
    update: {
      committedVersion: VERSION,
      blockNumber: 20_000_100n,
      blockHash: hex(0x5ff),
      blockTime: referenceTime,
    },
  });
}

function chainState(
  token: TokenFixture,
  tokenId: string,
  index: number,
  contractAddress: string,
  poolId: string,
  blockTime: Date,
): PrismaTypes.TokenChainStateUncheckedCreateInput {
  return {
    tokenId,
    chainId: CHAIN_ID,
    phase: token.phase ?? OnchainPhase.NONE,
    contractAddress,
    poolId,
    launchCreatorWallet: index % 2 === 0 ? WALLETS.creator : WALLETS.secondCreator,
    creatorRevenueNftId: new Prisma.Decimal(UINT_ABOVE_SAFE_INTEGER).plus(index),
    creatorRevenueOwner: WALLETS.revenueOwner,
    totalSupply: new Prisma.Decimal('1000000000000000000000000000'),
    decimals: 18,
    curveAllocationBps: PROTOCOL.curveAllocationBps,
    milestoneAllocationBps: PROTOCOL.milestoneAllocationBps,
    fullRangeAllocationBps: PROTOCOL.fullRangeAllocationBps,
    creatorHarvestSplitWad: new Prisma.Decimal('0.600000000000000000'),
    buybackHarvestSplitWad: new Prisma.Decimal('0.200000000000000000'),
    protocolHarvestSplitWad: new Prisma.Decimal('0.100000000000000000'),
    lpHarvestSplitWad: new Prisma.Decimal('0.100000000000000000'),
    curveCount: PROTOCOL.curveCount,
    completedCoreMilestones: token.completedCore,
    completedExtraMilestones: token.completedExtra,
    feeBps: token.feeBps,
    projectionVersion: VERSION,
    sourceBlockNumber: 20_000_000n + BigInt(index),
    sourceBlockHash: hex(0x500 + index),
    sourceBlockTime: blockTime,
    provenance: 'synthetic-seed-not-chain-authority',
  };
}

function metricData(
  token: TokenFixture,
  tokenId: string,
  timeframe: Timeframe,
  blockTime: Date,
): PrismaTypes.TokenMetricUncheckedCreateInput {
  const factor = {
    [Timeframe.H1]: '0.08',
    [Timeframe.H24]: '1',
    [Timeframe.D7]: '4.5',
    [Timeframe.D30]: '12',
    [Timeframe.ALL]: '25',
  }[timeframe];
  return {
    tokenId,
    chainId: CHAIN_ID,
    timeframe,
    priceUsd: token.marketCapUsd ? new Prisma.Decimal(token.marketCapUsd).div('1000000') : null,
    marketCapUsd: token.marketCapUsd ? new Prisma.Decimal(token.marketCapUsd) : null,
    volumeUsd: token.volumeUsd ? new Prisma.Decimal(token.volumeUsd).mul(factor) : null,
    priceChangePct: token.volumeUsd ? new Prisma.Decimal('12.345678901234567890') : null,
    tradeCount: token.tradeCount,
    holderCount: token.holderCount,
    projectionVersion: VERSION,
    sourceBlockNumber: 20_000_100n,
    sourceBlockTime: blockTime,
  };
}

async function reconcileTradesAndCandles(tx: PrismaTypes.TransactionClient): Promise<void> {
  const seedTokenIds = Object.values(TOKEN_IDS);
  await tx.trade.deleteMany({
    where: { tokenId: { in: seedTokenIds }, chainId: CHAIN_ID },
  });
  await tx.candle.deleteMany({
    where: { tokenId: { in: seedTokenIds }, chainId: CHAIN_ID },
  });
  const tokenKeys: Array<keyof typeof TOKEN_IDS> = ['early', 'mid', 'near', 'graduated'];
  for (const [tokenIndex, key] of tokenKeys.entries()) {
    const tokenId = TOKEN_IDS[key];
    for (let index = 0; index < 6; index += 1) {
      const blockTime = at(-index * 24 - tokenIndex);
      await tx.trade.upsert({
        where: {
          chainId_transactionHash_logIndex: {
            chainId: CHAIN_ID,
            transactionHash: hex(0x700 + tokenIndex * 16 + index),
            logIndex: index,
          },
        },
        create: tradeData(tokenId, tokenIndex, index, blockTime),
        update: tradeData(tokenId, tokenIndex, index, blockTime),
      });
    }
    for (const interval of Object.values(CandleInterval)) {
      for (let index = 0; index < 4; index += 1) {
        const bucketStart = at(-index * 6 - tokenIndex);
        await tx.candle.upsert({
          where: {
            tokenId_chainId_interval_bucketStart: {
              tokenId,
              chainId: CHAIN_ID,
              interval,
              bucketStart,
            },
          },
          create: candleData(tokenId, interval, index, bucketStart),
          update: candleData(tokenId, interval, index, bucketStart),
        });
      }
    }
  }
}

function tradeData(
  tokenId: string,
  tokenIndex: number,
  index: number,
  blockTime: Date,
): PrismaTypes.TradeUncheckedCreateInput {
  return {
    chainId: CHAIN_ID,
    transactionHash: hex(0x700 + tokenIndex * 16 + index),
    logIndex: index,
    transactionIndex: tokenIndex * 10 + index,
    tokenId,
    side: index % 2 === 0 ? TradeSide.BUY : TradeSide.SELL,
    traderWallet: index % 2 === 0 ? WALLETS.holder : WALLETS.commenter,
    tokenAmountRaw: new Prisma.Decimal(UINT_ABOVE_SAFE_INTEGER).plus(index),
    quoteAmountRaw: new Prisma.Decimal('1000000000000000000').mul(index + 1),
    priceUsd: new Prisma.Decimal('0.123456789012345678901234567890123456'),
    valueUsd: new Prisma.Decimal('12345.678901234567890123456789'),
    blockNumber: 20_000_050n + BigInt(tokenIndex * 10 + index),
    blockHash: hex(0x800 + tokenIndex * 16 + index),
    blockTime,
    canonical: true,
    projectionVersion: VERSION,
  };
}

function candleData(
  tokenId: string,
  interval: CandleInterval,
  index: number,
  bucketStart: Date,
): PrismaTypes.CandleUncheckedCreateInput {
  const open = new Prisma.Decimal('0.100000000000000000000000000000000001').plus(index / 100);
  return {
    tokenId,
    chainId: CHAIN_ID,
    interval,
    bucketStart,
    open,
    high: open.plus('0.05'),
    low: open.minus('0.025'),
    close: open.plus('0.01'),
    volumeUsd: new Prisma.Decimal('25000.123456789012345678').mul(index + 1),
    tradeCount: BigInt(25 + index),
    projectionVersion: VERSION,
  };
}

async function reconcileMilestones(tx: PrismaTypes.TransactionClient): Promise<void> {
  await tx.milestone.deleteMany({
    where: { tokenId: { in: Object.values(TOKEN_IDS) }, chainId: CHAIN_ID },
  });
  const keys: Array<keyof typeof TOKEN_IDS> = ['early', 'mid', 'near', 'dead', 'graduated'];
  for (const key of keys) {
    const token = TOKENS.find((item) => item.key === key);
    if (!token) throw new Error(`Missing token fixture: ${key}`);
    for (let index = 0; index < PROTOCOL.coreMilestones; index += 1) {
      await upsertMilestone(tx, token, MilestoneKind.CORE, index);
    }
    const extensionCount =
      key === 'graduated' ? PROTOCOL.maxExtensionMilestones : token.completedExtra;
    for (let index = 0; index < extensionCount; index += 1) {
      await upsertMilestone(tx, token, MilestoneKind.EXTENSION, index);
    }
  }
}

async function upsertMilestone(
  tx: PrismaTypes.TransactionClient,
  token: TokenFixture,
  kind: MilestoneKind,
  index: number,
): Promise<void> {
  const tokenId = TOKEN_IDS[token.key];
  const completed = kind === MilestoneKind.CORE ? token.completedCore : token.completedExtra;
  const harvested = index < completed;
  const state = harvested
    ? MilestoneState.HARVESTED
    : index === completed
      ? MilestoneState.PARTIAL
      : MilestoneState.PENDING;
  const baseTick =
    kind === MilestoneKind.CORE
      ? index * PROTOCOL.tickSpacing
      : 100_000 + index * PROTOCOL.tickSpacing;
  const inventory = new Prisma.Decimal('21666666666666666666666666');
  const data: PrismaTypes.MilestoneUncheckedCreateInput = {
    tokenId,
    chainId: CHAIN_ID,
    kind,
    index,
    state,
    lowerTick: baseTick,
    upperTick: baseTick + PROTOCOL.bandWidth,
    tokenInventoryRaw: inventory,
    tokenRemainingRaw: harvested ? new Prisma.Decimal(0) : inventory,
    quoteProceedsRaw: harvested
      ? new Prisma.Decimal('10000000000000000000').mul(index + 1)
      : new Prisma.Decimal(0),
    creatorHarvestRaw: harvested
      ? new Prisma.Decimal('6000000000000000000')
      : new Prisma.Decimal(0),
    buybackHarvestRaw: harvested
      ? new Prisma.Decimal('2000000000000000000')
      : new Prisma.Decimal(0),
    protocolHarvestRaw: harvested
      ? new Prisma.Decimal('1000000000000000000')
      : new Prisma.Decimal(0),
    lpHarvestRaw: harvested ? new Prisma.Decimal('1000000000000000000') : new Prisma.Decimal(0),
    feeBps: token.feeBps,
    projectionVersion: VERSION,
    sourceBlockNumber: 20_000_080n + BigInt(index),
    sourceBlockTime: at(-index),
  };
  await tx.milestone.upsert({
    where: { tokenId_chainId_kind_index: { tokenId, chainId: CHAIN_ID, kind, index } },
    create: data,
    update: data,
  });
}

async function reconcileHoldings(tx: PrismaTypes.TransactionClient): Promise<void> {
  await tx.holding.deleteMany({
    where: {
      walletAddress: WALLETS.holder,
      tokenId: { in: Object.values(TOKEN_IDS) },
      chainId: CHAIN_ID,
    },
  });
  const fixtures = [
    { key: 'early', balanceRaw: UINT_ABOVE_SAFE_INTEGER, valueUsd: '55555.500000000000000001' },
    { key: 'mid', balanceRaw: '16000000000000000000000', valueUsd: '65000.25' },
    { key: 'near', balanceRaw: '12345000000000000000000', valueUsd: '98765.4321' },
    { key: 'graduated', balanceRaw: '777000000000000000000', valueUsd: null },
  ] as const;
  for (const [index, item] of fixtures.entries()) {
    const tokenId = TOKEN_IDS[item.key];
    const data: PrismaTypes.HoldingUncheckedCreateInput = {
      walletAddress: WALLETS.holder,
      tokenId,
      chainId: CHAIN_ID,
      balanceRaw: new Prisma.Decimal(item.balanceRaw),
      valueUsd: item.valueUsd === null ? null : new Prisma.Decimal(item.valueUsd),
      lastActivityAt: at(-index),
      projectionVersion: VERSION,
      sourceBlockNumber: 20_000_090n + BigInt(index),
      sourceBlockTime: at(-index),
    };
    await tx.holding.upsert({
      where: {
        walletAddress_tokenId_chainId: {
          walletAddress: WALLETS.holder,
          tokenId,
          chainId: CHAIN_ID,
        },
      },
      create: data,
      update: data,
    });
  }
}

async function reconcileComments(tx: PrismaTypes.TransactionClient): Promise<void> {
  const tokenId = TOKEN_IDS.near;
  const ids = Array.from({ length: 5 }, (_, index) => commentId(index));
  const rootId = ids[0];
  const firstReplyId = ids[1];
  const secondReplyId = ids[2];
  const thirdReplyId = ids[3];
  const tombstoneId = ids[4];
  if (!rootId || !firstReplyId || !secondReplyId || !thirdReplyId || !tombstoneId) {
    throw new Error('Comment fixture IDs were not generated');
  }
  const comments: Array<Omit<PrismaTypes.CommentUncheckedCreateInput, 'tokenId'>> = [
    {
      id: rootId,
      walletAddress: WALLETS.creator,
      parentId: null,
      rootId,
      depth: 0,
      text: 'Deterministic root comment',
      isDeleted: false,
      deletedAt: null,
      likeCount: 1,
      replyCount: 1,
    },
    {
      id: firstReplyId,
      walletAddress: WALLETS.commenter,
      parentId: rootId,
      rootId,
      depth: 1,
      text: 'Direct reply preview fixture',
      isDeleted: false,
      deletedAt: null,
      likeCount: 0,
      replyCount: 1,
    },
    {
      id: secondReplyId,
      walletAddress: WALLETS.creator,
      parentId: firstReplyId,
      rootId,
      depth: 2,
      text: 'Second-level reply fixture',
      isDeleted: false,
      deletedAt: null,
      likeCount: 0,
      replyCount: 1,
    },
    {
      id: thirdReplyId,
      walletAddress: WALLETS.commenter,
      parentId: secondReplyId,
      rootId,
      depth: 3,
      text: 'Maximum-depth reply fixture',
      isDeleted: false,
      deletedAt: null,
      likeCount: 0,
      replyCount: 0,
    },
    {
      id: tombstoneId,
      walletAddress: WALLETS.creator,
      parentId: null,
      rootId: tombstoneId,
      depth: 0,
      text: null,
      isDeleted: true,
      deletedAt: at(-1),
      likeCount: 0,
      replyCount: 0,
    },
  ];
  await tx.commentLike.deleteMany({ where: { commentId: { in: ids } } });
  await tx.comment.deleteMany({ where: { id: { in: ids } } });
  for (const [index, comment] of comments.entries()) {
    await tx.comment.create({
      data: { ...comment, tokenId, createdAt: at(-5 + index) },
    });
  }
  await tx.commentLike.create({
    data: { commentId: rootId, walletAddress: WALLETS.liker, createdAt: at(-1) },
  });
}

async function reconcileSeedOwnedRows(tx: PrismaTypes.TransactionClient): Promise<void> {
  await tx.domainGeneration.upsert({
    where: { domain: 'seed' },
    create: { domain: 'seed', generation: 1n },
    update: { generation: 1n },
  });
}

async function seed(): Promise<void> {
  assertProtocolConstants();
  await prisma.$transaction(
    async (tx) => {
      await upsertProfiles(tx);
      await upsertTokens(tx);
      await reconcileProjections(tx);
      await reconcileTradesAndCandles(tx);
      await reconcileMilestones(tx);
      await reconcileHoldings(tx);
      await reconcileComments(tx);
      await reconcileSeedOwnedRows(tx);
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 120_000 },
  );
}

void seed()
  .then(() => prisma.$disconnect())
  .catch(async (error: unknown) => {
    console.error(error);
    await prisma.$disconnect();
    process.exitCode = 1;
  });
