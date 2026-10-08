# syntax=docker/dockerfile:1
FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS dependencies
COPY --chown=node:node package.json package-lock.json ./
# Optional enterprise/cloud CA is mounted only for dependency download, never baked into the image.
RUN --mount=type=secret,id=build_ca \
    if [ -s /run/secrets/build_ca ]; then NODE_EXTRA_CA_CERTS=/run/secrets/build_ca npm ci --include=dev --no-audit; \
    else npm ci --include=dev --no-audit; fi

FROM dependencies AS builder
COPY . .
# Authentication and database connections are runtime-only configuration.
RUN npm run build

FROM dependencies AS worker
# Pin to Debian bookworm's maintained GDAL line; no GIS tools in the web image.
RUN apt-get update && apt-get install -y --no-install-recommends gdal-bin=3.6.2+dfsg-1+b2 \
    && rm -rf /var/lib/apt/lists/* && mkdir -p /data/gis && chown node:node /data/gis
ENV NODE_ENV=production GIS_STORAGE_ROOT=/data/gis
# .dockerignore excludes credentials, local storage, dependencies and build outputs.
COPY --chown=node:node . .
USER node
ENTRYPOINT ["node", "docker/with-database-url.mjs", "GIS_WORKER_DATABASE_URL"]
CMD ["node_modules/.bin/tsx", "scripts/gis-worker.ts"]

FROM dependencies AS migrate
ENV NODE_ENV=production
COPY --chown=node:node tsconfig.json drizzle.config.ts ./
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node src ./src
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node docker/with-database-url.mjs ./docker/with-database-url.mjs
USER node
ENTRYPOINT ["node", "docker/with-database-url.mjs", "MIGRATION_DATABASE_URL"]
CMD ["node_modules/.bin/tsx", "scripts/migrate.ts"]

FROM base AS app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 GIS_STORAGE_ROOT=/data/gis
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
COPY --chown=node:node docker/with-database-url.mjs ./docker/with-database-url.mjs
RUN mkdir -p /data/gis && chown node:node /data/gis
USER node
EXPOSE 3000
ENTRYPOINT ["node", "docker/with-database-url.mjs", "DATABASE_URL"]
CMD ["node", "server.js"]
