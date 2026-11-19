FROM node:22-bookworm-slim
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
WORKDIR /opt/traceyard
COPY package.json package-lock.json ./
RUN npm ci --include=dev --ignore-scripts --no-audit --no-fund \
    && npx playwright install --with-deps chromium
COPY agent ./agent
USER node
ENTRYPOINT ["node", "agent/cli.mjs", "compare-browser"]
