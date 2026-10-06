import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { config } from "dotenv";
import { Client } from "pg";

config({ path: [".env.local", ".env"], quiet: true });

function databaseUrl(name: "DATABASE_URL" | "MIGRATION_DATABASE_URL") {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error(`${name} must be a PostgreSQL URL.`);
  return url;
}

async function command(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, args, { env, stdio: "inherit" });
  const forwardSignal = (signal: NodeJS.Signals) => child.kill(signal);
  const onInterrupt = () => forwardSignal("SIGINT");
  const onTerminate = () => forwardSignal("SIGTERM");
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  try {
    await new Promise<void>((done, reject) => {
      child.once("error", () => reject(new Error("Could not start integration command.")));
      child.once("exit", (code, signal) => code === 0 ? done() : reject(new Error(`Integration command failed (${signal ?? code}).`)));
    });
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
}

async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("Run integration tests against a development PostgreSQL server.");
  await access(resolve(".next/standalone/server.js")).catch(() => {
    throw new Error("Run npm run build before npm run test:integration.");
  });
  const owner = databaseUrl("MIGRATION_DATABASE_URL");
  const app = databaseUrl("DATABASE_URL");
  if (owner.hostname !== app.hostname || (owner.port || "5432") !== (app.port || "5432")
    || decodeURIComponent(app.username) !== "gis_app" || owner.username === app.username) {
    throw new Error("Use separate migration-owner and gis_app URLs on the same development PostgreSQL server.");
  }
  // Only this randomly named database is ever migrated, populated, or removed.
  const name = `portal_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: owner.toString(), connectionTimeoutMillis: 10_000 });
  let created = false;
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
    created = true;
    await admin.query(`REVOKE ALL ON DATABASE "${name}" FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE "${name}" TO gis_app`);
    owner.pathname = `/${name}`;
    app.pathname = `/${name}`;
    // Prevent .env or .env.local from replacing the isolated connection strings.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: "test",
      DATABASE_URL: app.toString(),
      MIGRATION_DATABASE_URL: owner.toString(),
      PORTAL_INTEGRATION_DATABASE: name,
      AUTH_URL: "http://localhost:3000",
      AUTH_SECRET: randomUUID() + randomUUID(),
      GOOGLE_CLIENT_ID: "integration-only-client",
      GOOGLE_CLIENT_SECRET: "integration-only-secret",
      SUPER_ADMIN_EMAILS: "admin@integration.example",
    };
    console.info("Created isolated integration database. Existing application data is untouched.");
    await command(["--import", "tsx", "scripts/migrate.ts"], env);
    await command(["--import", "tsx", "scripts/migrate.ts"], env);
    await command(["node_modules/vitest/vitest.mjs", "run", "--config", "vitest.integration.config.ts"], env);
  } finally {
    try {
      if (created) {
        await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
        console.info("Removed isolated integration database.");
      }
    } finally {
      await admin.end();
    }
  }
}

main().catch((error: unknown) => {
  // PostgreSQL errors may contain credentials or SQL. Report only safe tool errors/codes.
  if (error instanceof Error && error.constructor === Error && !("code" in error)) {
    console.error(error.message);
  } else {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    console.error(`Integration setup/cleanup failed${/^[A-Z0-9_]{1,32}$/.test(code) ? ` (${code})` : ""}. Check PostgreSQL availability and the migration owner's CREATE DATABASE permission.`);
  }
  process.exitCode = 1;
});
