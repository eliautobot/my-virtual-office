#!/bin/bash
# media-cleanup.sh — Remove media files older than 24 hours from OpenClaw inbound
# Runs via systemd timer

OPENCLAW_PATH="${VO_OPENCLAW_PATH:-${HOME}/.openclaw}"
MEDIA_DIR="$OPENCLAW_PATH/media/inbound"
MAX_AGE_HOURS=24

if [ -d "$MEDIA_DIR" ]; then
    count=$(find "$MEDIA_DIR" -type f -mmin +$((MAX_AGE_HOURS * 60)) | wc -l)
    if [ "$count" -gt 0 ]; then
        find "$MEDIA_DIR" -type f -mmin +$((MAX_AGE_HOURS * 60)) -delete
        echo "$(date): Cleaned $count files older than ${MAX_AGE_HOURS}h from $MEDIA_DIR"
    fi
fi
