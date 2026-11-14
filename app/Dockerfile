# The OpenClaw and Hermes provider layer (app/provider-layer, copied from My Virtual World) runs on Node.js: its npm
# packages are installed here with Node 24, and the office image takes Node and the packages from this stage.
FROM node:24-slim AS pl
WORKDIR /pl
COPY provider-layer/package.json provider-layer/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM python:3.12-slim

WORKDIR /app

# Install dependencies. Pin the installer above the audited vulnerable base
# version so the shipped image does not retain known pip advisories.
RUN python -m pip install --no-cache-dir --upgrade pip==26.2.1 \
    && python -m pip install --no-cache-dir websockets==17.0.1

# Copy application files
COPY . .

# Node.js and the provider layer's packages (no apt Node: Debian's is too old for the layer)
COPY --from=pl /usr/local/bin/node /usr/local/bin/node
COPY --from=pl /usr/local/LICENSE /usr/share/doc/nodejs/LICENSE
COPY --from=pl /pl/node_modules /app/provider-layer/node_modules
RUN node --version

# Create data directory
RUN mkdir -p /data

# Default environment
ENV VO_STATUS_DIR=/data \
    VO_OPENCLAW_PATH=/openclaw \
    VO_PORT=8090 \
    VO_WS_PORT=8091 \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

EXPOSE 8090 8091

RUN chmod +x entrypoint.sh

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD python3 -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/health' % os.environ.get('VO_PORT','8090'), timeout=4)" || exit 1

CMD ["sh", "entrypoint.sh"]
