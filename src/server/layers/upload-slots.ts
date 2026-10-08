import "server-only";
import { Pool, type PoolClient } from "pg";
import { GISProcessingError } from "@/server/processing/errors";

const maximumStreams = 2;
const state = globalThis as unknown as {
  portalUploadPool?: Pool;
  portalInboundUploads?: number;
};

function uploadPool() {
  if (!state.portalUploadPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString || !/^postgres(?:ql)?:\/\//.test(connectionString)) {
      throw new GISProcessingError("DATABASE_UNAVAILABLE");
    }
    // Long-lived upload locks never consume the web pool used by login/map requests.
    state.portalUploadPool = new Pool({ connectionString, max: maximumStreams, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 30_000 });
    state.portalUploadPool.on("error", () => {}); // A disconnected idle client is removed by pg.
  }
  return state.portalUploadPool;
}

export async function withUploadSlot<T>(actorId: string, receive: () => Promise<T>): Promise<T> {
  if ((state.portalInboundUploads ?? 0) >= maximumStreams) throw new GISProcessingError("QUEUE_FULL");
  state.portalInboundUploads = (state.portalInboundUploads ?? 0) + 1;
  let connection: PoolClient | undefined;
  try {
    connection = await uploadPool().connect();
    const actor = await connection.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 73429103)) AS acquired", [`gis-upload:${actorId}`],
    );
    if (!actor.rows[0].acquired) throw new GISProcessingError("QUEUE_FULL");
    let acquired = false;
    // Two database slots also bound streams across multiple web instances.
    for (let slot = 0; slot < maximumStreams; slot++) {
      const result = await connection.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(73429104, $1::integer) AS acquired", [slot],
      );
      if (result.rows[0].acquired) { acquired = true; break; }
    }
    if (!acquired) throw new GISProcessingError("QUEUE_FULL");
    return await receive();
  } finally {
    if (connection) {
      let destroy = false;
      try { await connection.query("SELECT pg_advisory_unlock_all()"); }
      catch { destroy = true; }
      // A connection whose locks cannot be released must not re-enter the pool.
      connection.release(destroy);
    }
    state.portalInboundUploads = Math.max(0, (state.portalInboundUploads ?? 1) - 1);
  }
}
