import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

const globalDb = globalThis as unknown as { portalPool?: Pool };

export function getPool() {
  if (!globalDb.portalPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString || !/^postgres(?:ql)?:\/\//.test(connectionString)) {
      throw new Error("Missing or invalid environment configuration: DATABASE_URL");
    }
    globalDb.portalPool = new Pool({ connectionString, max: 10, connectionTimeoutMillis: 5_000 });
  }
  return globalDb.portalPool;
}

export function getDb() {
  return drizzle(getPool(), { schema });
}

export type Database = ReturnType<typeof getDb>;
