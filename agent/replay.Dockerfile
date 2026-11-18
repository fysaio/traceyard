FROM node:22-bookworm-slim
COPY interaction-format.mjs record-fetch.mjs replay-entry.mjs test-report.mjs /opt/traceyard/
USER node
ENTRYPOINT ["node", "/opt/traceyard/replay-entry.mjs"]
