# syntax=docker/dockerfile:1.20
# One image for the whole app: the Hono API (which also runs the ingest
# pipeline) plus the built web app it serves. Build context is the repo root.
FROM node:22-alpine

# tini as PID 1 forwards SIGTERM to node, so a pod shuts down when Kubernetes
# asks instead of waiting out the grace period.
RUN apk add --no-cache tini ffmpeg

# pnpm pinned to the root package.json "packageManager" version.
RUN corepack enable && corepack prepare pnpm@10.28.1 --activate

WORKDIR /app

# Manifests first so the install layer is cached until dependencies change.
# --parents keeps each package.json at its path; globs tolerate apps/web not
# existing yet.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --parents apps/*/package.json packages/*/package.json ./
# Dev deps included on purpose: the server runs TypeScript directly with tsx.
RUN pnpm install --frozen-lockfile

COPY . .

# The API serves apps/web/dist. Build it only once stream B has added the app.
RUN if [ -f apps/web/package.json ]; then pnpm --filter ./apps/web build; fi

ARG APP_VERSION=dev
# tsx writes its transform cache under TMPDIR; HOME=/tmp keeps anything else
# that wants a home dir writable as uid 1000.
ENV PORT=8080 NODE_ENV=production APP_VERSION=$APP_VERSION TMPDIR=/tmp HOME=/tmp

WORKDIR /app/apps/api
# The node image's "node" user, by number so runAsNonRoot can check it.
USER 1000
EXPOSE 8080
ENTRYPOINT ["/sbin/tini", "--"]
# Same as `pnpm start` (tsx src/main.ts) without a wrapper process: node loads
# tsx as a module hook, resolved from the workspace root node_modules.
CMD ["node", "--import", "tsx", "src/main.ts"]
