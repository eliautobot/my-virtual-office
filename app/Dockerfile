FROM python:3.12-slim

WORKDIR /app

# Install dependencies
RUN pip install --no-cache-dir websockets

# Copy application files
COPY . .

# Make scripts executable
RUN chmod +x entrypoint.sh && \
    mkdir -p /data /tmp/vo-data

# Default environment
ENV VO_STATUS_DIR=/data \
    VO_OPENCLAW_PATH=/openclaw \
    VO_PORT=8090 \
    VO_WS_PORT=8091

EXPOSE 8090 8091

ENTRYPOINT ["/app/entrypoint.sh"]
