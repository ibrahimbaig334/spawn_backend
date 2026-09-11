import { buildAddressBook, AddressBookError } from '../src/infrastructure/blockchain/address-book';

const HOOK = '0x1111111111111111111111111111111111111111';
const SUPPORT = '0x2222222222222222222222222222222222222222';
const NFT = '0x3333333333333333333333333333333333333333';
const REGISTRY = '0x4444444444444444444444444444444444444444';
const CONTROLLER = '0x5555555555555555555555555555555555555555';

const manifest = {
  chainId: 8453,
  hook: HOOK,
  launchSupport: SUPPORT,
  revenueNft: NFT,
  payoutPluginRegistry: REGISTRY,
  protocolController: CONTROLLER,
};

describe('address book', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.SPAWN_HOOK_ADDRESS;
    delete process.env.SPAWN_LAUNCH_SUPPORT_ADDRESS;
    delete process.env.SPAWN_REVENUE_NFT_ADDRESS;
    delete process.env.SPAWN_REGISTRY_ADDRESS;
    delete process.env.SPAWN_CONTROLLER_ADDRESS;
    delete process.env.POOL_MANAGER_ADDRESS;
    delete process.env.STATE_VIEW_ADDRESS;
    delete process.env.V4_QUOTER_ADDRESS;
    delete process.env.MULTICALL3_ADDRESS;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('builds from a manifest with Base defaults for infra', () => {
    const book = buildAddressBook(8453, manifest);
    expect(book.hook).toBe(HOOK);
    expect(book.poolManager).toBe('0x498581ff718922c3f8e6a244956af099b2652b2b');
    expect(book.multicall3).toBe('0xca11bde05977b3631167028862be2a173976ca11');
  });

  it('lowercases addresses', () => {
    const book = buildAddressBook(8453, {
      ...manifest,
      hook: HOOK.toUpperCase().replace('0X', '0x'),
    });
    expect(book.hook).toBe(HOOK);
  });

  it('environment overrides win over the manifest', () => {
    process.env.SPAWN_HOOK_ADDRESS = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const book = buildAddressBook(8453, manifest);
    expect(book.hook).toBe('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  });

  it('fails closed when protocol addresses are missing', () => {
    expect(() => buildAddressBook(8453, undefined)).toThrow(AddressBookError);
    expect(() => buildAddressBook(8453, { ...manifest, hook: undefined })).toThrow(
      AddressBookError,
    );
  });

  it('rejects invalid addresses and chain mismatches', () => {
    expect(() => buildAddressBook(8453, { ...manifest, hook: '0x1234' })).toThrow(AddressBookError);
    expect(() => buildAddressBook(1, manifest)).toThrow(AddressBookError);
  });
});
