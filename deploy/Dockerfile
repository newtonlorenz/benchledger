FROM node:24.12.0-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json* .npmrc tsconfig.base.json vitest.config.ts ./
COPY apps ./apps
COPY packages ./packages
RUN npm ci
RUN npm run build
RUN npm prune --omit=dev

FROM node:24.12.0-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --system --gid 10001 benchledger \
  && useradd --system --uid 10001 --gid benchledger --home-dir /nonexistent benchledger
COPY --from=build --chown=benchledger:benchledger /app/package.json /app/package-lock.json ./
COPY --from=build --chown=benchledger:benchledger /app/node_modules ./node_modules
COPY --from=build --chown=benchledger:benchledger /app/apps ./apps
COPY --from=build --chown=benchledger:benchledger /app/packages ./packages
COPY --chown=benchledger:benchledger deploy/healthcheck.mjs ./deploy/healthcheck.mjs
USER benchledger
EXPOSE 8792
CMD ["node", "apps/server/dist/main.js"]
