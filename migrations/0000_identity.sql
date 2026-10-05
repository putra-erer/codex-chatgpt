CREATE SCHEMA "app";
--> statement-breakpoint
CREATE TYPE "app"."user_role" AS ENUM('VIEWER', 'ADMIN');--> statement-breakpoint
CREATE TYPE "app"."user_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED');--> statement-breakpoint
CREATE TABLE "app"."accounts" (
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"refresh_token" text,
	"access_token" text,
	"expires_at" integer,
	"token_type" text,
	"scope" text,
	"id_token" text,
	"session_state" text,
	CONSTRAINT "accounts_provider_provider_account_id_pk" PRIMARY KEY("provider","provider_account_id"),
	CONSTRAINT "accounts_user_provider_unique" UNIQUE("user_id","provider"),
	CONSTRAINT "accounts_google_only" CHECK ("app"."accounts"."provider" = 'google'),
	CONSTRAINT "accounts_oauth_type" CHECK ("app"."accounts"."type" IN ('oauth', 'oidc'))
);
--> statement-breakpoint
CREATE TABLE "app"."audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"action" text NOT NULL,
	"target_type" text DEFAULT 'user' NOT NULL,
	"target_id" text,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"request_id" uuid,
	CONSTRAINT "audit_logs_metadata_object" CHECK (jsonb_typeof("app"."audit_logs"."metadata") = 'object')
);
--> statement-breakpoint
CREATE TABLE "app"."sessions" (
	"session_token" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text,
	"email" text NOT NULL,
	"image" text,
	"google_id" text,
	"email_verified" timestamp with time zone,
	"status" "app"."user_status" DEFAULT 'PENDING' NOT NULL,
	"role" "app"."user_role" DEFAULT 'VIEWER' NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_google_id_unique" UNIQUE("google_id"),
	CONSTRAINT "users_email_normalized" CHECK ("app"."users"."email" = lower(btrim("app"."users"."email")) AND length("app"."users"."email") > 0),
	CONSTRAINT "users_approval_identity" CHECK ((
    "app"."users"."status" = 'APPROVED' AND "app"."users"."approved_at" IS NOT NULL
      AND "app"."users"."google_id" IS NOT NULL AND "app"."users"."email_verified" IS NOT NULL
  ) OR (
    "app"."users"."status" <> 'APPROVED' AND "app"."users"."approved_at" IS NULL AND "app"."users"."approved_by" IS NULL
  ))
);
--> statement-breakpoint
ALTER TABLE "app"."accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."users" ADD CONSTRAINT "users_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "app"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_time_idx" ON "app"."audit_logs" USING btree ("timestamp","id");--> statement-breakpoint
CREATE INDEX "audit_logs_actor_idx" ON "app"."audit_logs" USING btree ("user_id","timestamp");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "app"."sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "app"."sessions" USING btree ("expires");--> statement-breakpoint
CREATE INDEX "users_status_created_idx" ON "app"."users" USING btree ("status","created_at");