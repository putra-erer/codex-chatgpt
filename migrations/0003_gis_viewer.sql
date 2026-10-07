CREATE TYPE "app"."layer_state" AS ENUM('PROCESSING', 'READY', 'FAILED', 'DELETING');--> statement-breakpoint
CREATE TYPE "app"."layer_type" AS ENUM('VECTOR', 'RASTER');--> statement-breakpoint
CREATE TYPE "app"."source_type" AS ENUM('SHP', 'GEOJSON', 'GEOTIFF', 'POSTGIS');--> statement-breakpoint
CREATE TABLE "app"."layers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(200) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"layer_type" "app"."layer_type" NOT NULL,
	"source_type" "app"."source_type" NOT NULL,
	"table_name" text,
	"file_path" text,
	"srid" integer,
	"source_srid" integer,
	"source_crs_wkt" text,
	"style_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_visible" boolean DEFAULT true NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"state" "app"."layer_state" DEFAULT 'PROCESSING' NOT NULL,
	"geometry_type" text,
	"feature_count" bigint,
	"bbox" geometry(Geometry,4326),
	"storage_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "layers_table_name_unique" UNIQUE("table_name"),
	CONSTRAINT "layers_name_nonempty" CHECK (length(btrim("app"."layers"."name")) > 0),
	CONSTRAINT "layers_srid_positive" CHECK ("app"."layers"."srid" IS NULL OR "app"."layers"."srid" > 0),
	CONSTRAINT "layers_source_srid_positive" CHECK ("app"."layers"."source_srid" IS NULL OR "app"."layers"."source_srid" > 0),
	CONSTRAINT "layers_count_positive" CHECK ("app"."layers"."feature_count" IS NULL OR "app"."layers"."feature_count" >= 0),
	CONSTRAINT "layers_style_object" CHECK (jsonb_typeof("app"."layers"."style_json") = 'object'),
	CONSTRAINT "layers_metadata_object" CHECK (jsonb_typeof("app"."layers"."storage_metadata") = 'object'),
	CONSTRAINT "layers_uploader_or_demo" CHECK ("app"."layers"."uploaded_by" IS NOT NULL OR ("app"."layers"."storage_metadata"->>'demo' = 'true' AND "app"."layers"."source_type" = 'GEOJSON') IS TRUE),
	CONSTRAINT "layers_table_name" CHECK ("app"."layers"."table_name" IS NULL OR "app"."layers"."table_name" ~ '^layer_[0-9a-f]{32}$'),
	CONSTRAINT "layers_source_consistent" CHECK (("app"."layers"."layer_type" = 'VECTOR' AND "app"."layers"."source_type" IN ('SHP','GEOJSON','POSTGIS') AND "app"."layers"."table_name" IS NOT NULL) OR ("app"."layers"."layer_type" = 'RASTER' AND "app"."layers"."source_type" = 'GEOTIFF' AND "app"."layers"."table_name" IS NULL AND "app"."layers"."file_path" IS NOT NULL)),
	CONSTRAINT "layers_ready_bbox" CHECK ("app"."layers"."state" <> 'READY' OR "app"."layers"."bbox" IS NOT NULL),
	CONSTRAINT "layers_ready_vector_srid" CHECK ("app"."layers"."layer_type" <> 'VECTOR' OR "app"."layers"."state" <> 'READY' OR ("app"."layers"."srid" IS NOT NULL AND "app"."layers"."srid" = 4326))
);
--> statement-breakpoint
ALTER TABLE "app"."layers" ADD CONSTRAINT "layers_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "layers_catalog_idx" ON "app"."layers" USING btree ("state","is_visible","created_at");--> statement-breakpoint
CREATE INDEX "layers_uploader_idx" ON "app"."layers" USING btree ("uploaded_by");--> statement-breakpoint
CREATE INDEX "layers_bbox_idx" ON "app"."layers" USING gist ("bbox");
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS gis;
--> statement-breakpoint
REVOKE ALL ON SCHEMA gis FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA gis TO gis_app;
--> statement-breakpoint
REVOKE ALL ON app.layers FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT ON app.layers TO gis_app;
--> statement-breakpoint
GRANT USAGE ON TYPE app.layer_type, app.source_type, app.layer_state TO gis_app;
--> statement-breakpoint
CREATE TRIGGER layers_set_updated_at BEFORE UPDATE ON app.layers FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
