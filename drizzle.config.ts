import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

config({ path: [".env.local", ".env"], quiet: true });

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/db/schema.ts",
  out: "./migrations",
  schemaFilter: ["app"],
  strict: true,
  verbose: false,
  ...(process.env.MIGRATION_DATABASE_URL
    ? { dbCredentials: { url: process.env.MIGRATION_DATABASE_URL } }
    : {}),
});
