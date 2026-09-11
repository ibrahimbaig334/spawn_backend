import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL required');

const adapter = new PrismaPg(new Client({ connectionString }));
const prisma = new PrismaClient({ adapter });

async function main() {
  const tables = await prisma.$queryRawUnsafe<{ table_name: string }[]>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name",
  );
  console.log('tables:', tables.length);
  console.log(tables.map((t) => t.table_name).join(', '));

  const constraints = await prisma.$queryRawUnsafe<{ conname: string }[]>(
    "SELECT conname FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND contype = 'c' ORDER BY conname",
  );
  console.log('check constraints:', constraints.length);

  const roles = await prisma.$queryRawUnsafe<{ rolname: string }[]>(
    "SELECT rolname FROM pg_roles WHERE rolname LIKE 'spawn_%'",
  );
  console.log('roles:', roles.map((r) => r.rolname).join(', '));

  const enums = await prisma.$queryRawUnsafe<{ typname: string }[]>(
    "SELECT typname FROM pg_type t JOIN pg_namespace n ON t.typnamespace = n.oid WHERE n.nspname='public' AND t.typtype='e' ORDER BY typname",
  );
  console.log('enums:', enums.map((e) => e.typname).join(', '));
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
