import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
import pg from "pg";
import { parseDevUserOptions } from "./dev-user-options";

dotenv.config({ path: [".env.local", ".env"], quiet: true });

async function main() {
  if (process.env.NODE_ENV === "production" || process.env.ALLOW_DEV_USER_COMMAND !== "true") {
    throw new Error("Development tool disabled. Set ALLOW_DEV_USER_COMMAND=true only for an isolated development database. Never use on production.");
  }
  const options = parseDevUserOptions(process.argv.slice(2));
  const connectionString = process.env.MIGRATION_DATABASE_URL;
  if (!connectionString) throw new Error("MIGRATION_DATABASE_URL is required for this local administrative tool.");
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query("BEGIN");
    // Same lock as authentication bootstrap, preventing concurrent last-admin loss.
    await client.query("SELECT pg_advisory_xact_lock(73429101)");
    const { rows: [actor] } = await client.query<{ id: string }>(
      "SELECT id FROM app.users WHERE email=$1 AND status='APPROVED' AND role='ADMIN' AND google_id IS NOT NULL AND email_verified IS NOT NULL",
      [options.actorEmail],
    );
    if (!actor) throw new Error("--approved-by must identify an existing approved administrator who has logged in with Google.");
    const { rows: [user] } = await client.query<{
      id: string; google_id: string | null; email_verified: Date | null; status: string; role: string;
    }>("SELECT id, google_id, email_verified, status, role FROM app.users WHERE email=$1 FOR UPDATE", [options.email]);
    if (!user?.google_id || !user.email_verified) {
      throw new Error("User must log in with verified Google first. This command never creates users or sessions.");
    }
    const bootstrapEmails = (process.env.SUPER_ADMIN_EMAILS ?? "").split(",").map((email) => email.trim().toLowerCase());
    if (bootstrapEmails.includes(options.email) && (options.status !== "APPROVED" || options.role !== "ADMIN")) {
      throw new Error("Remove this email from SUPER_ADMIN_EMAILS and restart the app before demoting or rejecting it; otherwise Google login promotes it again.");
    }
    if (user.status === "APPROVED" && user.role === "ADMIN" && (options.status !== "APPROVED" || options.role !== "ADMIN")) {
      const { rows: [{ count }] } = await client.query<{ count: string }>(
        "SELECT count(*) FROM app.users WHERE status='APPROVED' AND role='ADMIN'",
      );
      if (Number(count) <= 1) throw new Error("Cannot remove the last approved administrator.");
    }
    await client.query(
      `UPDATE app.users SET status=$1, role=$2,
       approved_by=CASE WHEN $1='APPROVED' THEN $3::uuid ELSE NULL END,
       approved_at=CASE WHEN $1='APPROVED' THEN COALESCE(approved_at,now()) ELSE NULL END,
       updated_at=now() WHERE id=$4`,
      [options.status, options.role, actor.id, user.id],
    );
    const metadata = { source: "development_command", before: { status: user.status, role: user.role }, after: { status: options.status, role: options.role } };
    const actions: string[] = [];
    if (options.status !== user.status) {
      actions.push(options.status === "APPROVED" ? "USER_APPROVED" : options.status === "REJECTED" ? "USER_REJECTED" : "DEV_USER_RESET_PENDING");
    }
    if (options.role !== user.role) actions.push("ROLE_CHANGED");
    const requestId = randomUUID();
    for (const action of actions) {
      await client.query(
        "INSERT INTO app.audit_logs (user_id,action,target_type,target_id,metadata,request_id) VALUES ($1,$2,'user',$3,$4,$5)",
        [actor.id, action, user.id, JSON.stringify(metadata), requestId],
      );
    }
    if (options.status === "REJECTED") {
      await client.query("DELETE FROM app.sessions WHERE user_id=$1", [user.id]);
    }
    await client.query("COMMIT");
    console.log(`User updated: ${options.status} / ${options.role}. Refresh the page; rejected users must log in again.`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  // Database errors may contain connection details. Only deliberate tool errors are printed.
  if (error instanceof Error && error.constructor === Error) console.error(error.message);
  else console.error("Development user update failed. Check database availability and configuration.");
  process.exitCode = 1;
});
