# syntax=docker/dockerfile:1

# The build context is the repository root, which is also the npm workspace root, so the
# source tree and the image layout line up one to one (/app/server, /app/shared,
# /app/assets, /app/client/dist). That correspondence is load-bearing: the server resolves
# both the Tiled maps and the client bundle by walking up from its own file URL, and those
# relative paths have to mean the same thing here as they do in a checkout.

FROM node:22-alpine AS base
# KAD/Coolify re-signs all in-house outbound TLS with a corp root CA, so every external
# fetch in this build (apk mirror, npm registry) fails verification until that CA is
# trusted. KAD supplies it as a BuildKit secret named `corp_ca` (org-wide convention — see
# KAD_배포 가이드 §C.2.1); mounted as a file here, never a Dockerfile ARG/ENV, so the PEM
# never lands in an image layer or build log. `required=true` fails the build immediately
# with "secret corp_ca: not found" if the secret isn't registered for this app, instead of
# silently building an untrusted image whose corp-CA gap only surfaces later on an
# unrelated fetch (see docs/decisions.md, 2026-08-25).
# §C.2.1's own snippet targets a Debian/apt base; node:22-alpine has no apt-get, but Alpine
# already ships /etc/ssl/certs/ca-certificates.crt, so appending the corp cert straight into
# it is enough for apk/openssl/npm to trust it — no `update-ca-certificates` step needed
# (verified locally via `docker build --secret id=corp_ca,src=<path>`).
RUN --mount=type=secret,id=corp_ca,target=/tmp/corp-ca.pem,required=true \
    cat /tmp/corp-ca.pem >> /etc/ssl/certs/ca-certificates.crt
# Node ignores the system bundle and needs the certificate named explicitly; npm's own
# `cafile` must point at this same merged bundle, never a corp-only file — pointing it at a
# single cert *replaces* npm's trust store instead of adding to it, which would break the
# very registry fetches this exists to unblock.
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
RUN npm config -g set cafile /etc/ssl/certs/ca-certificates.crt
WORKDIR /app


FROM base AS build

# Manifests first, so an edit to a source file does not invalidate the install layer.
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/package.json
COPY server/package.json ./server/package.json
COPY client/package.json ./client/package.json
# `--omit=peer` (see the runtime install below for why): without it, npm also resolves
# colyseus' optional `@colyseus/uwebsockets-transport` peer here, which fetches
# uWebSockets.js straight from a GitHub tarball URL rather than the npm registry — on the
# in-house network that request goes through the TLS-intercepting proxy and fails
# certificate verification regardless of the corp CA above. The client build never touches
# this transport, so skipping it removes the dependency on that fetch entirely.
RUN npm ci --omit=peer

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
RUN npm ci --omit=dev --omit=peer --workspace=@zep-test/server --include-workspace-root && \
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
# Migrations run from this entrypoint, not from a build stage: the database only exists at
# deploy time, and a build that reached it would have to be given credentials. The SQL files
# ride along in `COPY server ./server` above.
CMD ["node_modules/.bin/tsx", "server/src/index.ts"]
