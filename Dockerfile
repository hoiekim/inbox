FROM oven/bun:1.4.4 AS builder

WORKDIR /app

COPY package.json bun.lock ./
COPY tsconfig.json tsconfig.node.json ./
COPY vite.config.ts ./
COPY bunfig.toml ./
COPY src src
COPY scripts scripts
COPY public public
COPY index.html ./
COPY healthcheck.js ./
COPY .env.example ./

RUN bun install --frozen-lockfile
RUN bun run typecheck
RUN bun test
RUN bun run build

# Same Bun release as the builder. 1.4 is the floor: earlier releases cannot
# upgrade an accepted socket to TLS server-side (`new tls.TLSSocket(socket,
# { isServer: true })`), which the SMTP server needs for port 465 and STARTTLS and
# the IMAP server needs for STARTTLS — the handshake hangs with no error.
FROM oven/bun:1.4.4-slim

WORKDIR /app

COPY --from=builder /app/build ./build
COPY healthcheck.js ./healthcheck.js

HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
  CMD bun ./healthcheck.js

CMD ["bun", "./build/server/bundle.js"]
