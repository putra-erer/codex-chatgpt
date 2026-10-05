import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
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

export const auditLogs = appSchema.table("audit_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  action: text("action").notNull().$type<"LOGIN" | "USER_APPROVED" | "USER_REJECTED" | "ROLE_CHANGED">(),
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
