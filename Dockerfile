FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
# Every package is a runtime dependency (simulated chain, Solidity compiler, Uniswap artifacts, Solana client),
# so a production install (dev dependencies omitted) still includes everything the server needs.
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node . .
RUN mkdir -p /app/local-data && chown node:node /app /app/local-data
ENV NODE_ENV=production
ENV HOST=0.0.0.0
# Fewer glibc malloc arenas: the server runs worker and SQLite threads, and per-thread arenas inflate resident memory.
ENV MALLOC_ARENA_MAX=2
USER node
# Node directly, not through npm: npm stays resident (about 60 MB) and sits between Railway's SIGTERM and the server.
CMD ["node", "--env-file-if-exists=.env", "apps/api/server.mjs"]
