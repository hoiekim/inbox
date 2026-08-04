FROM oven/bun:1 AS builder

WORKDIR /app

COPY package.json bun.lockb* ./
COPY tsconfig.json tsconfig.node.json ./
COPY vite.config.ts ./
COPY bunfig.toml ./
COPY src src
COPY scripts scripts
COPY public public
COPY index.html ./

RUN bun install
RUN bun run typecheck
RUN bun test
RUN bun run build

FROM node:22-slim

WORKDIR /app

# Read at runtime by src/server/lib/env.ts. Set on the image so a plain
# `docker run` of this artifact gets the production posture (JSON logs, HSTS,
# secure cookies, trust proxy); a deployment can still override it.
ENV NODE_ENV=production

COPY --from=builder /app/build ./build
COPY healthcheck.js ./healthcheck.js

HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
  CMD node ./healthcheck.js

CMD ["node", "./build/server/bundle.js"]
