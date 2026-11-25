FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 python3-venv && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/traceyard
COPY runner/package/package.json runner/package/package-lock.json ./
COPY runner/package/compat ./compat
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY agent ./agent
COPY packages/core ./packages/core
RUN mkdir -p /workspace && chown node:node /workspace
USER node
ENTRYPOINT ["sleep", "900"]
