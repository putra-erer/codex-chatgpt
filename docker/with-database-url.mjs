import { spawn } from "node:child_process";

const [target, command, ...args] = process.argv.slice(2);
if (!["DATABASE_URL", "MIGRATION_DATABASE_URL", "GIS_WORKER_DATABASE_URL"].includes(target) || !command) {
  console.error("Invalid database entrypoint invocation.");
  process.exit(1);
}

const required = ["DATABASE_HOST", "DATABASE_NAME", "DATABASE_USER", "DATABASE_PASSWORD"];
if (required.some((name) => !process.env[name])) {
  console.error("Missing database connection settings.");
  process.exit(1);
}

// Encode credentials instead of interpolating passwords into a URI in Compose.
const connection = new URL("postgresql://db:5432/");
connection.hostname = process.env.DATABASE_HOST;
connection.port = process.env.DATABASE_PORT || "5432";
connection.username = encodeURIComponent(process.env.DATABASE_USER);
connection.password = encodeURIComponent(process.env.DATABASE_PASSWORD);
connection.pathname = encodeURIComponent(process.env.DATABASE_NAME);

const childEnv = { ...process.env, [target]: connection.toString() };
delete childEnv.DATABASE_PASSWORD;
const child = spawn(command, args, { stdio: "inherit", env: childEnv });

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("error", () => {
  console.error("Unable to start application command.");
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) {
    process.exit(signal === "SIGINT" ? 130 : 143);
  }
  process.exit(code ?? 1);
});
