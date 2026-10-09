// Reuses the Phase 4 isolated database/server/worker/browser harness; never seeds the app.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { createShapefileFixture } from "../tests/helpers/shapefile-fixture.ts";

const require = createRequire(import.meta.url);
const { expect } = require("@playwright/test");
// Reuse the PNG decoder bundled by the pinned Playwright dependency, without another framework.
const { PNG } = require(join(dirname(require.resolve("playwright-core/package.json")), "lib/utilsBundle.js"));

function ensure(value, message) { if (!value) throw new Error(message); }
async function setColor(page, label, color) {
  await page.getByLabel(label, { exact: true }).evaluate((input, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, color);
}
async function pixels(page) {
  return PNG.sync.read(await page.locator(".maplibregl-canvas").screenshot());
}
function countColor(png, hex, tolerance = 5) {
  const rgb = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
  let count = 0;
  for (let offset = 0; offset < png.data.length; offset += 4)
    if (rgb.every((channel, index) => Math.abs(png.data[offset + index] - channel) <= tolerance)) count++;
  return count;
}
async function hasColor(page, hex, minimum = 100) {
  await expect.poll(async () => countColor(await pixels(page), hex), { timeout: 30000 }).toBeGreaterThan(minimum);
}
async function noColor(page, hex) {
  await expect.poll(async () => countColor(await pixels(page), hex), { timeout: 15000 }).toBe(0);
}
async function centerColor(page, hex) {
  const rgb = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
  await expect.poll(async () => {
    const png = await pixels(page);
    const offset = (Math.floor(png.height / 2) * png.width + Math.floor(png.width / 2)) * 4;
    return rgb.every((channel, index) => Math.abs(png.data[offset + index] - channel) <= 6);
  }, { timeout: 30000 }).toBe(true);
}

export async function verifyVectorStyling({ page, context, contextFor, owner, baseUrl, layerId,
  privateDirectory, administrator, participant, pending, rejected }) {
  const screenshotDirectory = join(process.cwd(), "test-results/styling");
  await mkdir(screenshotDirectory, { recursive: true });
  const runtimeErrors = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  const layerIds = [layerId];
  const originalGeometry = (await owner.query(`SELECT md5(string_agg(ST_AsEWKB(geom)::text || properties::text,',' ORDER BY feature_id)) AS hash FROM gis."layer_${layerId.replaceAll("-", "")}"`)).rows[0].hash;
  async function csrf() { return (await (await context.request.get(`${baseUrl}/api/admin/layers`)).json()).csrfToken; }
  async function mutate(path, method, data) {
    const response = await context.request.fetch(`${baseUrl}${path}`, { method, data,
      headers: { origin: baseUrl, "x-gis-csrf": await csrf() } });
    ensure(response.ok(), `Styling mutation failed: ${method} ${path} (${response.status()}).`);
    return response.json();
  }
  async function style(id) {
    const response = await context.request.get(`${baseUrl}/api/admin/layers/${id}/style`);
    ensure(response.ok(), "Saved style could not be read.");
    return (await response.json()).layer.style;
  }
  async function editor(id) {
    await page.goto(`${baseUrl}/admin/layers/${id}/style`);
    await expect(page.getByRole("combobox", { name: /^Style type/ })).toBeVisible();
    await page.locator('[data-map-ready="true"]').waitFor({ timeout: 30000 });
  }
  async function save() {
    await page.getByRole("button", { name: "Save Changes", exact: true }).click();
    await expect(page.getByText("Layer style saved. This appearance is now shared with your team.")).toBeVisible();
    // Next.js also installs an out-of-main route announcer with role=alert.
    await expect(page.locator('main [role="alert"]')).toHaveCount(0);
  }
  async function upload(geometry, name) {
    const archive = await createShapefileFixture(privateDirectory, { geometry });
    await page.goto(`${baseUrl}/admin/upload`);
    await page.getByLabel("Layer name", { exact: true }).fill(name);
    await page.getByLabel("Shapefile ZIP", { exact: true }).setInputFiles(archive);
    const accepted = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/admin/uploads" && response.request().method() === "POST");
    await page.getByRole("button", { name: "Upload shapefile", exact: true }).click();
    const response = await accepted;
    ensure(response.status() === 202, "Additional test Shapefile upload was rejected.");
    const { layerId: id } = await response.json();
    layerIds.push(id);
    await expect(page.getByText("Your layer is ready. You can view it on the map or manage its details.")).toBeVisible({ timeout: 90000 });
    return id;
  }
  async function remove(id) {
    const result = await mutate(`/api/admin/layers/${id}`, "DELETE");
    await expect.poll(async () => (await (await context.request.get(`${baseUrl}/api/admin/jobs/${result.jobId}`)).json()).status,
      { timeout: 60000 }).toBe("SUCCEEDED");
  }

  await editor(layerId);
  const before = await style(layerId);
  const canvas = await page.locator(".maplibregl-canvas").elementHandle();
  await setColor(page, "Fill color", "#DF1122");
  await page.getByLabel("Fill opacity", { exact: true }).fill("1");
  await setColor(page, "Outline color", "#123456");
  await page.getByLabel("Outline width", { exact: true }).fill("5");
  await hasColor(page, "#DF1122", 1000);
  await hasColor(page, "#123456", 50);
  ensure(JSON.stringify(await style(layerId)) === JSON.stringify(before), "Live preview saved to the database without Save.");
  let tileRequests = 0;
  const tileListener = (request) => { if (request.url().includes(`/api/layers/${layerId}/tiles/`)) tileRequests++; };
  page.on("request", tileListener);
  await setColor(page, "Fill color", "#D02435");
  await hasColor(page, "#D02435", 1000);
  ensure(await canvas.evaluate((element) => element.isConnected), "Changing style recreated the map canvas.");
  ensure(tileRequests === 0, "Changing only color fetched geometry again.");
  page.off("request", tileListener);
  await save();
  const polygonSaved = await style(layerId);
  ensure(polygonSaved.color === "#D02435" && polygonSaved.strokeWidth === 5, "Polygon style did not persist.");
  await page.reload();
  await expect(page.getByLabel("Fill color", { exact: true })).toHaveValue("#d02435");
  await hasColor(page, "#D02435", 1000);
  await page.getByLabel("Fill opacity", { exact: true }).fill("0.4");
  await noColor(page, "#D02435");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await hasColor(page, "#D02435", 1000);
  await page.getByRole("button", { name: "Reset to Default", exact: true }).click();
  ensure(JSON.stringify(await style(layerId)) === JSON.stringify(polygonSaved), "Reset immediately mutated persisted style.");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("combobox", { name: /^Style type/ }).selectOption("categorized");
  await page.getByRole("combobox", { name: /^Category field/ }).selectOption("category");
  await expect(page.getByLabel("Category color: Runtime fixture", { exact: true })).toBeVisible();
  await setColor(page, "Category color: Runtime fixture", "#226644");
  await setColor(page, "Other values color", "#DDAA22");
  await hasColor(page, "#226644", 1000);
  await save();
  ensure((await style(layerId)).category.field === "category", "Categorized field was not persisted.");
  await expect(page.getByLabel("Preview legend")).toContainText("Runtime fixture");
  await page.getByLabel("Enable labels", { exact: true }).check();
  await page.getByRole("combobox", { name: /^Label field/ }).selectOption("category");
  await page.getByLabel("Font size", { exact: true }).fill("32");
  await page.getByLabel("Label minimum zoom", { exact: true }).fill("0");
  await setColor(page, "Font color", "#FF00FF");
  await setColor(page, "Halo color", "#FFFFFF");
  await page.getByLabel("Halo width", { exact: true }).fill("2");
  await hasColor(page, "#FF00FF", 20);
  await save();
  await page.reload();
  await hasColor(page, "#FF00FF", 20);
  await page.getByLabel("Label minimum zoom", { exact: true }).fill("20");
  await noColor(page, "#FF00FF");
  await page.getByLabel("Label minimum zoom", { exact: true }).fill("0");
  await hasColor(page, "#FF00FF", 20);
  await page.getByLabel("Enable labels", { exact: true }).uncheck();
  await noColor(page, "#FF00FF");
  await page.getByLabel("Minimum zoom", { exact: true }).fill("20");
  await noColor(page, "#226644");
  await page.getByLabel("Minimum zoom", { exact: true }).fill("0");
  await hasColor(page, "#226644", 1000);
  await save();
  await page.screenshot({ path: join(screenshotDirectory, "polygon-editor.png"), fullPage: true });
  console.log("PASS: polygon/outline/opacity, live pixels without geometry refetch, save/refresh/cancel/reset, categories, local glyph labels and zoom controls.");

  const lineId = await upload("line", "Styling line fixture");
  await editor(lineId);
  await setColor(page, "Line color", "#883311");
  await page.getByLabel("Line width", { exact: true }).fill("8");
  await page.getByLabel("Line opacity", { exact: true }).fill("1");
  await page.getByRole("combobox", { name: /^Line style/ }).selectOption("dashed");
  await hasColor(page, "#883311", 100);
  await save();
  await page.reload();
  await expect(page.getByRole("combobox", { name: /^Line style/ })).toHaveValue("dashed");
  await hasColor(page, "#883311", 100);
  const pointId = await upload("point", "Styling point fixture");
  await editor(pointId);
  await setColor(page, "Circle color", "#1144DD");
  await page.getByLabel("Circle radius", { exact: true }).fill("18");
  await page.getByLabel("Circle opacity", { exact: true }).fill("1");
  await setColor(page, "Stroke color", "#DD9922");
  await page.getByLabel("Stroke width", { exact: true }).fill("5");
  await hasColor(page, "#1144DD", 200);
  await hasColor(page, "#DD9922", 50);
  await save();
  await page.reload();
  await expect(page.getByLabel("Circle radius", { exact: true })).toHaveValue("18");
  await hasColor(page, "#1144DD", 200);
  await page.setViewportSize({ width: 390, height: 844 });
  ensure(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Style editor overflows mobile viewport.");
  await page.screenshot({ path: join(screenshotDirectory, "editor-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await remove(lineId);
  await remove(pointId);
  console.log("PASS: real uploaded line/point style editors, dashed line, circle/stroke pixels, persistence, mobile layout and existing worker deletion.");

  // Another uploaded polygon covers the same footprint to prove actual draw order.
  const upperId = await upload("polygon", "Order overlay fixture");
  await editor(upperId);
  await setColor(page, "Fill color", "#DD7722");
  await page.getByLabel("Fill opacity", { exact: true }).fill("1");
  await save();
  await page.goto(`${baseUrl}/admin/layers#layer-${layerId}`);
  const row = page.locator(`[data-layer-id="${layerId}"]`);
  await expect(row.getByLabel("Layer name", { exact: true })).toBeVisible();
  await row.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Refresh layers", exact: true }).click();
  await expect(row.getByLabel("Layer name", { exact: true })).toHaveCount(0);
  await row.getByRole("button", { name: "Change group", exact: true }).click();
  await row.getByLabel("Layer group", { exact: true }).fill("Field operations");
  await row.getByRole("button", { name: "Save group", exact: true }).click();
  await expect.poll(async () => (await owner.query("SELECT group_name FROM app.layers WHERE id=$1", [layerId])).rows[0].group_name).toBe("Field operations");
  await page.getByRole("combobox", { name: /^Rename group/ }).selectOption("Field operations");
  await page.getByLabel("New group name", { exact: true }).fill("Boundaries");
  await page.getByRole("button", { name: "Rename group", exact: true }).click();
  await expect.poll(async () => (await owner.query("SELECT group_name FROM app.layers WHERE id=$1", [layerId])).rows[0].group_name).toBe("Boundaries");
  const viewerContext = await contextFor(participant);
  const viewerPage = await viewerContext.newPage();
  viewerPage.on("pageerror", (error) => runtimeErrors.push(error.message));
  await viewerPage.goto(`${baseUrl}/map?layer=${layerId}`);
  await viewerPage.locator('[data-map-ready="true"]').waitFor({ timeout: 30000 });
  await centerColor(viewerPage, "#226644");
  await page.locator(`[data-layer-id="${upperId}"]`).getByRole("button", { name: /^Move up:/ }).click();
  await expect.poll(async () => (await (await viewerContext.request.get(`${baseUrl}/api/layers`)).json()).layers[0].id).toBe(upperId);
  await viewerPage.getByRole("button", { name: "Refresh layers", exact: true }).click();
  await centerColor(viewerPage, "#DD7722");
  await viewerPage.reload();
  await centerColor(viewerPage, "#DD7722");
  await page.locator(`[data-layer-id="${upperId}"]`).getByRole("button", { name: /^Move down:/ }).click();
  await expect.poll(async () => (await (await viewerContext.request.get(`${baseUrl}/api/layers`)).json()).layers[0].id).toBe(layerId);
  await viewerPage.getByRole("button", { name: "Refresh layers", exact: true }).click();
  await centerColor(viewerPage, "#226644");
  await expect(viewerPage.getByRole("link", { name: /Edit style/i })).toHaveCount(0);
  await expect(viewerPage.getByRole("region", { name: "Legend", exact: true })).toContainText("Runtime fixture");

  // Default visibility is independent from publication, local overrides and other sessions.
  const defaultBox = row.getByRole("checkbox", { name: /^Visible by default:/ });
  // This checkbox reflects the server result, so wait for the saved state.
  await expect(defaultBox).toBeChecked();
  await defaultBox.click();
  await expect(defaultBox).not.toBeChecked();
  await expect.poll(async () => (await owner.query("SELECT default_visible FROM app.layers WHERE id=$1", [layerId])).rows[0].default_visible).toBe(false);
  const cleanViewer = await contextFor(participant);
  const cleanPage = await cleanViewer.newPage();
  await cleanPage.goto(`${baseUrl}/map`);
  const layerBox = cleanPage.getByRole("checkbox", { name: /Uploaded browser polygon/ });
  await expect(layerBox).not.toBeChecked();
  await layerBox.check();
  await cleanPage.reload();
  await expect(cleanPage.getByRole("checkbox", { name: /Uploaded browser polygon/ })).toBeChecked();
  const defaults = (await owner.query("SELECT default_visible,is_visible FROM app.layers WHERE id=$1", [layerId])).rows[0];
  ensure(defaults.default_visible === false && defaults.is_visible === true, "Viewer toggle changed global defaults/access.");
  await cleanPage.getByLabel("Search layers", { exact: true }).fill("missing-layer-name");
  await expect(cleanPage.getByRole("checkbox", { name: /Uploaded browser polygon/ })).toHaveCount(0);
  await cleanPage.getByLabel("Search layers", { exact: true }).fill("Uploaded");
  await expect(cleanPage.getByRole("checkbox", { name: /Uploaded browser polygon/ })).toBeVisible();
  await cleanPage.getByRole("button", { name: "Zoom to Uploaded browser polygon", exact: true }).click();
  await centerColor(cleanPage, "#226644");
  await cleanPage.screenshot({ path: join(screenshotDirectory, "viewer-categorized.png"), fullPage: true });
  await cleanViewer.close();
  await viewerContext.close();

  const authHeaders = { origin: baseUrl, "x-gis-csrf": await csrf() };
  for (const [user, status, landing] of [[participant, 403, "/access-denied"], [pending, 403, "/pending"], [rejected, 403, "/access-denied"], [null, 401, "/login"]]) {
    const denied = await contextFor(user);
    for (const suffix of ["style", "attributes"])
      ensure((await denied.request.get(`${baseUrl}/api/admin/layers/${layerId}/${suffix}`)).status() === status, "Unprivileged user accessed styling data.");
    for (const [path, method, data] of [
      [`/api/admin/layers/${layerId}/style`, "PUT", { style: await style(layerId) }],
      [`/api/admin/layers/${layerId}/settings`, "PATCH", { groupName: null, defaultVisible: true }],
      ["/api/admin/layers/order", "POST", { layerId, direction: "up" }],
      ["/api/admin/layers/groups", "PATCH", { from: "Boundaries", to: "Unauthorized" }],
    ]) ensure((await denied.request.fetch(`${baseUrl}${path}`, { method, data, headers: authHeaders })).status() === status, "Unprivileged user saved global layer settings.");
    const deniedPage = await denied.newPage();
    await deniedPage.goto(`${baseUrl}/admin/layers/${layerId}/style`);
    ensure(new URL(deniedPage.url()).pathname === landing, "Unprivileged user opened style editor.");
    await denied.close();
  }
  ensure((await context.request.put(`${baseUrl}/api/admin/layers/${layerId}/style`, { data: { style: await style(layerId) } })).status() === 403, "Style write without CSRF succeeded.");
  const afterGeometry = (await owner.query(`SELECT md5(string_agg(ST_AsEWKB(geom)::text || properties::text,',' ORDER BY feature_id)) AS hash FROM gis."layer_${layerId.replaceAll("-", "")}"`)).rows[0].hash;
  ensure(afterGeometry === originalGeometry, "Styling changed the imported geometry or attributes.");
  ensure(runtimeErrors.length === 0, "Browser runtime error during Phase 6 styling.");
  await remove(upperId);
  await remove(layerId);
  ensure((await owner.query("SELECT count(*)::int AS count FROM app.layers")).rows[0].count === 0, "Styling fixture layers were not deleted.");
  await owner.query("UPDATE app.users SET role='VIEWER' WHERE id=$1", [administrator.id]);
  ensure((await context.request.get(`${baseUrl}/api/admin/layers/${layerId}/style`)).status() === 403, "Demoted admin retained styling permissions.");
  console.log("PASS: actual sublayer draw order, groups/rename, defaults vs local visibility after refresh, search/fit, all-role API/page guards, CSRF, live role revocation and unchanged geometry.");
}
