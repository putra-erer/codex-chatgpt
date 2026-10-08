import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createShapefileFixture } from "../tests/helpers/shapefile-fixture.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(`${root}/package.json`);
const { Client } = require("pg");
const { config } = require("dotenv");
const { chromium, expect } = require("@playwright/test");
const screenshots = join(root, "test-results/vector");

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

async function run() {
  ensure(
    process.env.NODE_ENV !== "production",
    "Use a development PostgreSQL server for browser tests.",
  );
  config({ path: [join(root, ".env.local"), join(root, ".env")], quiet: true });
  for (const key of [
    "MIGRATION_DATABASE_URL",
    "DATABASE_URL",
    "GIS_WORKER_DATABASE_URL",
  ])
    ensure(process.env[key], `${key} is required for the vector browser test.`);
  ensure(
    existsSync(join(root, ".next/standalone/server.js")),
    "Run npm run build before the vector browser test.",
  );
  const migration = new URL(process.env.MIGRATION_DATABASE_URL);
  const application = new URL(process.env.DATABASE_URL);
  const workerUrl = new URL(process.env.GIS_WORKER_DATABASE_URL);
  ensure(
    [migration, application, workerUrl].every((url) =>
      ["postgres:", "postgresql:"].includes(url.protocol),
    ) &&
      [application, workerUrl].every(
        (url) =>
          url.hostname === migration.hostname &&
          (url.port || "5432") === (migration.port || "5432"),
      ) &&
      decodeURIComponent(application.username) === "gis_app" &&
      decodeURIComponent(workerUrl.username) === "gis_worker" &&
      ![application.username, workerUrl.username].includes(migration.username),
    "Use separate migration-owner, gis_app and gis_worker URLs on the same development PostgreSQL server.",
  );

  const databaseName = `portal_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({
    connectionString: migration.toString(),
    connectionTimeoutMillis: 10000,
  });
  let created = false;
  let owner, server, worker, browser, privateDirectory, page;
  try {
    await mkdir(screenshots, { recursive: true });
    privateDirectory = await mkdtemp(join(tmpdir(), "portal-vector-browser-"));
    const archive = await createShapefileFixture(privateDirectory, {
      targetCrs: "EPSG:3857",
    });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0`);
    created = true;
    await admin.query(`REVOKE ALL ON DATABASE "${databaseName}" FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE "${databaseName}" TO gis_app`);
    migration.pathname =
      application.pathname =
      workerUrl.pathname =
        `/${databaseName}`;
    const env = {
      ...process.env,
      NODE_ENV: "test",
      MIGRATION_DATABASE_URL: migration.toString(),
      DATABASE_URL: application.toString(),
      GIS_WORKER_DATABASE_URL: workerUrl.toString(),
      GIS_STORAGE_ROOT: join(privateDirectory, "private-storage"),
    };
    const migrate = spawn(
      process.execPath,
      ["--import", "tsx", "scripts/migrate.ts"],
      { cwd: root, env, stdio: "ignore" },
    );
    const [migrationCode] = await once(migrate, "exit");
    ensure(migrationCode === 0, "Isolated migration failed.");
    owner = new Client({ connectionString: migration.toString() });
    await owner.connect();
    async function fixture(role, status = "APPROVED") {
      const id = randomUUID();
      const subject = `vector-browser-${id}`;
      const token = randomBytes(32).toString("hex");
      const email = `${role.toLowerCase()}-${id}@browser.example.test`;
      await owner.query(
        `INSERT INTO app.users (id,name,email,google_id,email_verified,status,role,approved_at)
        VALUES ($1,$2,$3,$4,now(),$5::app.user_status,$6,CASE WHEN $5::app.user_status='APPROVED' THEN now() ELSE NULL END)`,
        [id, `${role} browser test`, email, subject, status, role],
      );
      await owner.query(
        "INSERT INTO app.accounts(user_id,type,provider,provider_account_id) VALUES ($1,'oidc','google',$2)",
        [id, subject],
      );
      await owner.query(
        "INSERT INTO app.sessions(session_token,user_id,expires) VALUES ($1,$2,now()+interval '1 hour')",
        [token, id],
      );
      return { id, email, token };
    }
    const administrator = await fixture("ADMIN");
    const participant = await fixture("VIEWER");
    const pending = await fixture("VIEWER", "PENDING");
    const rejected = await fixture("VIEWER", "REJECTED");
    ensure(
      (await owner.query("SELECT count(*)::int AS count FROM app.layers"))
        .rows[0].count === 0,
      "Fresh database unexpectedly contains GIS layers.",
    );
    await cp(
      join(root, ".next/static"),
      join(root, ".next/standalone/.next/static"),
      {
        recursive: true,
      },
    );
    await cp(join(root, "public"), join(root, ".next/standalone/public"), {
      recursive: true,
    });
    const listener = createServer();
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    const port = listener.address().port;
    await new Promise((resolve) => listener.close(resolve));
    const baseUrl = `http://127.0.0.1:${port}`;
    const production = {
      ...env,
      NODE_ENV: "production",
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
      AUTH_URL: baseUrl,
      AUTH_SECRET: randomBytes(32).toString("hex"),
      GOOGLE_CLIENT_ID: "vector-browser-client",
      GOOGLE_CLIENT_SECRET: "vector-browser-secret",
      SUPER_ADMIN_EMAILS: administrator.email,
    };
    server = spawn(
      process.execPath,
      [join(root, ".next/standalone/server.js")],
      {
        cwd: root,
        env: production,
        stdio: "ignore",
      },
    );
    const workerImage = process.env.GIS_TEST_WORKER_IMAGE;
    worker = spawn(
      workerImage ? "docker" : process.execPath,
      workerImage ? [
        "run", "--rm", "--network", "host",
        "--user", `${process.getuid()}:${process.getgid()}`,
        "--mount", `type=bind,source=${privateDirectory},target=${privateDirectory}`,
        "--env", "GIS_WORKER_DATABASE_URL", "--env", "GIS_STORAGE_ROOT",
        "--env", "NODE_ENV=production", "--entrypoint", "node", workerImage,
        "--import", "tsx", "scripts/gis-worker.ts",
      ] : ["--import", "tsx", "scripts/gis-worker.ts"],
      {
        cwd: root,
        env: production,
        stdio: "inherit",
      },
    );
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        ready = (await fetch(`${baseUrl}/login`)).status === 200;
      } catch {}
      if (ready) break;
      await delay(100);
    }
    ensure(ready, "Production server did not start.");
    ensure(
      worker.exitCode === null,
      "GIS worker exited before the upload test.",
    );
    browser = await chromium.launch({
      executablePath:
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
        (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
      headless: true,
      args: [
        "--no-sandbox",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
      ],
    });
    async function contextFor(user) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      });
      if (user)
        await context.addCookies([
          {
            name: "authjs.session-token",
            value: user.token,
            url: baseUrl,
            httpOnly: true,
            sameSite: "Lax",
          },
        ]);
      return context;
    }
    const context = await contextFor(administrator);
    page = await context.newPage();
    page.setDefaultTimeout(20000);
    const browserErrors = [];
    page.on("pageerror", () => browserErrors.push("admin-runtime-error"));
    await page.goto(`${baseUrl}/admin/layers`);
    await expect(
      page.getByRole("heading", { name: "No GIS layers available." }),
    ).toBeVisible();
    await page
      .getByRole("link", { name: "Upload shapefile", exact: true })
      .first()
      .click();
    await expect(
      page.getByRole("heading", { name: "Upload shapefile", exact: true }),
    ).toBeVisible();
    await page
      .getByLabel("Shapefile ZIP", { exact: true })
      .setInputFiles(archive);
    await page
      .getByLabel("Layer name", { exact: true })
      .fill("Uploaded browser polygon");
    await page
      .getByLabel(/Description/)
      .fill("Isolated end-to-end shapefile upload");
    const accepted = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/admin/uploads" &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Upload shapefile", exact: true })
      .click();
    const uploadResponse = await accepted;
    ensure(uploadResponse.status() === 202, "Browser upload was not accepted.");
    const { layerId, jobId } = await uploadResponse.json();
    ensure(
      /^[0-9a-f-]{36}$/.test(layerId) && /^[0-9a-f-]{36}$/.test(jobId),
      "Upload did not return valid layer and job identifiers.",
    );
    await expect(
      page.getByText(
        "Your layer is ready. You can view it on the map or manage its details.",
      ),
    ).toBeVisible({ timeout: 90000 });
    const stored = (
      await owner.query(
        "SELECT *,ST_SRID(bbox) AS bbox_srid FROM app.layers WHERE id=$1",
        [layerId],
      )
    ).rows[0];
    ensure(
      stored.state === "READY" &&
        stored.source_type === "SHP" &&
        stored.layer_type === "VECTOR" &&
        Number(stored.feature_count) === 1 &&
        stored.srid === 4326 &&
        stored.source_srid === 3857 &&
        stored.bbox_srid === 4326 &&
        /Polygon$/.test(stored.geometry_type) &&
        stored.uploaded_by === administrator.id,
      "Published shapefile metadata or CRS transformation is incorrect.",
    );
    ensure(
      stored.table_name === `layer_${layerId.replaceAll("-", "")}`,
      "Unexpected imported table identifier.",
    );
    const table = `gis."${stored.table_name}"`;
    const feature = (
      await owner.query(
        `SELECT properties,ST_SRID(geom) AS srid,ST_IsValid(geom) AS valid FROM ${table}`,
      )
    ).rows[0];
    ensure(
      feature.properties.name === "Kebun café 中文" &&
        feature.srid === 4326 &&
        feature.valid,
      "Imported geometry or Unicode attributes were not preserved.",
    );
    await expect
      .poll(() =>
        existsSync(
          join(env.GIS_STORAGE_ROOT, stored.storage_metadata.uploadId),
        ),
      )
      .toBe(false);
    await page.screenshot({
      path: join(screenshots, "upload-ready.png"),
      fullPage: true,
    });
    await page.getByRole("link", { name: "View on map", exact: true }).click();
    await page.locator('[data-map-ready="true"]').waitFor({ timeout: 30000 });
    await expect(
      page.getByText("1 visible layers", { exact: false }),
    ).toBeVisible();
    async function openFeature(targetPage) {
      await targetPage.bringToFront();
      const canvas = targetPage.locator(".maplibregl-canvas");
      try {
        // A click during MapLibre's fit animation stops it at the wrong extent.
        // Wait for the fixture's center in the real coordinate readout before clicking.
        await expect.poll(async () => {
          const box = await canvas.boundingBox();
          if (!box) return false;
          await targetPage.mouse.move(box.x + box.width / 2 + 1, box.y + box.height / 2);
          await targetPage.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          const readout = await targetPage.getByText(/^Lng /).textContent();
          const match = readout?.match(/Lng ([-\d.]+)° · Lat ([-\d.]+)°/);
          return Boolean(match && Math.abs(Number(match[1]) - 106.82) < 0.0001 && Math.abs(Number(match[2]) + 6.2) < 0.0001);
        }, { timeout: 30000, intervals: [200, 500] }).toBe(true);
        await expect
          .poll(
            async () => {
              const box = await canvas.boundingBox();
              ensure(
                box && box.width > 200 && box.height > 200,
                "Map canvas has no usable dimensions.",
              );
              await targetPage.mouse.click(
                box.x + box.width / 2,
                box.y + box.height / 2,
              );
              return targetPage.locator(".gis-popup").count();
            },
            { timeout: 30000, intervals: [500, 1000] },
          )
          .toBe(1);
      } catch (error) {
        await targetPage.screenshot({
          path: join(screenshots, "map-failure.png"),
          fullPage: true,
        });
        throw error;
      }
      await expect(targetPage.locator(".gis-popup")).toContainText(
        "Kebun café 中文",
      );
      await expect(targetPage.locator(".gis-popup")).toContainText("42.25");
    }
    await openFeature(page);
    await page.screenshot({
      path: join(screenshots, "imported-map-popup.png"),
      fullPage: true,
    });
    await page.goto(`${baseUrl}/admin/layers`);
    const row = page.locator(`[data-layer-id="${layerId}"]`);
    await expect(row).toContainText("READY");
    await row
      .getByRole("button", { name: "Edit details", exact: true })
      .click();
    await row
      .getByLabel("Layer name", { exact: true })
      .fill("Reviewed café boundary");
    await row
      .getByLabel(/^Description/)
      .fill("Reviewed by an administrator");
    await row
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(
      page.getByText(
        "Layer details saved. The map will pick up the change when its layers refresh.",
      ),
    ).toBeVisible();
    await expect(row).toContainText("Reviewed café boundary");
    await expect(row).toContainText("Reviewed by an administrator");
    const viewerContext = await contextFor(participant);
    const viewerPage = await viewerContext.newPage();
    viewerPage.setDefaultTimeout(20000);
    viewerPage.on("pageerror", () =>
      browserErrors.push("viewer-runtime-error"),
    );
    await viewerPage.goto(`${baseUrl}/map?layer=${layerId}`);
    await viewerPage
      .locator('[data-map-ready="true"]')
      .waitFor({ timeout: 30000 });
    await openFeature(viewerPage);
    await expect(viewerPage.locator(".gis-popup")).toContainText(
      "Reviewed café boundary",
    );

    // A forged mutation still fails with a real administrator's CSRF token: role checks are server-side.
    const configuration = await (
      await context.request.get(`${baseUrl}/api/admin/layers`)
    ).json();
    for (const [user, expectedStatus, landing] of [
      [participant, 403, "/access-denied"],
      [pending, 403, "/pending"],
      [rejected, 403, "/access-denied"],
      [null, 401, "/login"],
    ]) {
      const unauthorized = await contextFor(user);
      const headers = {
        origin: baseUrl,
        "x-gis-csrf": configuration.csrfToken,
      };
      for (const url of [
        "/api/admin/layers",
        "/api/admin/uploads",
        `/api/admin/jobs/${jobId}`,
      ])
        ensure(
          (await unauthorized.request.get(`${baseUrl}${url}`)).status() ===
            expectedStatus,
          "Unprivileged account read administrator GIS data.",
        );
      ensure(
        (
          await unauthorized.request.post(`${baseUrl}/api/admin/uploads`, {
            headers,
            data: "",
          })
        ).status() === expectedStatus,
        "Unprivileged account uploaded GIS data.",
      );
      ensure(
        (
          await unauthorized.request.patch(
            `${baseUrl}/api/admin/layers/${layerId}`,
            {
              headers,
              data: {
                name: "Unauthorized edit",
                description: "",
                isVisible: true,
              },
            },
          )
        ).status() === expectedStatus,
        "Unprivileged account edited GIS data.",
      );
      ensure(
        (
          await unauthorized.request.delete(
            `${baseUrl}/api/admin/layers/${layerId}`,
            { headers },
          )
        ).status() === expectedStatus,
        "Unprivileged account deleted GIS data.",
      );
      const deniedPage = await unauthorized.newPage();
      for (const path of ["/admin/layers", "/admin/upload"]) {
        await deniedPage.goto(`${baseUrl}${path}`);
        ensure(
          new URL(deniedPage.url()).pathname === landing,
          "Unprivileged account opened GIS administration.",
        );
      }
      if (user !== participant) {
        await deniedPage.goto(`${baseUrl}/map`);
        ensure(
          new URL(deniedPage.url()).pathname === landing,
          "An unauthenticated or unapproved account opened the map.",
        );
        ensure(
          (await unauthorized.request.get(`${baseUrl}/api/layers`)).status() ===
            expectedStatus,
          "An unauthenticated or unapproved account read the GIS catalog.",
        );
      }
      await unauthorized.close();
    }

    await expect(row.getByRole("checkbox")).toBeChecked();
    await row.getByRole("checkbox").click();
    await expect(row.getByRole("checkbox")).not.toBeChecked();
    await expect
      .poll(
        async () =>
          (
            await (
              await viewerContext.request.get(`${baseUrl}/api/layers`)
            ).json()
          ).layers.length,
      )
      .toBe(0);
    ensure(
      (
        await viewerContext.request.get(`${baseUrl}/api/layers/${layerId}`)
      ).status() === 404,
      "Viewer can still read a globally hidden layer.",
    );
    ensure(
      (
        await viewerContext.request.get(
          `${baseUrl}/api/layers/${layerId}/tiles/0/0/0.pbf`,
        )
      ).status() === 404,
      "Viewer can still fetch a globally hidden tile.",
    );
    await viewerPage.reload();
    await expect(
      viewerPage.getByText("No GIS layers available.", { exact: true }),
    ).toBeVisible();
    await expect(row.getByRole("checkbox")).toBeEnabled();
    await row.getByRole("checkbox").click();
    await expect(row.getByRole("checkbox")).toBeChecked();
    await expect
      .poll(
        async () =>
          (
            await (
              await viewerContext.request.get(`${baseUrl}/api/layers`)
            ).json()
          ).layers.length,
      )
      .toBe(1);
    await page.screenshot({
      path: join(screenshots, "managed-layer.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    ensure(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "Layer management overflows the mobile viewport.",
    );
    await page.screenshot({
      path: join(screenshots, "layers-mobile.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect(
      row.getByRole("button", { name: "Delete", exact: true }),
    ).toBeEnabled();
    page.once("dialog", (dialog) => dialog.dismiss());
    await row.getByRole("button", { name: "Delete", exact: true }).click();
    ensure(
      (await owner.query("SELECT state FROM app.layers WHERE id=$1", [layerId]))
        .rows[0]?.state === "READY",
      "Cancel did not prevent deletion.",
    );
    page.once("dialog", (dialog) => dialog.accept());
    await row.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(
      page.getByText("Layer and its associated GIS data have been deleted."),
    ).toBeVisible({ timeout: 60000 });
    await expect(
      page.getByRole("heading", { name: "No GIS layers available." }),
    ).toBeVisible();
    ensure(
      (
        await owner.query(
          "SELECT count(*)::int AS count FROM app.layers WHERE id=$1",
          [layerId],
        )
      ).rows[0].count === 0,
      "Deleted layer metadata remains.",
    );
    ensure(
      (
        await owner.query("SELECT to_regclass($1) AS table_name", [
          `gis.${stored.table_name}`,
        ])
      ).rows[0].table_name === null,
      "Deleted layer geometry table remains.",
    );
    const jobs = (
      await owner.query(
        "SELECT kind,status FROM app.gis_jobs ORDER BY created_at",
      )
    ).rows;
    ensure(
      jobs.length === 2 &&
        jobs.every((job) => job.status === "SUCCEEDED") &&
        jobs.some((job) => job.kind === "DELETE_LAYER"),
      "Import/deletion did not finish through the durable worker queue.",
    );
    const audit = (
      await owner.query(
        "SELECT action,user_id FROM app.audit_logs WHERE target_id=$1 ORDER BY timestamp",
        [layerId],
      )
    ).rows;
    ensure(
      audit.length === 5 &&
        audit.every((entry) => entry.user_id === administrator.id) &&
        audit.filter((entry) => entry.action === "LAYER_UPLOADED").length === 1 &&
        audit.filter((entry) => entry.action === "LAYER_UPDATED").length === 3 &&
        audit.filter((entry) => entry.action === "LAYER_DELETED").length === 1,
      "Layer mutations were not attributed to the administrator in the audit log.",
    );
    ensure(
      (
        await owner.query(
          "SELECT count(*)::int AS count FROM pg_tables WHERE schemaname='gis_staging'",
        )
      ).rows[0].count === 0,
      "Temporary staging geometry tables remain after import/deletion.",
    );
    await viewerPage.reload();
    await expect(
      viewerPage.getByText("No GIS layers available.", { exact: true }),
    ).toBeVisible();
    await viewerPage
      .locator('[data-map-ready="true"]')
      .waitFor({ timeout: 30000 });
    ensure(
      browserErrors.length === 0,
      "Browser runtime error during vector workflow.",
    );
    await owner.query("UPDATE app.users SET role='VIEWER' WHERE id=$1", [
      administrator.id,
    ]);
    ensure(
      (await context.request.get(`${baseUrl}/api/admin/layers`)).status() === 403,
      "A demoted administrator retained access with an existing session.",
    );
    await page.goto(`${baseUrl}/admin/upload`);
    ensure(
      new URL(page.url()).pathname === "/access-denied",
      "A demoted administrator retained upload-page access.",
    );
    console.log(
      "PASS: isolated real SHP upload, queue/worker, EPSG:3857 to 4326 reprojection, PostGIS metadata, Unicode popup, admin edit, viewer rendering, visibility/tile protection, all-role API/page guards, live role revocation, mobile layout, cancel/delete confirmation, audit attribution, geometry/metadata/staging cleanup and empty map.",
    );
  } catch (error) {
    if (page)
      await page
        .screenshot({ path: join(screenshots, "failure.png"), fullPage: true })
        .catch(() => {});
    // Only fixed application job codes are printed; never connection URLs, SQL, or GDAL stderr.
    if (owner) {
      const state = await owner
        .query("SELECT status,error_code FROM app.gis_jobs ORDER BY created_at")
        .catch(() => null);
      if (state?.rows.length)
        console.error(
          `Queue state: ${state.rows.map((job) => `${job.status}/${job.error_code || "OK"}`).join(", ")}`,
        );
    }
    throw error;
  } finally {
    const shutdowns = await Promise.allSettled([
      browser?.close(),
      stop(worker),
      stop(server),
    ]);
    const ownerClosed = await Promise.allSettled([owner?.end()]);
    try {
      if (created)
        await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    } finally {
      const cleaned = await Promise.allSettled([
        admin.end(),
        privateDirectory
          ? rm(privateDirectory, { recursive: true, force: true })
          : undefined,
      ]);
      ensure(
        [...shutdowns, ...ownerClosed, ...cleaned].every(
          (result) => result.status === "fulfilled",
        ),
        "Temporary vector resource cleanup failed.",
      );
    }
    console.log(
      "Temporary vector database, private files, worker and server cleaned up.",
    );
  }
}

run().catch((error) => {
  const message =
    error instanceof Error && !("code" in error)
      ? error.message.split("\n").slice(0, 24).join("\n") ||
        "Browser assertion failed."
      : "Database or fixture setup failed. Check development PostgreSQL, GIS worker credentials, GDAL and zip.";
  console.error(`Vector browser test failed: ${message}`);
  process.exitCode = 1;
});
