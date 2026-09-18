# syntax=docker/dockerfile:1

# Build the React client and Fastify server for the target add-on architecture.
FROM node:24-alpine AS build

WORKDIR /app

# better-sqlite3 builds a native module for the architecture being built.
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/algorithms/package.json packages/algorithms/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/gcode/package.json packages/gcode/package.json
COPY packages/geometry/package.json packages/geometry/package.json
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine

ARG BUILD_VERSION=0.1.0
ARG BUILD_ARCH
LABEL \
  io.hass.version="${BUILD_VERSION}" \
  io.hass.type="app" \
  io.hass.arch="${BUILD_ARCH}"

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787 \
    PLOTTER_DATABASE=/data/plotter.sqlite

# libstdc++ is required by the native better-sqlite3 module.
RUN apk add --no-cache libstdc++
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY docker-entrypoint.mjs ./docker-entrypoint.mjs

EXPOSE 8787
CMD ["node", "/app/docker-entrypoint.mjs"]
