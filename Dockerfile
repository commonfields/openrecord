# OpenRecord hosted pilot images.
#
# One Dockerfile, three targets (web, api, worker), per
# docs/engineering/hosted-effect-architecture-v1.md ("Dockerfiles can be added
# per process, Node 24 major, no Kubernetes in V1"). The web target ships only
# the built SPA plus Caddy, which serves it and reverse-proxies /api to the
# api service over the private compose network. The api and worker targets run
# the existing built processes with tsx compiling the workspace's TypeScript
# sources at runtime, exactly like `pnpm start` (apps/api/package.json).
#
# Build from the repository root:
#   docker build --target api   -t openrecord-api   .
#   docker build --target worker -t openrecord-worker .
#   docker build --target web   -t openrecord-web   .

# --- common base: Node 24 (matches .node-version and every engines field) ---
FROM node:24-slim AS base
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production

# --- build: install the frozen workspace and build every package ---
FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY eslint.config.mjs ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile --prod=false
# The web SPA is built for the reverse proxy; api/worker/packages produce dist/.
RUN pnpm --filter @openrecord/web build \
    && pnpm --filter '!@openrecord/web' build

# --- api: migrate + serve (command set by compose; image only fixes runtime) ---
FROM base AS api
COPY --from=build /app /app
WORKDIR /app
EXPOSE 3001
CMD ["node", "--import", "tsx", "apps/api/dist/server.js"]

# --- worker: the same durable job loops as in development ---
FROM base AS worker
COPY --from=build /app /app
WORKDIR /app
CMD ["node", "--import", "tsx", "apps/worker/dist/runner.js"]

# --- web: built SPA + Caddy (static files + /api reverse proxy + TLS) ---
FROM caddy:2-alpine AS web
COPY --from=build /app/apps/web/dist /srv/openrecord-web
COPY deploy/Caddyfile /etc/caddy/Caddyfile
