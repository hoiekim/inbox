FROM oven/bun:1 AS builder

WORKDIR /app

COPY package.json bun.lockb* ./
COPY tsconfig.json tsconfig.node.json ./
COPY vite.config.ts ./
COPY src src
COPY public public
COPY index.html ./

RUN bun install
RUN bun test
RUN bun run build

FROM node:22-slim

WORKDIR /app

# Grant node the capability to bind to privileged ports (e.g. SMTP on port 25)
# without running the entire process as root.
RUN apt-get update && \
    apt-get install -y --no-install-recommends libcap2-bin && \
    setcap 'cap_net_bind_service=+ep' /usr/local/bin/node && \
    apt-get remove -y libcap2-bin && \
    apt-get autoremove -y && \
    rm -rf /var/lib/apt/lists/*

# Create a non-root user to run the application
RUN groupadd --gid 1001 appgroup && \
    useradd --uid 1001 --gid appgroup --shell /bin/bash --create-home appuser

COPY --from=builder /app/build ./build

# Transfer ownership to non-root user
RUN chown -R appuser:appgroup /app

USER appuser

CMD ["node", "./build/server/bundle.js"]
