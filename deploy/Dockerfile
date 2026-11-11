# Base image pinned by multi-platform index digest; the tag is kept for
# readability. Refresh both together (docker buildx imagetools inspect <tag>).
ARG NODE_IMAGE=node:24.12.0-bookworm-slim@sha256:7326fb2dbdce998edd72140946851be64ef4a643e8715e138ca467e8e9d92c99

FROM ${NODE_IMAGE} AS build

WORKDIR /app
COPY package.json package-lock.json .npmrc tsconfig.base.json ./
# .dockerignore excludes apps/mobile; the server image never builds or ships it.
COPY apps ./apps
COPY packages ./packages
ARG SERVER_WORKSPACES="--workspace=@benchledger/server --workspace=@benchledger/web --workspace=@benchledger/mcp --workspace=@benchledger/import-cli --workspace=packages --include-workspace-root"
RUN npm ci ${SERVER_WORKSPACES}
RUN npm run build:server
RUN npm prune --omit=dev ${SERVER_WORKSPACES}
# Stage only what the server needs at runtime: each workspace's manifest, its
# compiled dist and any workspace-local production node_modules. Sources,
# tests (sources and compiled), configs and the mobile app stay out of the
# runtime image. Test files are still compiled in this stage because some
# workspaces currently get their Node type references through them.
RUN set -eu; \
  mkdir -p /out; \
  cp package.json package-lock.json /out/; \
  cp -a node_modules /out/node_modules; \
  for workspace in apps/server apps/web apps/mcp apps/import-cli packages/*; do \
    mkdir -p "/out/$workspace"; \
    cp "$workspace/package.json" "/out/$workspace/"; \
    cp -a "$workspace/dist" "/out/$workspace/dist"; \
    if [ -d "$workspace/node_modules" ]; then cp -a "$workspace/node_modules" "/out/$workspace/node_modules"; fi; \
  done; \
  find /out/apps /out/packages -path '*/node_modules' -prune -o -type f -name '*.test.*' -print | xargs -r rm -f

FROM ${NODE_IMAGE} AS runtime

ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --system --gid 10001 benchledger \
  && useradd --system --uid 10001 --gid benchledger --home-dir /nonexistent benchledger
COPY --from=build --chown=benchledger:benchledger /out/ ./
COPY --chown=benchledger:benchledger deploy/healthcheck.mjs ./deploy/healthcheck.mjs
COPY --chown=benchledger:benchledger scripts/benchledger-backup.mjs ./scripts/benchledger-backup.mjs
USER benchledger
EXPOSE 8792
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "deploy/healthcheck.mjs"]
CMD ["node", "apps/server/dist/main.js"]
