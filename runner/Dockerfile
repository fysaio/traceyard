FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/traceyard
COPY runner/package/package.json runner/package/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY agent ./agent
RUN mkdir -p /workspace && chown node:node /workspace
USER node
ENTRYPOINT ["sleep", "900"]
