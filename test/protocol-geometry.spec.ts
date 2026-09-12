import {
  bandLevels,
  perBandInventory,
  ladderSupply,
  sizeInventory,
  openingLevel,
  farLevel,
} from '../src/protocol/protocol-math';
import {
  FIXED_TOTAL_SUPPLY,
  MAX_LEVEL,
  PROTOCOL_TEMPLATE_DEFAULT as T,
} from '../src/protocol/protocol-constants';

const FIRST = T.bandFirstStepLevels; // 6932
const DECAY = T.bandStepDecayLevels; // 391
const SPACING = T.bandLevelSpacing; // 2235
const WIDTH = T.bandWidthLevels; // 447

function levels(i: number, grad = 186_449) {
  return bandLevels(grad, FIRST, DECAY, SPACING, WIDTH, i);
}

describe('ladder geometry (decaying schedule, LadderLib closed form)', () => {
  it('first band sits exactly a 2x step (6932 levels) above graduation', () => {
    expect(levels(0).levelLower).toBe(186_449 + 6932);
    expect(levels(0).levelUpper).toBe(186_449 + 6932 + 447);
  });

  it('successive steps shrink by 391 levels to the 2235 floor (LadderLib closed form)', () => {
    // gap(band i -> band i+1) = max(floor, first - decay*(i+1)); k=(6932-2235)/391=12
    for (let i = 0; i < 12; i += 1) {
      const gap = levels(i + 1).levelLower - levels(i).levelLower;
      expect(gap).toBe(Math.max(SPACING, FIRST - DECAY * (i + 1)));
    }
    expect(levels(12).levelLower - levels(11).levelLower).toBe(2240);
    expect(levels(13).levelLower - levels(12).levelLower).toBe(SPACING);
    for (let i = 14; i < 22; i += 1) {
      expect(levels(i).levelLower - levels(i - 1).levelLower).toBe(SPACING);
    }
  });

  it('22-band core ladder tops out near 2900x graduation', () => {
    const last = levels(T.coreBandCount - 1);
    const offset = last.levelLower - 186_449;
    // closed form at m=22 with k=12: first*13 - decay*12*13/2 + (22-13)*2235
    expect(offset).toBe(6932 * 13 - (391 * 12 * 13) / 2 + 9 * 2235);
    expect(Math.pow(1.0001, offset)).toBeGreaterThan(2500);
    expect(Math.pow(1.0001, offset)).toBeLessThan(3300);
    expect(last.exists).toBe(true);
  });

  it('reports exists=false past tick space', () => {
    expect(bandLevels(MAX_LEVEL - 10, FIRST, DECAY, SPACING, WIDTH, 5).exists).toBe(false);
  });
});

describe('supply arithmetic with the pinned 1e27 supply', () => {
  const supply = BigInt(FIXED_TOTAL_SUPPLY);

  it('ladder share is 10% and per-core-band ~4.545M tokens', () => {
    const ladder = ladderSupply(supply, BigInt(T.ladderSupplyShareWad));
    expect(ladder).toBe(supply / 10n);
    const perBand = perBandInventory(supply, BigInt(T.ladderSupplyShareWad), T.coreBandCount);
    expect(perBand).toBe(ladder / 22n);
  });

  it('opening level anchors a 2 ETH FDV on the pinned supply', () => {
    const opening = openingLevel(supply, BigInt(T.openingFdvWei));
    // price at opening = 2e18 / 1e27 = 2e-9 ETH per token => tick = log_1.0001(5e8)
    const far = farLevel(opening, T.curveSpanLevels);
    expect(far - opening).toBe(13862);
  });
});

describe('band inventory caps', () => {
  it('sizeInventory caps at perBand * capMultiple and carries the rest', () => {
    const { amount, carried } = sizeInventory(500n, 100n, 2);
    expect(amount).toBe(200n);
    expect(carried).toBe(300n);
    const under = sizeInventory(150n, 100n, 2);
    expect(under.amount).toBe(150n);
    expect(under.carried).toBe(0n);
  });
});
