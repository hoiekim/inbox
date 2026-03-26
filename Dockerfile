FROM oven/bun:1 AS builder

WORKDIR /app

COPY package.json bun.lockb* ./
COPY tsconfig.json tsconfig.node.json ./
COPY vite.config.ts ./
COPY src src
COPY public public
COPY index.html ./

RUN bun install
RUN bun run typecheck
RUN bun test
RUN bun run build

FROM node:22-slim

WORKDIR /app

COPY --from=builder /app/build ./build

HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://localhost:3004/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "./build/server/bundle.js"]
