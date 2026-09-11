import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL required');

const adapter = new PrismaPg(new Client({ connectionString }));
const prisma = new PrismaClient({ adapter });

async function main(): Promise<void> {
  const rows = await prisma.deploymentManifest.findMany();
  console.log('manifests:', rows.map((r) => `${r.chainId}: hook=${(r.document as { hook: string }).hook}`).join(' | ') || '(none)');
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
