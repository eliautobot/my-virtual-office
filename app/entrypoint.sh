#!/bin/sh
# Virtual Office entrypoint
SHARED="${VO_STATUS_DIR:-/tmp/vo-data}"
mkdir -p "$SHARED"
chmod 777 "$SHARED"
find "$SHARED" -type f -exec chmod 666 {} + 2>/dev/null

# Cache-busting: stamp current epoch into ?v= params for .js and .css refs
CACHE_V=$(date +%s)
sed -i "s/?v=[0-9]*/?v=${CACHE_V}/g" index.html
echo "[entrypoint] Cache-busted index.html with v=${CACHE_V}"

exec python3 server.py
