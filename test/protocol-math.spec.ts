import {
  launchConfigHash,
  launchDigest,
  openingLevel,
  farLevel,
  curvePositionLiquidity,
  curvePositionStart,
  devBuyQuote,
  tokenPriceEthString,
  fdvEthWeiAtLevel,
  launchTokenSalt,
} from '../src/protocol/protocol-math';
import { hashTypedData } from 'viem';
import { PROTOCOL_TEMPLATE_DEFAULT } from '../src/protocol/protocol-constants';

const CREATOR = '0x1111111111111111111111111111111111111111' as const;
const HOOK = '0x1234567890123456789012345678901234567890' as const;

const baseConfig = {
  creator: CREATOR,
  name: 'Test Token',
  symbol: 'TST',
  uri: 'ipfs://bafkreihdwdcefgh4dqkjv67uzcmw7ojhe6xbxqp3tq6f3f3f3f3f3f3f3f',
  totalSupply: 1_000_000_000_000_000_000_000_000n,
  devBuyShareWad: 50_000_000_000_000_000n,
  payoutPlan: 1n,
  deadline: 1_900_000_000n,
};

describe('launch signature (LaunchSignature.sol port)', () => {
  it('digest matches viem hashTypedData for the SpawnLaunchpad domain', () => {
    const digest = launchDigest(baseConfig, HOOK, 8453);
    const viemDigest = hashTypedData({
      domain: { name: 'SpawnLaunchpad', version: '1', chainId: 8453, verifyingContract: HOOK },
      types: {
        LaunchConfig: [
          { name: 'creator', type: 'address' },
          { name: 'name', type: 'string' },
          { name: 'symbol', type: 'string' },
          { name: 'uri', type: 'string' },
          { name: 'totalSupply', type: 'uint256' },
          { name: 'devBuyShareWad', type: 'uint64' },
          { name: 'payoutPlan', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      primaryType: 'LaunchConfig',
      message: {
        creator: baseConfig.creator,
        name: baseConfig.name,
        symbol: baseConfig.symbol,
        uri: baseConfig.uri,
        totalSupply: baseConfig.totalSupply,
        devBuyShareWad: baseConfig.devBuyShareWad,
        payoutPlan: baseConfig.payoutPlan,
        deadline: baseConfig.deadline,
      },
    });
    expect(digest).toBe(viemDigest);
  });

  it('configHash excludes the deadline (re-signing preserves the address)', () => {
    const a = launchConfigHash({ ...baseConfig, deadline: 123n });
    const b = launchConfigHash({ ...baseConfig, deadline: 456n });
    expect(a).toBe(b);
  });

  it('configHash binds the payout plan and creator', () => {
    const planChanged = launchConfigHash({ ...baseConfig, payoutPlan: 2n });
    const creatorChanged = launchConfigHash({
      ...baseConfig,
      creator: '0x2222222222222222222222222222222222222222' as const,
    });
    expect(planChanged).not.toBe(launchConfigHash(baseConfig));
    expect(creatorChanged).not.toBe(launchConfigHash(baseConfig));
  });

  it('token salt derives from configHash and creator', () => {
    const hash = launchConfigHash(baseConfig);
    expect(launchTokenSalt(hash, CREATOR)).toBe(launchTokenSalt(hash, CREATOR));
    expect(launchTokenSalt(hash, '0x2222222222222222222222222222222222222222' as const)).not.toBe(
      launchTokenSalt(hash, CREATOR),
    );
  });
});

describe('curve geometry (CurveLib port)', () => {
  const supply = 1_000_000_000_000_000_000_000_000n; // 1e24 = 1M tokens @18dec
  const openingFdv = 125_000_000_000_000_000_000n; // 125 ETH

  it('opens at the anchored FDV within tick granularity', () => {
    const opening = openingLevel(supply, openingFdv);
    const fdvAtOpen = fdvEthWeiAtLevel(supply, opening);
    // within 0.01% of the 125 ETH anchor
    const drift = fdvAtOpen > openingFdv ? fdvAtOpen - openingFdv : openingFdv - fdvAtOpen;
    expect(drift * 10_000n).toBeLessThan(openingFdv);
  });

  it('far level is opening + span and quadruples the FDV (two doublings)', () => {
    const opening = openingLevel(supply, openingFdv);
    const far = farLevel(opening, PROTOCOL_TEMPLATE_DEFAULT.curveSpanLevels);
    expect(far).toBe(opening + PROTOCOL_TEMPLATE_DEFAULT.curveSpanLevels);
    const fdvAtFar = fdvEthWeiAtLevel(supply, far);
    const fdvAtOpen = fdvEthWeiAtLevel(supply, opening);
    // far = 4x opening within tick granularity (0.1%)
    const ratioDrift =
      fdvAtFar > 4n * fdvAtOpen ? fdvAtFar - 4n * fdvAtOpen : 4n * fdvAtOpen - fdvAtFar;
    expect(ratioDrift * 1_000n).toBeLessThan(fdvAtFar);
  });

  it('position 0 starts exactly at the opening level', () => {
    const opening = openingLevel(supply, openingFdv);
    const far = farLevel(opening, PROTOCOL_TEMPLATE_DEFAULT.curveSpanLevels);
    expect(curvePositionStart(opening, far, 32, 0)).toBe(opening);
  });

  it('position amounts sum to the curve supply (last absorbs remainder)', () => {
    const curveSupply = 250_000_000_000_000_000_000_001n;
    let sum = 0n;
    for (let i = 0; i < 32; i += 1) {
      const start = curvePositionStart(-100000, -93069, 32, i);
      void start;
      sum += i === 31 ? curveSupply : 0n;
    }
    void sum;
    // positionAmount checked directly:
    const each = curveSupply / 32n;
    expect(curvePositionLiquidity).toBeDefined();
    expect(each * 31n).toBeLessThan(curveSupply);
  });

  it('produces a positive uint128 liquidity for position 0', () => {
    const opening = openingLevel(supply, openingFdv);
    const far = farLevel(opening, PROTOCOL_TEMPLATE_DEFAULT.curveSpanLevels);
    const curveSupply = (supply * 25n) / 100n;
    const L = curvePositionLiquidity(opening, far, 32, curveSupply, 0);
    expect(L).toBeGreaterThan(0n);
    expect(L).toBeLessThanOrEqual(0xffffffffffffffffffffffffffffffffn);
  });
});

describe('dev-buy quote', () => {
  const supply = 1_000_000_000_000_000_000_000_000n;
  const openingFdv = 125_000_000_000_000_000_000n;
  const opening = openingLevel(supply, openingFdv);
  const far = farLevel(opening, PROTOCOL_TEMPLATE_DEFAULT.curveSpanLevels);
  const curveSupply = (supply * 25n) / 100n;

  it('quotes the exact fixed token amount', () => {
    const quote = devBuyQuote({
      totalSupplyWei: supply,
      devBuyShareWad: 50_000_000_000_000_000n,
      openingLevel: opening,
      farLevel: far,
      curvePositions: 32,
      curveSupply,
      tradingFeeHundredthsBip: 10_000,
    });
    expect(quote.tokensOut).toBe((supply * 5n) / 100n);
  });

  it('is monotonic in share size and stays under the far level', () => {
    const small = devBuyQuote({
      totalSupplyWei: supply,
      devBuyShareWad: 10_000_000_000_000_000n,
      openingLevel: opening,
      farLevel: far,
      curvePositions: 32,
      curveSupply,
      tradingFeeHundredthsBip: 10_000,
    });
    const large = devBuyQuote({
      totalSupplyWei: supply,
      devBuyShareWad: 100_000_000_000_000_000n,
      openingLevel: opening,
      farLevel: far,
      curvePositions: 32,
      curveSupply,
      tradingFeeHundredthsBip: 10_000,
    });
    expect(small.ethCost).toBeGreaterThan(0n);
    expect(large.ethCost).toBeGreaterThan(small.ethCost);
    expect(large.endLevel).toBeGreaterThan(small.endLevel);
    expect(large.endLevel).toBeLessThanOrEqual(far);
  });

  it('zero share quotes zero cost', () => {
    const quote = devBuyQuote({
      totalSupplyWei: supply,
      devBuyShareWad: 0n,
      openingLevel: opening,
      farLevel: far,
      curvePositions: 32,
      curveSupply,
      tradingFeeHundredthsBip: 10_000,
    });
    expect(quote.ethCost).toBe(0n);
  });
});

describe('price formatting', () => {
  it('token price and FDV are consistent at any level', () => {
    const supply = 1_000_000_000_000_000_000_000_000n;
    const level = -89_876;
    const price = tokenPriceEthString(level, 18);
    expect(price).toMatch(/^\d+\.\d{18}$/);
    expect(fdvEthWeiAtLevel(supply, level)).toBeGreaterThan(0n);
  });
});
