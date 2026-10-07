import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { randomUUID, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { cp, mkdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
const root = fileURLToPath(new URL("../", import.meta.url));
const screenshots = `${root}/test-results/gis`;
await mkdir(screenshots, { recursive: true });
const require = createRequire(`${root}/package.json`);
const { Client } = require("pg");
const { config } = require("dotenv");
const { chromium } = require("@playwright/test");
if (process.env.NODE_ENV === "production")
  throw new Error("Use a development PostgreSQL server for browser tests.");
config({ path: [`${root}/.env.local`, `${root}/.env`], quiet: true });
const name = `portal_test_${randomUUID().replaceAll("-", "")}`;
const migration = new URL(process.env.MIGRATION_DATABASE_URL);
const app = new URL(process.env.DATABASE_URL);
if (
  migration.hostname !== app.hostname ||
  migration.port !== app.port ||
  decodeURIComponent(app.username) !== "gis_app"
)
  throw new Error(
    "Use migration-owner and gis_app URLs on the same development PostgreSQL server.",
  );
const admin = new Client({ connectionString: migration.toString() });
let created = false,
  owner,
  server,
  browser;
function ensure(condition, label) {
  if (!condition) throw new Error(label);
}

try {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
  created = true;
  await admin.query(`REVOKE ALL ON DATABASE "${name}" FROM PUBLIC`);
  await admin.query(`GRANT CONNECT ON DATABASE "${name}" TO gis_app`);
  migration.pathname = app.pathname = `/${name}`;
  const env = {
    ...process.env,
    MIGRATION_DATABASE_URL: migration.toString(),
    DATABASE_URL: app.toString(),
    NODE_ENV: "test",
  };
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/migrate.ts"],
    { cwd: root, env, stdio: "ignore" },
  );
  const [code] = await once(child, "exit");
  ensure(code === 0, "isolated migration failed");
  owner = new Client({ connectionString: migration.toString() });
  await owner.connect();
  async function fixture(status, role, index) {
    const id = randomUUID(),
      token = randomBytes(32).toString("hex"),
      subject = `browser-${id}`;
    const email =
      index === 0
        ? "very.long.registration.email.for.testing.responsive.wrapping@company.example.test"
        : `test-account-${index}@company.example.test`;
    const name =
      index === 0
        ? "A Long Applicant Name for Responsive Layout Testing"
        : `Test account ${index}`;
    await owner.query(
      `INSERT INTO app.users (id,email,name,google_id,email_verified,status,role,approved_at) VALUES ($1,$2,$3,$4,now(),$5::app.user_status,$6,CASE WHEN $5::app.user_status='APPROVED' THEN now() ELSE NULL END)`,
      [id, email, name, subject, status, role],
    );
    await owner.query(
      `INSERT INTO app.accounts (user_id,type,provider,provider_account_id) VALUES ($1,'oidc','google',$2)`,
      [id, subject],
    );
    await owner.query(
      `INSERT INTO app.sessions (session_token,user_id,expires) VALUES ($1,$2,now()+interval '1 hour')`,
      [token, id],
    );
    return { id, token, email };
  }
  const participant = await fixture("APPROVED", "VIEWER", "viewer");
  await cp(`${root}/.next/static`, `${root}/.next/standalone/.next/static`, {
    recursive: true,
  });
  await cp(`${root}/public`, `${root}/.next/standalone/public`, {
    recursive: true,
  });
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [`${root}/.next/standalone/server.js`], {
    cwd: root,
    env: {
      ...env,
      NODE_ENV: "production",
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
      AUTH_URL: baseUrl,
      AUTH_SECRET: randomBytes(32).toString("hex"),
      GOOGLE_CLIENT_ID: "browser-client",
      GOOGLE_CLIENT_SECRET: "browser-secret",
      SUPER_ADMIN_EMAILS: "",
    },
    stdio: "ignore",
  });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      ready = (await fetch(`${baseUrl}/login`)).status === 200;
    } catch {}
    if (ready) break;
    await delay(100);
  }
  ensure(ready, "server did not start");
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
  const adminContext = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  await adminContext.addCookies([
    {
      name: "authjs.session-token",
      value: participant.token,
      url: baseUrl,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const page = await adminContext.newPage();
  const browserErrors = [];
  page.on("pageerror", () => browserErrors.push("page-error"));
  await page.goto(`${baseUrl}/map`);
  await page.locator('[data-map-ready="true"]').waitFor({ timeout: 30000 });
  await page.getByText("3 visible layers", { exact: false }).waitFor();
  await delay(1800);
  ensure(
    (await page.locator('input[type="checkbox"]').count()) === 3,
    "missing sample layers",
  );
  ensure(
    (await page.locator('a[href="/admin"]').count()) === 0,
    "viewer saw admin link",
  );
  const mapBox = await page.locator(".maplibregl-canvas").boundingBox();
  ensure(
    mapBox && mapBox.width > 200 && mapBox.height > 200,
    "map has no usable dimensions",
  );
  function screen(lon, lat) {
    const mx = (v) => (v + 180) / 360;
    const my = (v) =>
      (1 - Math.asinh(Math.tan((v * Math.PI) / 180)) / Math.PI) / 2;
    const west = mx(106.809),
      east = mx(106.854),
      north = my(-6.16),
      south = my(-6.22);
    const scale = Math.min(
      (mapBox.width - 110) / (east - west),
      (mapBox.height - 110) / (south - north),
    );
    return {
      x: mapBox.x + mapBox.width / 2 + (mx(lon) - (west + east) / 2) * scale,
      y: mapBox.y + mapBox.height / 2 + (my(lat) - (north + south) / 2) * scale,
    };
  }
  const facility = screen(106.827, -6.18);
  await page.mouse.click(facility.x, facility.y);
  await page.locator(".gis-popup").waitFor({ timeout: 10000 });
  ensure(
    (await page.locator(".gis-popup").textContent()).includes(
      "Operations office",
    ),
    "popup attributes missing",
  );
  await page.locator(".maplibregl-popup-close-button").click();
  const facilities = page.getByRole("checkbox", { name: /Demo · Facilities/ });
  await facilities.uncheck();
  ensure(
    (await page.locator(".gis-legend").textContent()).includes("Facilities") ===
      false,
    "hidden layer remains in legend",
  );
  await facilities.check();
  let externalTiles = 0;
  await page.route("https://tile.openstreetmap.org/**", async (route) => {
    externalTiles++;
    await route.fulfill({
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
        "base64",
      ),
    });
  });
  await page.getByRole("radio", { name: /OpenStreetMap/ }).check();
  await page
    .locator(
      '.maplibregl-ctrl-attrib a[href="https://www.openstreetmap.org/copyright"]',
    )
    .waitFor({ state: "attached" });
  await delay(500);
  ensure(externalTiles > 0, "external basemap did not request tiles");
  await page.getByRole("radio", { name: /Dark canvas/ }).check();
  await page.getByRole("radio", { name: /Light canvas/ }).check();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await delay(400);
  await page.getByRole("button", { name: "Zoom out", exact: true }).click();
  await delay(400);
  await page
    .getByRole("button", { name: "Enter fullscreen", exact: true })
    .click();
  await page.waitForFunction(() => document.fullscreenElement !== null);
  await page
    .getByRole("button", { name: "Exit fullscreen", exact: true })
    .click();
  await page.waitForFunction(() => document.fullscreenElement === null);
  await delay(500);
  await page.mouse.move(facility.x, facility.y);
  ensure(
    (await page.locator(".gis-coordinate-bar").textContent()).includes("Lng"),
    "coordinates missing",
  );
  await page.getByRole("button", { name: "Line", exact: true }).click();
  await page.mouse.click(
    mapBox.x + mapBox.width * 0.35,
    mapBox.y + mapBox.height * 0.4,
  );
  await page.mouse.click(
    mapBox.x + mapBox.width * 0.65,
    mapBox.y + mapBox.height * 0.55,
  );
  ensure(
    (await page.locator(".gis-measure-point").count()) === 2,
    "line points missing",
  );
  const meters = Number(
    (await page.locator(".gis-measure-result").textContent()).split(" ")[0],
  );
  ensure(meters > 0, "distance is zero");
  await page.getByLabel("Measurement unit", { exact: true }).selectOption("km");
  const kilometers = Number(
    (await page.locator(".gis-measure-result").textContent()).split(" ")[0],
  );
  ensure(
    Math.abs(kilometers - meters / 1000) < 0.01,
    "unit conversion incorrect",
  );
  await page.getByRole("button", { name: "Finish", exact: true }).click();
  const point = await page.locator(".gis-measure-point").first().boundingBox();
  await page.mouse.move(point.x + point.width / 2, point.y + point.height / 2);
  await page.mouse.down();
  await page.mouse.move(point.x + 70, point.y + 50, { steps: 8 });
  await page.mouse.up();
  ensure(
    Number(
      (await page.locator(".gis-measure-result").textContent()).split(" ")[0],
    ) !== kilometers,
    "drag did not update measurement",
  );
  await page.getByRole("button", { name: "Area", exact: true }).click();
  for (const [x, y] of [
    [0.35, 0.35],
    [0.65, 0.35],
    [0.65, 0.65],
    [0.35, 0.65],
  ])
    await page.mouse.click(
      mapBox.x + mapBox.width * x,
      mapBox.y + mapBox.height * y,
    );
  ensure(
    (await page.locator(".gis-measure-point").count()) === 4,
    "polygon points missing",
  );
  ensure(
    /^\d+\.\d{2} ha$/.test(
      await page.locator(".gis-measure-result").textContent(),
    ),
    "area formatting incorrect",
  );
  await page.getByLabel("Measurement unit", { exact: true }).selectOption("m²");
  ensure(
    Number(
      (await page.locator(".gis-measure-result").textContent()).split(" ")[0],
    ) > 0,
    "area is zero",
  );
  await page.getByRole("button", { name: "Undo point", exact: true }).click();
  ensure(
    (await page.locator(".gis-measure-point").count()) === 3,
    "undo failed",
  );
  await page.screenshot({ path: `${screenshots}/desktop.png`, fullPage: true });
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  ensure(
    (await page.locator(".gis-measure-point").count()) === 0,
    "clear failed",
  );
  await page.getByRole("button", { name: "Explore", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Hide panels", exact: true }).click();
  await delay(500);
  ensure(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "mobile overflow",
  );
  await page.screenshot({ path: `${screenshots}/mobile.png`, fullPage: true });
  ensure(browserErrors.length === 0, "browser runtime error");
  ensure(
    (await page.locator(".gis-map-notice").count()) === 0,
    "map reported a loading error",
  );
  await owner.query(
    "UPDATE app.users SET status='REJECTED',approved_at=NULL WHERE id=$1",
    [participant.id],
  );
  await page.reload();
  ensure(
    new URL(page.url()).pathname === "/access-denied",
    "revoked viewer can access map",
  );
  console.log(
    "PASS: fullscreen/zoom, mocked OSM tile loading + attribution, real WebGL map and MVT, popup attributes, layer/legend toggles, basemap switching, pointer coordinates, line length/unit conversion, draggable vertices, polygon area/two decimals/undo/clear, mobile layout, revoked access.",
  );
} catch (error) {
  const failedPage = browser?.contexts()[0]?.pages()[0];
  if (failedPage)
    await failedPage
      .screenshot({ path: `${screenshots}/failure.png`, fullPage: true })
      .catch(() => {});
  console.error(
    `GIS browser test failed: ${error instanceof Error ? error.message.split("\n")[0] : "unknown error"}`,
  );
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (server && server.exitCode === null) {
    const exited = once(server, "exit");
    server.kill("SIGTERM");
    const timeout = setTimeout(() => server.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(timeout);
  }
  await owner?.end();
  if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  await admin.end();
  console.log("Temporary database/server cleaned up.");
}
