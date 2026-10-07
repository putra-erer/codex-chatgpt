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
--> statement-breakpoint
CREATE TABLE gis.layer_11111111111141118111111111111111 (feature_id integer PRIMARY KEY, properties jsonb NOT NULL, geom geometry(Polygon,4326) NOT NULL);
--> statement-breakpoint
INSERT INTO gis.layer_11111111111141118111111111111111 VALUES (1, '{"name": "North workspace", "category": "Polygon", "demo": true, "description": "Synthetic demonstration data; not a surveyed company asset."}'::jsonb, ST_SetSRID(ST_GeomFromGeoJSON('{"type": "Polygon", "coordinates": [[[106.816, -6.168], [106.833, -6.168], [106.835, -6.185], [106.82, -6.187], [106.816, -6.168]]]}'),4326));
--> statement-breakpoint
INSERT INTO gis.layer_11111111111141118111111111111111 VALUES (2, '{"name": "South workspace", "category": "Polygon", "demo": true, "description": "Synthetic demonstration data; not a surveyed company asset."}'::jsonb, ST_SetSRID(ST_GeomFromGeoJSON('{"type": "Polygon", "coordinates": [[[106.82, -6.194], [106.839, -6.191], [106.844, -6.208], [106.825, -6.213], [106.82, -6.194]]]}'),4326));
--> statement-breakpoint
CREATE INDEX layer_11111111111141118111111111111111_geom_idx ON gis.layer_11111111111141118111111111111111 USING gist(geom);
--> statement-breakpoint
GRANT SELECT ON gis.layer_11111111111141118111111111111111 TO gis_app;
--> statement-breakpoint
INSERT INTO app.layers (id,name,description,layer_type,source_type,table_name,srid,source_srid,style_json,state,geometry_type,feature_count,bbox,storage_metadata)
SELECT '11111111-1111-4111-8111-111111111111','Demo · Work areas','Synthetic demo around Jakarta for testing the GIS viewer.','VECTOR','GEOJSON','layer_11111111111141118111111111111111',4326,4326,'{"color": "#16a085", "opacity": 0.3, "width": 3, "radius": 7}'::jsonb,'READY','Polygon',count(*),ST_Envelope(ST_Collect(geom)), '{"demo":true,"attribution":"Company GIS synthetic demo"}'::jsonb FROM gis.layer_11111111111141118111111111111111;
--> statement-breakpoint
ANALYZE gis.layer_11111111111141118111111111111111;
--> statement-breakpoint
CREATE TABLE gis.layer_22222222222242228222222222222222 (feature_id integer PRIMARY KEY, properties jsonb NOT NULL, geom geometry(LineString,4326) NOT NULL);
--> statement-breakpoint
INSERT INTO gis.layer_22222222222242228222222222222222 VALUES (1, '{"name": "Central connection", "category": "LineString", "demo": true, "description": "Synthetic demonstration data; not a surveyed company asset."}'::jsonb, ST_SetSRID(ST_GeomFromGeoJSON('{"type": "LineString", "coordinates": [[106.819, -6.174], [106.827, -6.18], [106.827, -6.198], [106.837, -6.204]]}'),4326));
--> statement-breakpoint
INSERT INTO gis.layer_22222222222242228222222222222222 VALUES (2, '{"name": "Eastern connection", "category": "LineString", "demo": true, "description": "Synthetic demonstration data; not a surveyed company asset."}'::jsonb, ST_SetSRID(ST_GeomFromGeoJSON('{"type": "LineString", "coordinates": [[106.827, -6.18], [106.844, -6.181], [106.848, -6.198], [106.837, -6.204]]}'),4326));
--> statement-breakpoint
CREATE INDEX layer_22222222222242228222222222222222_geom_idx ON gis.layer_22222222222242228222222222222222 USING gist(geom);
--> statement-breakpoint
GRANT SELECT ON gis.layer_22222222222242228222222222222222 TO gis_app;
--> statement-breakpoint
INSERT INTO app.layers (id,name,description,layer_type,source_type,table_name,srid,source_srid,style_json,state,geometry_type,feature_count,bbox,storage_metadata)
SELECT '22222222-2222-4222-8222-222222222222','Demo · Operating routes','Synthetic demo around Jakarta for testing the GIS viewer.','VECTOR','GEOJSON','layer_22222222222242228222222222222222',4326,4326,'{"color": "#e59a29", "opacity": 0.95, "width": 3, "radius": 7}'::jsonb,'READY','LineString',count(*),ST_Envelope(ST_Collect(geom)), '{"demo":true,"attribution":"Company GIS synthetic demo"}'::jsonb FROM gis.layer_22222222222242228222222222222222;
--> statement-breakpoint
ANALYZE gis.layer_22222222222242228222222222222222;
--> statement-breakpoint
CREATE TABLE gis.layer_33333333333343338333333333333333 (feature_id integer PRIMARY KEY, properties jsonb NOT NULL, geom geometry(Point,4326) NOT NULL);
--> statement-breakpoint
INSERT INTO gis.layer_33333333333343338333333333333333 VALUES (1, '{"name": "Operations office", "category": "Point", "demo": true, "description": "Synthetic demonstration data; not a surveyed company asset."}'::jsonb, ST_SetSRID(ST_GeomFromGeoJSON('{"type": "Point", "coordinates": [106.827, -6.18]}'),4326));
--> statement-breakpoint
INSERT INTO gis.layer_33333333333343338333333333333333 VALUES (2, '{"name": "North depot", "category": "Point", "demo": true, "description": "Synthetic demonstration data; not a surveyed company asset."}'::jsonb, ST_SetSRID(ST_GeomFromGeoJSON('{"type": "Point", "coordinates": [106.819, -6.174]}'),4326));
--> statement-breakpoint
INSERT INTO gis.layer_33333333333343338333333333333333 VALUES (3, '{"name": "Field station", "category": "Point", "demo": true, "description": "Synthetic demonstration data; not a surveyed company asset."}'::jsonb, ST_SetSRID(ST_GeomFromGeoJSON('{"type": "Point", "coordinates": [106.837, -6.204]}'),4326));
--> statement-breakpoint
INSERT INTO gis.layer_33333333333343338333333333333333 VALUES (4, '{"name": "East depot", "category": "Point", "demo": true, "description": "Synthetic demonstration data; not a surveyed company asset."}'::jsonb, ST_SetSRID(ST_GeomFromGeoJSON('{"type": "Point", "coordinates": [106.848, -6.198]}'),4326));
--> statement-breakpoint
CREATE INDEX layer_33333333333343338333333333333333_geom_idx ON gis.layer_33333333333343338333333333333333 USING gist(geom);
--> statement-breakpoint
GRANT SELECT ON gis.layer_33333333333343338333333333333333 TO gis_app;
--> statement-breakpoint
INSERT INTO app.layers (id,name,description,layer_type,source_type,table_name,srid,source_srid,style_json,state,geometry_type,feature_count,bbox,storage_metadata)
SELECT '33333333-3333-4333-8333-333333333333','Demo · Facilities','Synthetic demo around Jakarta for testing the GIS viewer.','VECTOR','GEOJSON','layer_33333333333343338333333333333333',4326,4326,'{"color": "#4361ee", "opacity": 1, "width": 3, "radius": 7}'::jsonb,'READY','Point',count(*),ST_Envelope(ST_Collect(geom)), '{"demo":true,"attribution":"Company GIS synthetic demo"}'::jsonb FROM gis.layer_33333333333343338333333333333333;
--> statement-breakpoint
ANALYZE gis.layer_33333333333343338333333333333333;
