#!/bin/sh
# Virtual Office entrypoint — ensures data directory exists
SHARED="${VO_STATUS_DIR:-/tmp/vo-data}"
mkdir -p "$SHARED"
chmod 777 "$SHARED"
find "$SHARED" -type f -exec chmod 666 {} + 2>/dev/null
exec python server.py
