import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getPool } from "@/server/db";
import { getVectorTile, vectorTileLimits } from "@/services/layers/catalog";
import { withUploadSlot } from "@/server/layers/upload-slots";

const layerId = randomUUID();
const table = `layer_${layerId.replaceAll("-", "")}`;
const viewer = { status: "APPROVED", role: "VIEWER" } as const;
let owner: Pool;

beforeAll(async () => {
  const database = process.env.PORTAL_INTEGRATION_DATABASE;
  if (!database || !/^portal_test_[a-f0-9]{32}$/.test(database)) throw new Error("Use npm run test:integration.");
  owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
  expect((await owner.query("SELECT current_database() AS name")).rows[0].name).toBe(database);
  await owner.query(`CREATE TABLE gis.${table}(feature_id integer PRIMARY KEY, properties jsonb NOT NULL, geom geometry(Point,4326) NOT NULL)`);
  await owner.query(`GRANT SELECT ON gis.${table} TO gis_app`);
  await owner.query(`INSERT INTO app.layers(id,name,layer_type,source_type,table_name,srid,state,geometry_type,feature_count,bbox)
    VALUES($1,'Temporary delivery test','VECTOR','POSTGIS',$2,4326,'READY','Point',0,ST_MakeEnvelope(-1,-1,1,1,4326))`, [layerId, table]);
});

beforeEach(async () => { await owner.query(`TRUNCATE gis.${table}`); });

afterAll(async () => {
  if (owner) {
    await owner.query("DELETE FROM app.layers WHERE id=$1", [layerId]);
    await owner.query(`DROP TABLE IF EXISTS gis.${table}`);
    await owner.end();
  }
  await getPool().end();
  const state = globalThis as unknown as { portalPool?: Pool; portalUploadPool?: Pool };
  delete state.portalPool;
  if (state.portalUploadPool) await state.portalUploadPool.end();
  delete state.portalUploadPool;
});

describe("bounded vector delivery and inbound streams", () => {
  it("serves a complete small tile but refuses dense tiles instead of truncating features", async () => {
    await owner.query(`INSERT INTO gis.${table} SELECT n,jsonb_build_object('name','Point '||n),ST_SetSRID(ST_MakePoint(0,0),4326) FROM generate_series(1,3) n`);
    expect((await getVectorTile(viewer, layerId, 0, 0, 0))?.length).toBeGreaterThan(0);
    await owner.query(`INSERT INTO gis.${table} SELECT n,'{}',ST_SetSRID(ST_MakePoint(0,0),4326) FROM generate_series(4,$1) n`, [vectorTileLimits.candidates + 1]);
    await expect(getVectorTile(viewer, layerId, 0, 0, 0)).rejects.toMatchObject({ code: "TILE_TOO_DENSE" });
  });

  it("refuses an oversized attribute tile without returning a partial payload", async () => {
    await owner.query(`INSERT INTO gis.${table} VALUES(1,jsonb_build_object('text',repeat('x',$1)),ST_SetSRID(ST_MakePoint(0,0),4326))`, [vectorTileLimits.bytes + 1]);
    await expect(getVectorTile(viewer, layerId, 0, 0, 0)).rejects.toMatchObject({ code: "TILE_TOO_LARGE" });
  });

  it("times out blocked SQL and clears its transaction-local timeout before reuse", async () => {
    await owner.query(`INSERT INTO gis.${table} VALUES(1,'{}',ST_SetSRID(ST_MakePoint(0,0),4326))`);
    const blocker = await owner.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(`LOCK TABLE gis.${table} IN ACCESS EXCLUSIVE MODE`);
      await expect(getVectorTile(viewer, layerId, 0, 0, 0)).rejects.toMatchObject({ code: "TILE_TIMEOUT" });
    } finally { await blocker.query("ROLLBACK"); blocker.release(); }
    expect((await getVectorTile(viewer, layerId, 0, 0, 0))?.length).toBeGreaterThan(0);
    expect((await getPool().query("SHOW statement_timeout")).rows[0].statement_timeout).toBe("0");
  });

  it("limits streams globally and per administrator while leaving the web pool usable", async () => {
    const admin = randomUUID();
    await withUploadSlot(admin, async () => {
      await expect(withUploadSlot(admin, async () => {})).rejects.toMatchObject({ code: "QUEUE_FULL" });
      await withUploadSlot(randomUUID(), async () => {
        await expect(withUploadSlot(randomUUID(), async () => {})).rejects.toMatchObject({ code: "QUEUE_FULL" });
        expect((await getPool().query("SELECT 1 AS ready")).rows[0].ready).toBe(1);
      });
    });
    // Slots and actor lock were released, including the rejected nested attempt.
    await expect(withUploadSlot(admin, async () => "ready")).resolves.toBe("ready");
    // A slot held by another web instance also counts against the global cap.
    const external = await owner.connect();
    try {
      await external.query("SELECT pg_advisory_lock(73429104, 0), pg_advisory_lock(73429104, 1)");
      await expect(withUploadSlot(admin, async () => {})).rejects.toMatchObject({ code: "QUEUE_FULL" });
    } finally { await external.query("SELECT pg_advisory_unlock_all()"); external.release(); }
  });
});
