# syntax=docker/dockerfile:1
# The production image: the Next.js standalone server, with the Hono API inside it.
# What App Runner runs, and what `docker compose --profile app up --build` runs locally.
# On start, src/instrumentation.ts applies migrations + seeds from src/server/db/sql.
#
# Only the files the build needs are copied (no .dockerignore required): never the
# host's node_modules (wrong platform), .next, or .env files (secrets stay out of layers).

# ---- deps: Linux node_modules from the lockfile
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- build: next build with output: "standalone"
FROM node:24-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json next.config.ts tsconfig.json ./
COPY src ./src
# next build type-checks every .ts/.tsx under the context, including the tests
# in src/ (e.g. src/components/ui/toast.test.tsx). Their jest-dom matchers
# (toBeInTheDocument, ...) are typed by this setup file; without it the build fails.
COPY tests/setup-dom.ts ./tests/setup-dom.ts
# public/ holds no tracked files today (fonts come from next/font and a CDN).
# When static files are added there, add `COPY public ./public` here.
RUN mkdir -p public
RUN npm run build

# ---- runtime: only the traced server, static assets and SQL files
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
# Also listed in outputFileTracingIncludes; copied explicitly so migrations never go missing.
COPY --from=build --chown=node:node /app/src/server/db/sql ./src/server/db/sql
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server.js"]
