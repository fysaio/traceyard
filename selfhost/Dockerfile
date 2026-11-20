# Self-hosted Traceyard: the web app, API and MCP server on the local Workers
# runtime, with its database in SQLite files under /data.
# Build from the repository root: docker build -f selfhost/Dockerfile .
FROM node:22-bookworm-slim AS build
# workerd, which generates the Worker types during the build, needs CA certificates.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ENV WRANGLER_SEND_METRICS=false WRANGLER_SEND_ERROR_REPORTS=false DO_NOT_TRACK=1
RUN npm run build
RUN node -p "require('./package-lock.json').packages['node_modules/wrangler'].version" > /wrangler-version

FROM node:22-bookworm-slim
ARG VERSION=dev
ARG REVISION=
LABEL org.opencontainers.image.title="Traceyard" \
      org.opencontainers.image.description="Self-hosted Traceyard with SQLite storage." \
      org.opencontainers.image.source="https://github.com/fysaio/traceyard" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/traceyard
COPY --from=build /wrangler-version /tmp/wrangler-version
RUN npm init -y >/dev/null \
 && npm install --no-audit --no-fund --omit=dev "wrangler@$(cat /tmp/wrangler-version)" \
 && npm cache clean --force && rm /tmp/wrangler-version
COPY --from=build /src/dist ./dist
COPY --from=build /src/migrations ./migrations
COPY selfhost/worker.mjs selfhost/start.mjs ./selfhost/
RUN mkdir -p /data && chown -R node:node /data /opt/traceyard
USER node
ENV NODE_ENV=production PORT=8787 HOST=0.0.0.0 TRACEYARD_DATA_DIR=/data \
    BUILD_REVISION=${REVISION} \
    WRANGLER_SEND_METRICS=false WRANGLER_SEND_ERROR_REPORTS=false DO_NOT_TRACK=1 \
    XDG_CONFIG_HOME=/opt/traceyard/.config
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["tini", "--"]
CMD ["node", "selfhost/start.mjs"]
