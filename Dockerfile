# syntax=docker/dockerfile:1

# The build context is the repository root, which is also the npm workspace root, so the
# source tree and the image layout line up one to one (/app/server, /app/shared,
# /app/assets, /app/client/dist). That correspondence is load-bearing: the server resolves
# both the Tiled maps and the client bundle by walking up from its own file URL, and those
# relative paths have to mean the same thing here as they do in a checkout.

# PEM of the corporate root CA, empty by default. On the in-house network TLS is
# intercepted, so neither the Alpine mirror nor the npm registry validates inside a
# container until this certificate is trusted. Supply it as a KAD/Coolify build variable,
# or locally with:
#   docker compose build --build-arg CORP_CA_PEM="$(cat /usr/local/share/ca-certificates/kyungshin-root.crt)"
# Left empty the build is unchanged, so anywhere without interception needs no argument.
# It is a public root certificate, not a private key — carrying it in build args is safe.
ARG CORP_CA_PEM=""


FROM node:22-alpine AS base
ARG CORP_CA_PEM
# Appended to the existing bundle for apk/curl, and dropped into the source directory so
# a later `update-ca-certificates` (pulled in with the ca-certificates package) keeps it.
RUN if [ -n "$CORP_CA_PEM" ]; then \
      mkdir -p /usr/local/share/ca-certificates && \
      printf '%s\n' "$CORP_CA_PEM" > /usr/local/share/ca-certificates/corp-ca.crt && \
      cat /usr/local/share/ca-certificates/corp-ca.crt >> /etc/ssl/certs/ca-certificates.crt; \
    fi
# Node ships its own root store and ignores the system bundle, so npm needs the certificate
# named explicitly. Exported per-RUN rather than as an ENV: pointing NODE_EXTRA_CA_CERTS at
# a missing file makes every node process warn on startup.
ENV CORP_CA_FILE=/usr/local/share/ca-certificates/corp-ca.crt
WORKDIR /app


FROM base AS build

# Manifests first, so an edit to a source file does not invalidate the install layer.
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/package.json
COPY server/package.json ./server/package.json
COPY client/package.json ./client/package.json
RUN if [ -f "$CORP_CA_FILE" ]; then export NODE_EXTRA_CA_CERTS="$CORP_CA_FILE"; fi; \
    npm ci

COPY tsconfig.base.json ./tsconfig.base.json
COPY shared ./shared
COPY server ./server
COPY client ./client
# vite's publicDir points at ../assets, so the maps and sprites are copied into
# client/dist by this build as well as being read from here by the server at runtime.
COPY assets ./assets
RUN npm run build --workspace=@zep-test/client


FROM base AS runtime

# Required, not cosmetic: without curl the compose healthcheck falls back to busybox wget,
# which resolves the probe address over IPv6 only, reports a healthy container as failing
# and makes Coolify roll the deployment back.
RUN apk add --no-cache curl

ENV NODE_ENV=production
ENV PORT=8080

COPY package.json package-lock.json ./
COPY shared/package.json ./shared/package.json
COPY server/package.json ./server/package.json
COPY client/package.json ./client/package.json
# Scoped to the server workspace: an unscoped install pulls the client's phaser (118MB)
# into a runtime that never loads it. `--omit=peer` drops colyseus' optional peers, of
# which only @colyseus/uwebsockets-transport is not also a regular dependency — 113MB of
# prebuilt binaries reached solely through `getDefaultTransport()`, and server.ts always
# passes an explicit WebSocketTransport. Dropping the explicit transport would break the
# boot loudly, not silently. Together: 320MB of node_modules down to ~89MB.
RUN if [ -f "$CORP_CA_FILE" ]; then export NODE_EXTRA_CA_CERTS="$CORP_CA_FILE"; fi; \
    npm ci --omit=dev --omit=peer --workspace=@zep-test/server --include-workspace-root && \
    npm cache clean --force

COPY tsconfig.base.json ./tsconfig.base.json
COPY shared ./shared
COPY server ./server
COPY assets ./assets
COPY --from=build /app/client/dist ./client/dist

USER node
EXPOSE 8080

# There is no build output to run: `@zep-test/shared` exports TypeScript sources directly,
# so tsx is a runtime dependency and executes the entrypoint as-is. Equivalent to
# `npm start`, invoked directly so the process receives SIGTERM as PID 1.
# No migration step — this service owns no database.
CMD ["node_modules/.bin/tsx", "server/src/index.ts"]
