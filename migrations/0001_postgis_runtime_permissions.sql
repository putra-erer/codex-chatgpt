-- PostGIS is ready for later phases; Phase 1 contains no GIS tables.
CREATE EXTENSION IF NOT EXISTS postgis;
--> statement-breakpoint
CREATE FUNCTION app.set_updated_at() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER users_set_updated_at
BEFORE UPDATE ON app.users
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON SCHEMA app FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.set_updated_at() FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA app TO gis_app;
--> statement-breakpoint
GRANT USAGE ON TYPE app.user_role, app.user_status TO gis_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.set_updated_at() TO gis_app;
--> statement-breakpoint
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM gis_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON app.users, app.accounts, app.sessions TO gis_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON app.audit_logs TO gis_app;
