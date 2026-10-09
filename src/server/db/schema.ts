import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  bigint,
  boolean,
  customType,
  varchar,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { AdapterAccountType } from "next-auth/adapters";

export const appSchema = pgSchema("app");
export const userStatus = appSchema.enum("user_status", ["PENDING", "APPROVED", "REJECTED"]);
export const userRole = appSchema.enum("user_role", ["VIEWER", "ADMIN"]);

export const users = appSchema.table("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name"),
  email: text("email").notNull().unique(),
  image: text("image"),
  googleId: text("google_id").unique(),
  emailVerified: timestamp("email_verified", { mode: "date", withTimezone: true }),
  status: userStatus("status").notNull().default("PENDING"),
  role: userRole("role").notNull().default("VIEWER"),
  approvedBy: uuid("approved_by").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
  approvedAt: timestamp("approved_at", { mode: "date", withTimezone: true }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("users_email_normalized", sql`${table.email} = lower(btrim(${table.email})) AND length(${table.email}) > 0`),
  check("users_approval_identity", sql`(
    ${table.status} = 'APPROVED' AND ${table.approvedAt} IS NOT NULL
      AND ${table.googleId} IS NOT NULL AND ${table.emailVerified} IS NOT NULL
  ) OR (
    ${table.status} <> 'APPROVED' AND ${table.approvedAt} IS NULL AND ${table.approvedBy} IS NULL
  )`),
  index("users_status_created_idx").on(table.status, table.createdAt),
]);

// Auth.js expects these token columns; the adapter intentionally never stores tokens.
export const accounts = appSchema.table("accounts", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  type: text("type").$type<AdapterAccountType>().notNull(),
  provider: text("provider").notNull(),
  providerAccountId: text("provider_account_id").notNull(),
  refresh_token: text("refresh_token"),
  access_token: text("access_token"),
  expires_at: integer("expires_at"),
  token_type: text("token_type"),
  scope: text("scope"),
  id_token: text("id_token"),
  session_state: text("session_state"),
}, (table) => [
  primaryKey({ columns: [table.provider, table.providerAccountId] }),
  unique("accounts_user_provider_unique").on(table.userId, table.provider),
  check("accounts_google_only", sql`${table.provider} = 'google'`),
  check("accounts_oauth_type", sql`${table.type} IN ('oauth', 'oidc')`),
]);

export const sessions = appSchema.table("sessions", {
  sessionToken: text("session_token").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { mode: "date", withTimezone: true }).notNull(),
}, (table) => [
  index("sessions_user_idx").on(table.userId),
  index("sessions_expires_idx").on(table.expires),
]);

// One browser tab can leave without marking another tab in the same session offline.
export const userPresence = appSchema.table("user_presence", {
  sessionToken: text("session_token").notNull().references(() => sessions.sessionToken, { onDelete: "cascade" }),
  tabId: uuid("tab_id").notNull(),
  lastSeen: timestamp("last_seen", { mode: "date", withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.sessionToken, table.tabId] }),
  index("user_presence_session_seen_idx").on(table.sessionToken, table.lastSeen),
]);

export const auditLogs = appSchema.table("audit_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  action: text("action").notNull().$type<"LOGIN" | "USER_APPROVED" | "USER_REJECTED" | "ROLE_CHANGED" | "LAYER_UPLOADED" | "LAYER_UPDATED" | "LAYER_DELETED">(),
  targetType: text("target_type").notNull().default("user"),
  targetId: text("target_id"),
  timestamp: timestamp("timestamp", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  requestId: uuid("request_id"),
}, (table) => [
  check("audit_logs_metadata_object", sql`jsonb_typeof(${table.metadata}) = 'object'`),
  index("audit_logs_time_idx").on(table.timestamp, table.id),
  index("audit_logs_actor_idx").on(table.userId, table.timestamp),
]);

export type AppUser = typeof users.$inferSelect;
export type UserStatus = AppUser["status"];
export type UserRole = AppUser["role"];


export const layerType = appSchema.enum("layer_type", ["VECTOR", "RASTER"]);
export const sourceType = appSchema.enum("source_type", ["SHP", "GEOJSON", "GEOTIFF", "POSTGIS"]);
export const layerState = appSchema.enum("layer_state", ["PROCESSING", "READY", "FAILED", "DELETING"]);
const footprint = customType<{ data: string }>({ dataType: () => "geometry(Geometry,4326)" });
export const layers = appSchema.table("layers", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 200 }).notNull(),
  description: text("description").notNull().default(""),
  layerType: layerType("layer_type").notNull(),
  sourceType: sourceType("source_type").notNull(),
  tableName: text("table_name").unique(),
  filePath: text("file_path"),
  srid: integer("srid"),
  sourceSrid: integer("source_srid"),
  sourceCrsWkt: text("source_crs_wkt"),
  styleJson: jsonb("style_json").$type<Record<string, unknown>>().notNull().default({}),
  isVisible: boolean("is_visible").notNull().default(true),
  defaultVisible: boolean("default_visible").notNull().default(true),
  groupName: varchar("group_name", { length: 100 }),
  sortOrder: integer("sort_order").notNull().default(2147483647),
  // Nullable for system-managed layers; future upload flows must record their actor.
  uploadedBy: uuid("uploaded_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  state: layerState("state").notNull().default("PROCESSING"),
  geometryType: text("geometry_type"),
  featureCount: bigint("feature_count", { mode: "number" }),
  bbox: footprint("bbox"),
  storageMetadata: jsonb("storage_metadata").$type<Record<string, unknown>>().notNull().default({}),
}, (table) => [
  check("layers_name_nonempty", sql`length(btrim(${table.name})) > 0`),
  check("layers_srid_positive", sql`${table.srid} IS NULL OR ${table.srid} > 0`),
  check("layers_source_srid_positive", sql`${table.sourceSrid} IS NULL OR ${table.sourceSrid} > 0`),
  check("layers_count_positive", sql`${table.featureCount} IS NULL OR ${table.featureCount} >= 0`),
  check("layers_style_object", sql`jsonb_typeof(${table.styleJson}) = 'object'`),
  check("layers_sort_order_nonnegative", sql`${table.sortOrder} >= 0`),
  check("layers_group_name_valid", sql`${table.groupName} IS NULL OR (length(${table.groupName}) BETWEEN 1 AND 100 AND ${table.groupName} = btrim(${table.groupName}) AND ${table.groupName} !~ '[[:cntrl:]]')`),
  check("layers_metadata_object", sql`jsonb_typeof(${table.storageMetadata}) = 'object'`),
  check("layers_table_name", sql`${table.tableName} IS NULL OR ${table.tableName} ~ '^layer_[0-9a-f]{32}$'`),
  check("layers_source_consistent", sql`(${table.layerType} = 'VECTOR' AND ${table.sourceType} IN ('SHP','GEOJSON','POSTGIS') AND ${table.tableName} IS NOT NULL) OR (${table.layerType} = 'RASTER' AND ${table.sourceType} = 'GEOTIFF' AND ${table.tableName} IS NULL AND ${table.filePath} IS NOT NULL)`),
  check("layers_ready_bbox", sql`${table.state} <> 'READY' OR ${table.bbox} IS NOT NULL`),
  check("layers_ready_vector_srid", sql`${table.layerType} <> 'VECTOR' OR ${table.state} <> 'READY' OR (${table.srid} IS NOT NULL AND ${table.srid} = 4326)`),
  index("layers_catalog_idx").on(table.state, table.isVisible, table.createdAt),
  index("layers_order_idx").on(table.sortOrder, table.createdAt, table.id),
  index("layers_uploader_idx").on(table.uploadedBy),
  index("layers_bbox_idx").using("gist", table.bbox),
]);


// PostgreSQL-backed vector processing queue. File payloads contain server-generated IDs only.
export const gisJobs = appSchema.table("gis_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  layerId: uuid("layer_id").references(() => layers.id, { onDelete: "set null" }),
  actorId: uuid("actor_id").notNull().references(() => users.id),
  kind: text("kind").notNull().$type<"IMPORT_VECTOR" | "DELETE_LAYER">(),
  status: text("status").notNull().default("QUEUED").$type<"QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED">(),
  payload: jsonb("payload").notNull().default({}).$type<Record<string, unknown>>(),
  attempts: integer("attempts").notNull().default(0),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  lockedBy: uuid("locked_by"),
  errorCode: text("error_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("gis_jobs_kind_check", sql`${table.kind} IN ('IMPORT_VECTOR','DELETE_LAYER')`),
  check("gis_jobs_status_check", sql`${table.status} IN ('QUEUED','RUNNING','SUCCEEDED','FAILED')`),
  check("gis_jobs_payload_object", sql`jsonb_typeof(${table.payload}) = 'object'`),
  check("gis_jobs_attempts_check", sql`${table.attempts} BETWEEN 0 AND 3`),
  index("gis_jobs_claim_idx").on(table.availableAt, table.createdAt).where(sql`${table.status} = 'QUEUED'`),
  index("gis_jobs_expired_lease_idx").on(table.leaseUntil).where(sql`${table.status} = 'RUNNING'`),
  uniqueIndex("gis_jobs_active_layer_idx").on(table.layerId).where(sql`${table.status} IN ('QUEUED','RUNNING')`),
]);
