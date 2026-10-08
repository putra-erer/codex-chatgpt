import { randomBytes } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { config } from "dotenv";
import { Client } from "pg";
config({ path: [".env.local", ".env"], quiet: true });

async function main() {
  const writeEnv = process.argv.includes("--write-env");
  if (process.argv.slice(2).some(a => a !== "--write-env")) throw new Error("Use --write-env for local development setup.");
  if (writeEnv && process.env.NODE_ENV === "production") throw new Error("--write-env is only for local development.");
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  if (!ownerUrl) throw new Error("MIGRATION_DATABASE_URL is required.");
  const password = process.env.GIS_WORKER_DB_PASSWORD || (writeEnv ? randomBytes(32).toString("hex") : "");
  if (password.length < 24) throw new Error("Set GIS_WORKER_DB_PASSWORD to a separate random password of at least 24 characters.");
  const workerUrl = new URL(ownerUrl);
  workerUrl.username = "gis_worker"; workerUrl.password = encodeURIComponent(password);
  let envText: string | undefined;
  const envPath = existsSync(".env.local") ? ".env.local" : ".env";
  if (writeEnv) {
    envText = await readFile(envPath, "utf8");
    for (const [key,value] of Object.entries({ GIS_WORKER_DB_PASSWORD: password, GIS_WORKER_DATABASE_URL: workerUrl.toString() })) {
      const line = `${key}=${JSON.stringify(value)}`;
      const pattern = new RegExp(`^${key}=.*$`, "m");
      envText = pattern.test(envText) ? envText.replace(pattern, () => line) : `${envText.trimEnd()}\n${line}\n`;
    }
  }
  const client = new Client({ connectionString: ownerUrl, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    await client.query("SELECT set_config('portal.worker_password',$1,false)", [password]);
    await client.query("DO $$ BEGIN EXECUTE format('ALTER ROLE gis_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L', current_setting('portal.worker_password')); END $$");
  } finally { await client.end(); }
  if (envText !== undefined) {
    const temp = `${envPath}.worker-${randomBytes(8).toString("hex")}`;
    await writeFile(temp, envText, { mode: 0o600, flag: "wx" });
    await rename(temp, envPath);
  }
  console.info(writeEnv ? `Worker database login configured; private settings saved in ${envPath}.` : "Worker database login configured.");
}
main().catch(() => {
  console.error("Worker setup failed. Run db:migrate first, check the migration-owner connection and GIS_WORKER_DB_PASSWORD (minimum 24 characters). No credentials were logged.");
  process.exitCode = 1;
});
