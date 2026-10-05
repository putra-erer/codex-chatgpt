import { config } from "dotenv";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { resolve } from "node:path";

config({ path: [".env.local", ".env"], quiet: true });

async function main() {
  const connectionString = process.env.MIGRATION_DATABASE_URL;
  if (!connectionString || !/^postgres(?:ql)?:\/\//.test(connectionString)) {
    throw new Error("MIGRATION_DATABASE_URL_REQUIRED");
  }

  const client = new Client({ connectionString, connectionTimeoutMillis: 10_000 });
  let locked = false;
  try {
    await client.connect();
    // A dedicated connection keeps the advisory lock through the entire migration.
    await client.query("SET lock_timeout = '60s'");
    await client.query("SELECT pg_advisory_lock($1)", [1_710_500_001]);
    locked = true;
    await migrate(drizzle(client), { migrationsFolder: resolve("migrations") });
    console.info("Database migrations complete.");
  } finally {
    if (locked) {
      await client.query("SELECT pg_advisory_unlock($1)", [1_710_500_001]).catch(() => undefined);
    }
    await client.end();
  }
}

main().catch((error: unknown) => {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  const safeCode = /^[A-Z0-9_]{1,32}$/.test(code) ? ` (${code})` : "";
  // Driver errors can include SQL, connection URLs, or user data; do not dump them.
  console.error(`Database migration failed${safeCode}. Check MIGRATION_DATABASE_URL, owner permissions, and migration files.`);
  process.exitCode = 1;
});
