# syntax=docker/dockerfile:1

# =============================================================================
# SIP bot - production image
# =============================================================================
# Multi-stage: dependencies and the TypeScript build stay out of the runtime
# image, which runs as a non-root user with only production dependencies.
#
# The same image runs the API/bot process (`node dist/index.js`) and the worker
# (`node dist/worker.js`), so both stay in lockstep with a single build.
# =============================================================================

FROM node:20-alpine AS deps
WORKDIR /app
# `--include=dev` because the build stage needs typescript; pruned afterwards.
COPY package.json package-lock.json* ./
RUN npm ci --include=dev --ignore-scripts

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
COPY scripts ./scripts
RUN npm run build

# Strip dev dependencies from the tree we are going to copy forward.
FROM deps AS prune
RUN npm prune --omit=dev

FROM node:20-alpine AS runtime
ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps \
    TZ=UTC
WORKDIR /app

# tini reaps zombies and forwards SIGTERM, so the graceful shutdown path in
# src/index.ts (SIGTERM -> drain HTTP, purge sessions, close pool) actually runs.
RUN apk add --no-cache tini

COPY --from=prune --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node src ./src
COPY --chown=node:node tsconfig.json ./
COPY --chown=node:node .env.example ./.env.example

# Migrations and the seed script run through tsx, which is a dev dependency -
# production deployments normally run them from the host or a job container.
# Keeping src/, scripts/ and tsx out of the runtime image instead would make
# `docker compose run --rm app npm run migrate` impossible; both are therefore
# included deliberately and the image is still small.

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
