const { BlockchainRegistryService } = require('\.\./dist/infrastructure/blockchain/blockchain-registry.service.js');
const { ChainClientFactory } = require('\.\./dist/infrastructure/blockchain/chain-client.factory.js');
const { ProtocolReadService } = require('\.\./dist/infrastructure/blockchain/protocol-read.service.js');
const { PrismaService } = require('\.\./dist/infrastructure/database/prisma.service.js');

async function main() {
  const prisma = new PrismaService();
  const clientFactory = new ChainClientFactory();
  const registry = new BlockchainRegistryService(prisma, clientFactory);
  const reads = new ProtocolReadService(registry, clientFactory);
  await registry.onModuleInit();
  console.log('hasChain 8453:', registry.hasChain(8453));
  try {
    const eco = await reads.economicConfig(8453);
    console.log('eco ok:', JSON.stringify(eco));
  } catch (e) {
    console.log('READ ERROR name:', e && e.constructor.name);
    console.log('READ ERROR message:', e && e.message);
  }
  await prisma.$disconnect();
  process.exit(0);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });

