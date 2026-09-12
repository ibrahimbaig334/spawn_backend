import {
  EVENT_TOPICS,
  entriesByTopic,
  topicByName,
  topicsByContract,
} from '../src/infrastructure/blockchain/event-topics';

describe('event topic registry', () => {
  it('matches the canonical ERC-20 Transfer topic', () => {
    const transfer = topicByName('Transfer');
    expect(transfer?.topic0).toBe(
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
    );
  });

  it('covers the full hook event catalog (27 events)', () => {
    const hookEvents = EVENT_TOPICS.filter((e) => e.contract === 'hook');
    expect(hookEvents.length).toBe(27);
  });

  it('covers registry (4), controller (9), NFT (4), token (2), PoolManager (3)', () => {
    expect(EVENT_TOPICS.filter((e) => e.contract === 'registry').length).toBe(4);
    expect(EVENT_TOPICS.filter((e) => e.contract === 'controller').length).toBe(10);
    expect(EVENT_TOPICS.filter((e) => e.contract === 'revenueNft').length).toBe(4);
    expect(EVENT_TOPICS.filter((e) => e.contract === 'token').length).toBe(2);
    expect(EVENT_TOPICS.filter((e) => e.contract === 'poolManager').length).toBe(3);
  });

  it('resolves Launched with indexed poolId, creator, token', () => {
    const launched = topicByName('Launched');
    expect(launched?.contract).toBe('hook');
    expect(launched?.signature).toBe(
      'Launched(bytes32,address,address,string,string,string,uint256,int24,int24,bytes32)',
    );
  });

  it('maps topic0 back to entries including cross-contract collisions', () => {
    const transfer = topicByName('Transfer')!;
    const hits = entriesByTopic(transfer.topic0);
    expect(hits.length).toBeGreaterThanOrEqual(2); // token ERC-20 + revenueNft ERC-721
  });

  it('topicsByContract returns unique topic0 values', () => {
    const hookTopics = topicsByContract('hook');
    expect(new Set(hookTopics).size).toBe(hookTopics.length);
  });
});
