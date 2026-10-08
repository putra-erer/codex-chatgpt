import { config } from "dotenv";
import { Pool } from "pg";
import { recoverExpiredJobs, runNextJob } from "../src/server/jobs/worker";

config({ path: [".env.local", ".env"], quiet: true });

async function main() {
  const connectionString = process.env.GIS_WORKER_DATABASE_URL;
  if (!connectionString || !/^postgres(?:ql)?:\/\//.test(connectionString))
    throw new Error(
      "Set GIS_WORKER_DATABASE_URL for the dedicated GIS worker role.",
    );
  const pool = new Pool({
    connectionString,
    max: 4,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 120_000,
    application_name: "company-gis-worker",
  });
  pool.on("error", () =>
    console.error("GIS worker database connection interrupted."),
  );
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const identity = await pool.query<{ allowed: boolean }>(`
      SELECT r.rolname='gis_worker' AND session_user='gis_worker'
        AND NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
        AND NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid)
        AND NOT EXISTS (SELECT 1 FROM pg_database d WHERE d.datname=current_database() AND d.datdba=r.oid)
        AS allowed FROM pg_roles r WHERE r.rolname=current_user
    `);
    if (identity.rows[0]?.allowed !== true)
      throw new Error("GIS worker must connect as the dedicated, unprivileged gis_worker role.");
    console.info("GIS worker ready. Processing one job at a time.");
    let recoveredAt = 0;
    do {
      try {
        if (Date.now() - recoveredAt > 30_000) {
          await recoverExpiredJobs(pool);
          recoveredAt = Date.now();
        }
        if (process.argv.includes("--recover-only")) break;
        const worked = await runNextJob(pool);
        if (process.argv.includes("--once")) break;
        if (!worked && !stopping)
          await new Promise((resolve) => setTimeout(resolve, 1_000));
      } catch {
        console.error(
          "GIS worker could not reach the queue. Retrying shortly.",
        );
        if (
          process.argv.includes("--once") ||
          process.argv.includes("--recover-only")
        )
          throw new Error("GIS worker could not process the queue.");
        if (!stopping)
          await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
    } while (!stopping);
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error && error.constructor === Error
      ? error.message
      : "GIS worker stopped. Check its database and storage configuration.",
  );
  process.exitCode = 1;
});
