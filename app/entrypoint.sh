#!/bin/sh
# Virtual Office entrypoint
set -e
SHARED="${VO_STATUS_DIR:-/data}"
mkdir -p "$SHARED"
# No blanket chmod: the data folder holds credentials (vo-config.json, access.json).
# To own the files as your host user, set `user:` in docker-compose.yml (see .env.example).
# Cache busting happens per request (the server stamps ?v= tokens from file
# mtimes), so index.html is never edited in place.
exec python3 -u server.py
