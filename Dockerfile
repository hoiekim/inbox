FROM oven/bun:1 AS builder

WORKDIR /app

COPY package.json bun.lockb* ./
COPY tsconfig.json tsconfig.node.json ./
COPY vite.config.ts ./
COPY src src
COPY test test
COPY public public
COPY index.html ./

RUN bun install
RUN bun test
RUN bun run build

FROM node:22-slim

WORKDIR /app

COPY --from=builder /app/build ./build

CMD ["node", "./build/server/bundle.js"]
