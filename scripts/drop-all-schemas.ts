import { Client } from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is required');
}

const client = new Client({ connectionString });

async function main() {
  await client.connect();
  const res = await client.query<{ nspname: string }>(
    "SELECT nspname FROM pg_namespace WHERE nspname NOT IN ('information_schema','pg_catalog') AND nspname NOT LIKE 'pg_%'",
  );
  for (const row of res.rows) {
    console.log('dropping schema', row.nspname);
    await client.query(`DROP SCHEMA IF EXISTS "${row.nspname}" CASCADE`);
  }
  // Roles may outlive schemas; drop protocol roles if present (ignore errors).
  for (const role of [
    'spawn_owner',
    'spawn_migration',
    'spawn_api',
    'spawn_metadata_worker',
    'spawn_seed',
    'spawn_indexer',
  ]) {
    try {
      await client.query(`DROP ROLE IF EXISTS "${role}"`);
      console.log('dropped role', role);
    } catch (error) {
      console.log('role not dropped:', role, (error as Error).message);
    }
  }
  await client.end();
  console.log('database reset complete');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
