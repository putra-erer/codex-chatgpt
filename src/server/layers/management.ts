import "server-only";
import { randomUUID } from "node:crypto";
import { and, count, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { AdminLayer } from "@/lib/gis/admin";
import { layerMetadataSchema, managedLayerMarker } from "@/lib/gis/admin";
import { lockUserAdministration, type AuthTransaction } from "@/server/auth/service";
import type { Database } from "@/server/db";
import { accounts, auditLogs, gisJobs, layers, users } from "@/server/db/schema";
import { GISProcessingError, publicGisError } from "@/server/processing/errors";
import { assertUploadReady } from "@/server/storage/local";

async function actorGuard(tx: AuthTransaction, actorId: string) {
  await lockUserAdministration(tx);
  const [actor] = await tx.select({ id: users.id }).from(users).innerJoin(accounts, and(eq(accounts.userId, users.id), eq(accounts.provider, "google"), eq(accounts.providerAccountId, users.googleId)))
    .where(and(eq(users.id, actorId), eq(users.status, "APPROVED"), eq(users.role, "ADMIN"), isNotNull(users.emailVerified)));
  if (!actor) throw new GISProcessingError("FORBIDDEN");
  // One queue/name reservation lock; held only while making small DB changes.
  await tx.execute(sql`select pg_advisory_xact_lock(73429102)`);
}
function id(value: string) { if (!z.uuid().safeParse(value).success) throw new GISProcessingError("INVALID_ID"); }
function managed(row: typeof layers.$inferSelect) {
  return row.layerType === "VECTOR" && row.sourceType === "SHP" && row.tableName === `layer_${row.id.replaceAll("-", "")}` && row.storageMetadata.managedBy === managedLayerMarker;
}
async function uniqueName(tx: AuthTransaction, name: string, except?: string) {
  const [duplicate] = await tx.select({ id: layers.id }).from(layers).where(and(sql`lower(btrim(${layers.name})) = lower(${name})`, except ? sql`${layers.id} <> ${except}::uuid` : undefined)).limit(1);
  if (duplicate) throw new GISProcessingError("DUPLICATE_NAME");
}
/** Caller must pass requireAdmin before exposing uploader details. */
export async function listAdminLayers(db: Database): Promise<AdminLayer[]> {
  const rows = await db.select({ layer: layers, uploaderName: users.name, uploaderEmail: users.email }).from(layers).leftJoin(users, eq(layers.uploadedBy, users.id)).orderBy(desc(layers.createdAt), desc(layers.id));
  return rows.map(({ layer: row, uploaderName, uploaderEmail }) => ({ id: row.id, name: row.name, description: row.description, layerType: row.layerType, sourceType: row.sourceType, geometryType: row.geometryType, featureCount: row.featureCount, srid: row.srid, isVisible: row.isVisible, state: row.state, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), uploadedBy: uploaderEmail ? { name: uploaderName, email: uploaderEmail } : null, managed: managed(row) }));
}
export async function checkUploadCapacity(db: Database, actorId: string) {
  const rows = await db.select({ actorId: gisJobs.actorId, total: count() }).from(gisJobs).where(inArray(gisJobs.status, ["QUEUED", "RUNNING"])).groupBy(gisJobs.actorId);
  if (rows.reduce((n, r) => n + r.total, 0) >= 10 || rows.some((r) => r.actorId === actorId && r.total >= 2)) throw new GISProcessingError("QUEUE_FULL");
}
export async function enqueueUpload(db: Database, actorId: string, uploadId: string, input: unknown) {
  id(actorId); id(uploadId);
  const parsed = layerMetadataSchema.safeParse(input);
  if (!parsed.success) throw new GISProcessingError("INVALID_METADATA");
  return db.transaction(async (tx) => {
    await actorGuard(tx, actorId);
    await assertUploadReady(uploadId);
    await uniqueName(tx, parsed.data.name);
    const jobs = await tx.select({ actorId: gisJobs.actorId }).from(gisJobs).where(inArray(gisJobs.status, ["QUEUED", "RUNNING"]));
    if (jobs.length >= 10 || jobs.filter(j => j.actorId === actorId).length >= 2) throw new GISProcessingError("QUEUE_FULL");
    const layerId = randomUUID(), jobId = randomUUID();
    await tx.insert(layers).values({ id: layerId, ...parsed.data, uploadedBy: actorId, layerType: "VECTOR", sourceType: "SHP", tableName: `layer_${layerId.replaceAll("-", "")}`, state: "PROCESSING", storageMetadata: { managedBy: managedLayerMarker, uploadId } });
    await tx.insert(gisJobs).values({ id: jobId, actorId, layerId, kind: "IMPORT_VECTOR", payload: { uploadId } });
    return { layerId, jobId };
  });
}
export async function editLayer(db: Database, actorId: string, layerId: string, input: unknown) {
  id(actorId); id(layerId);
  const parsed = layerMetadataSchema.safeParse(input);
  if (!parsed.success) throw new GISProcessingError("INVALID_METADATA");
  await db.transaction(async (tx) => {
    await actorGuard(tx, actorId);
    const [row] = await tx.select().from(layers).where(eq(layers.id, layerId)).for("update");
    if (!row) throw new GISProcessingError("NOT_FOUND");
    if (!managed(row)) throw new GISProcessingError("NOT_MANAGED");
    if (row.state === "DELETING") throw new GISProcessingError("LAYER_BUSY");
    await uniqueName(tx, parsed.data.name, layerId);
    await tx.update(layers).set({ ...parsed.data, updatedAt: new Date() }).where(eq(layers.id, layerId));
    await tx.insert(auditLogs).values({ userId: actorId, action: "LAYER_UPDATED", targetType: "layer", targetId: layerId, metadata: { before: { name: row.name, description: row.description, isVisible: row.isVisible }, after: parsed.data } });
  });
  return (await listAdminLayers(db)).find((row) => row.id === layerId) ?? null;
}
export async function enqueueDelete(db: Database, actorId: string, layerId: string) {
  id(actorId); id(layerId);
  return db.transaction(async (tx) => {
    await actorGuard(tx, actorId);
    const [row] = await tx.select().from(layers).where(eq(layers.id, layerId)).for("update");
    if (!row) throw new GISProcessingError("NOT_FOUND");
    if (!managed(row)) throw new GISProcessingError("NOT_MANAGED");
    const [active] = await tx.select({ id: gisJobs.id, kind: gisJobs.kind }).from(gisJobs).where(and(eq(gisJobs.layerId, layerId), inArray(gisJobs.status, ["QUEUED", "RUNNING"])));
    if (active?.kind === "DELETE_LAYER") return { layerId, jobId: active.id };
    if (active) throw new GISProcessingError("LAYER_BUSY");
    const jobId = randomUUID();
    await tx.update(layers).set({ state: "DELETING", updatedAt: new Date() }).where(eq(layers.id, layerId));
    await tx.insert(gisJobs).values({ id: jobId, actorId, layerId, kind: "DELETE_LAYER", payload: { uploadId: row.storageMetadata.uploadId } });
    return { jobId, layerId };
  });
}
export async function adminJob(db: Database, jobId: string) {
  id(jobId);
  const [job] = await db.select({ id: gisJobs.id, layerId: gisJobs.layerId, kind: gisJobs.kind, status: gisJobs.status, errorCode: gisJobs.errorCode }).from(gisJobs).where(eq(gisJobs.id, jobId));
  if (!job) throw new GISProcessingError("NOT_FOUND");
  return { id: job.id, layerId: job.layerId, kind: job.kind, status: job.status, error: job.errorCode ? publicGisError(job.errorCode) : null };
}
