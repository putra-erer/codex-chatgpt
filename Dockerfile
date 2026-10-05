# syntax=docker/dockerfile:1
FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS dependencies
COPY package.json package-lock.json ./
RUN npm ci --include=dev

FROM dependencies AS builder
COPY . .
# Authentication and database connections are runtime-only configuration.
RUN npm run build

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
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
COPY --chown=node:node docker/with-database-url.mjs ./docker/with-database-url.mjs
USER node
EXPOSE 3000
ENTRYPOINT ["node", "docker/with-database-url.mjs", "DATABASE_URL"]
CMD ["node", "server.js"]
