#!/usr/bin/env bash
set -euo pipefail

: "${APP_DB_PASSWORD:?APP_DB_PASSWORD is required}"

# psql reads the password from its environment, never a command-line argument.
# This hook runs only when the database volume is initialized for the first time.
psql --no-psqlrc --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\getenv app_password APP_DB_PASSWORD
CREATE ROLE gis_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
ALTER ROLE gis_app PASSWORD :'app_password';
REVOKE ALL ON DATABASE :"DBNAME" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"DBNAME" TO gis_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SQL
