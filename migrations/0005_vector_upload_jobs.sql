CREATE TABLE "app"."gis_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"layer_id" uuid,
	"actor_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"locked_by" uuid,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gis_jobs_kind_check" CHECK ("app"."gis_jobs"."kind" IN ('IMPORT_VECTOR','DELETE_LAYER')),
	CONSTRAINT "gis_jobs_status_check" CHECK ("app"."gis_jobs"."status" IN ('QUEUED','RUNNING','SUCCEEDED','FAILED')),
	CONSTRAINT "gis_jobs_payload_object" CHECK (jsonb_typeof("app"."gis_jobs"."payload") = 'object'),
	CONSTRAINT "gis_jobs_attempts_check" CHECK ("app"."gis_jobs"."attempts" BETWEEN 0 AND 3)
);
--> statement-breakpoint
ALTER TABLE "app"."gis_jobs" ADD CONSTRAINT "gis_jobs_layer_id_layers_id_fk" FOREIGN KEY ("layer_id") REFERENCES "app"."layers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."gis_jobs" ADD CONSTRAINT "gis_jobs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gis_jobs_claim_idx" ON "app"."gis_jobs" USING btree ("available_at","created_at") WHERE "app"."gis_jobs"."status" = 'QUEUED';--> statement-breakpoint
CREATE INDEX "gis_jobs_expired_lease_idx" ON "app"."gis_jobs" USING btree ("lease_until") WHERE "app"."gis_jobs"."status" = 'RUNNING';--> statement-breakpoint
CREATE UNIQUE INDEX "gis_jobs_active_layer_idx" ON "app"."gis_jobs" USING btree ("layer_id") WHERE "app"."gis_jobs"."status" IN ('QUEUED','RUNNING');--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='gis_worker') THEN
    CREATE ROLE gis_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO gis_worker', current_database());
END $$;
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS gis_staging AUTHORIZATION gis_worker;
--> statement-breakpoint
REVOKE ALL ON SCHEMA gis_staging FROM PUBLIC, gis_app;
--> statement-breakpoint
GRANT USAGE, CREATE ON SCHEMA gis_staging, gis TO gis_worker;
--> statement-breakpoint
GRANT USAGE ON SCHEMA app TO gis_worker;
--> statement-breakpoint
GRANT USAGE ON TYPE app.layer_type, app.source_type, app.layer_state, app.user_role, app.user_status TO gis_worker;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.set_updated_at() TO gis_worker;
--> statement-breakpoint
REVOKE ALL ON app.users, app.accounts FROM gis_worker;
--> statement-breakpoint
GRANT SELECT (id, status, role, google_id, email_verified) ON app.users TO gis_worker;
--> statement-breakpoint
GRANT SELECT (user_id, provider, provider_account_id) ON app.accounts TO gis_worker;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON app.layers TO gis_worker;
--> statement-breakpoint
GRANT SELECT, UPDATE ON app.gis_jobs TO gis_worker;
--> statement-breakpoint
GRANT SELECT, INSERT ON app.audit_logs TO gis_worker;
--> statement-breakpoint
REVOKE ALL ON app.gis_jobs FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT ON app.gis_jobs TO gis_app;
--> statement-breakpoint
GRANT INSERT, UPDATE ON app.layers TO gis_app;
--> statement-breakpoint
CREATE TRIGGER gis_jobs_set_updated_at BEFORE UPDATE ON app.gis_jobs FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
