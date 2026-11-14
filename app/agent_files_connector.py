#!/usr/bin/env python3
"""Read-only Agent Files Connector for remote provider computers.

Runs on Windows, Linux, or macOS with only the Python standard library. The
connector exposes administrator-approved roots and never accepts unrestricted
absolute paths or command execution.
"""

from __future__ import annotations

import argparse
import hmac
import http.server
import json
import os
import re
import ssl
import sys
import urllib.parse
from pathlib import Path

from agent_pc import (
    DOCUMENT_MAX_BYTES,
    EXTENSION_KINDS,
    MEDIA_MAX_BYTES,
    NOISY_DIRECTORIES,
    TEXT_MAX_BYTES,
    AgentPCError,
    safe_relative_path,
    sensitive_path,
)


CONNECTOR_VERSION = "agent-files-connector/v1"
TREE_LIMIT = 500


class ConnectorConfig:
    def __init__(self, payload):
        if not isinstance(payload, dict):
            raise ValueError("Connector config must be a JSON object")
        self.bind = str(payload.get("bind") or "127.0.0.1")
        self.port = int(payload.get("port") or 8765)
        self.token = str(payload.get("token") or "")
        if len(self.token) < 24:
            raise ValueError("Connector token must contain at least 24 characters")
        self.cert_file = str(payload.get("certFile") or "")
        self.key_file = str(payload.get("keyFile") or "")
        self.roots = {}
        for index, row in enumerate(payload.get("roots") or []):
            if not isinstance(row, dict):
                continue
            root_id = re.sub(r"[^a-zA-Z0-9_.-]+", "-", str(row.get("id") or f"root-{index + 1}")).strip("-.")
            path = os.path.realpath(os.path.abspath(os.path.expanduser(str(row.get("path") or ""))))
            if root_id and os.path.isdir(path):
                self.roots[root_id] = {"id": root_id, "label": str(row.get("label") or root_id), "path": path}
        if not self.roots:
            raise ValueError("Connector config must include at least one existing root")

    @classmethod
    def load(cls, filename):
        with open(filename, "r", encoding="utf-8") as handle:
            return cls(json.load(handle))


def resolve_path(config, root_id, relative, *, require_file=False, require_directory=False):
    root = config.roots.get(str(root_id or ""))
    if not root:
        raise AgentPCError("root_not_found", "Approved connector root was not found.", 404)
    rel = safe_relative_path(relative)
    if rel is None or sensitive_path(rel):
        raise AgentPCError("invalid_path", "The requested path is protected.", 403)
    root_real = root["path"]
    full = os.path.realpath(os.path.abspath(os.path.join(root_real, *(rel.split("/") if rel else []))))
    try:
        if os.path.commonpath([root_real, full]) != root_real:
            raise AgentPCError("root_escape", "The requested path leaves the approved root.", 403)
    except ValueError:
        raise AgentPCError("root_escape", "The requested path leaves the approved root.", 403)
    if require_file and not os.path.isfile(full):
        raise AgentPCError("file_not_found", "File was not found.", 404)
    if require_directory and not os.path.isdir(full):
        raise AgentPCError("folder_not_found", "Folder was not found.", 404)
    return root, rel, full


def descriptor_for(config, root_id, relative):
    _root, rel, full = resolve_path(config, root_id, relative, require_file=True)
    extension = os.path.splitext(full)[1].lower()
    kind_info = EXTENSION_KINDS.get(extension)
    if not kind_info:
        raise AgentPCError("unsupported_file", "This file type cannot be previewed.", 415, extension=extension)
    kind, mime_type, language = kind_info
    stat = os.stat(full)
    maximum = MEDIA_MAX_BYTES if kind in {"audio", "video"} else (DOCUMENT_MAX_BYTES if kind in {"image", "pdf"} else TEXT_MAX_BYTES)
    if stat.st_size > maximum:
        raise AgentPCError("file_too_large", "File exceeds the preview size limit.", 413, size=stat.st_size, maxBytes=maximum)
    return full, {
        "schemaVersion": CONNECTOR_VERSION,
        "rootId": str(root_id), "name": os.path.basename(full), "path": rel,
        "kind": kind, "mimeType": mime_type, "language": language,
        "size": stat.st_size, "maxBytes": maximum,
        "modifiedAt": stat.st_mtime,
        "version": f"{stat.st_mtime_ns:x}-{stat.st_size:x}",
    }


class ConnectorHandler(http.server.BaseHTTPRequestHandler):
    server_version = "AgentFilesConnector/1"

    def _authorized(self):
        expected = self.server.connector_config.token
        provided = self.headers.get("X-Agent-Files-Token") or ""
        authorization = str(self.headers.get("Authorization") or "")
        if authorization.lower().startswith("bearer "):
            provided = authorization[7:].strip()
        return bool(provided) and hmac.compare_digest(provided, expected)

    def _json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _error(self, exc):
        if isinstance(exc, AgentPCError):
            return self._json(exc.payload(), exc.status)
        return self._json({"ok": False, "error": {"code": "connector_error", "message": str(exc)}}, 500)

    def do_GET(self):
        if not self._authorized():
            return self._json({"ok": False, "error": {"code": "unauthorized", "message": "Valid connector token required."}}, 401)
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        config = self.server.connector_config
        try:
            if parsed.path == "/v1/health":
                return self._json({"ok": True, "version": CONNECTOR_VERSION, "roots": len(config.roots)})
            if parsed.path == "/v1/roots":
                return self._json({"ok": True, "roots": [
                    {"id": root["id"], "label": root["label"], "online": os.path.isdir(root["path"])}
                    for root in config.roots.values()
                ]})
            root_id = (params.get("rootId") or [""])[0]
            relative = (params.get("path") or [""])[0]
            if parsed.path == "/v1/tree":
                _root, rel, folder = resolve_path(config, root_id, relative, require_directory=True)
                entries = []
                children = sorted(os.scandir(folder), key=lambda item: (not item.is_dir(follow_symlinks=False), item.name.casefold()))
                for entry in children:
                    child_rel = "/".join(value for value in (rel, entry.name) if value)
                    if sensitive_path(child_rel) or (entry.is_dir(follow_symlinks=False) and entry.name.lower() in NOISY_DIRECTORIES):
                        continue
                    try:
                        real = os.path.realpath(entry.path)
                        if os.path.commonpath([config.roots[root_id]["path"], real]) != config.roots[root_id]["path"]:
                            continue
                        is_dir = entry.is_dir(follow_symlinks=True)
                        stat = entry.stat(follow_symlinks=True)
                    except (OSError, ValueError):
                        continue
                    extension = os.path.splitext(entry.name)[1].lower()
                    entries.append({
                        "name": entry.name, "path": child_rel, "type": "directory" if is_dir else "file",
                        "size": 0 if is_dir else stat.st_size, "modifiedAt": stat.st_mtime,
                        "previewable": not is_dir and extension in EXTENSION_KINDS,
                        "kind": "directory" if is_dir else (EXTENSION_KINDS.get(extension) or ("file",))[0],
                    })
                    if len(entries) >= TREE_LIMIT:
                        break
                return self._json({"ok": True, "rootId": root_id, "path": rel, "entries": entries, "truncated": len(entries) >= TREE_LIMIT})
            if parsed.path == "/v1/descriptor":
                _full, descriptor = descriptor_for(config, root_id, relative)
                return self._json({"ok": True, "preview": descriptor})
            if parsed.path == "/v1/content":
                full, descriptor = descriptor_for(config, root_id, relative)
                return self._serve_content(full, descriptor)
            return self._json({"ok": False, "error": {"code": "not_found", "message": "Connector endpoint not found."}}, 404)
        except Exception as exc:
            return self._error(exc)

    def _serve_content(self, full, descriptor):
        size = descriptor["size"]
        start, end, status = 0, max(0, size - 1), 200
        range_header = str(self.headers.get("Range") or "")
        if range_header.startswith("bytes=") and size:
            match = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header)
            if not match:
                self.send_response(416); self.send_header("Content-Range", f"bytes */{size}"); self.end_headers(); return
            first, last = match.groups()
            if first:
                start, end = int(first), int(last) if last else end
            elif last:
                start = size - min(size, int(last))
            if start >= size or start > end:
                self.send_response(416); self.send_header("Content-Range", f"bytes */{size}"); self.end_headers(); return
            end, status = min(end, size - 1), 206
        length = max(0, end - start + 1) if size else 0
        self.send_response(status)
        self.send_header("Content-Type", descriptor["mimeType"])
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        with open(full, "rb") as handle:
            handle.seek(start)
            remaining = length
            while remaining:
                chunk = handle.read(min(64 * 1024, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def log_message(self, fmt, *args):
        sys.stderr.write("[Agent Files Connector] " + fmt % args + "\n")


class ConnectorServer(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, config):
        self.connector_config = config
        super().__init__(address, ConnectorHandler)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Run the read-only My Virtual Office Agent Files Connector")
    parser.add_argument("--config", required=True, help="Path to connector JSON configuration")
    args = parser.parse_args(argv)
    config = ConnectorConfig.load(args.config)
    server = ConnectorServer((config.bind, config.port), config)
    scheme = "http"
    if config.cert_file or config.key_file:
        if not config.cert_file or not config.key_file:
            raise SystemExit("Both certFile and keyFile are required for TLS")
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(config.cert_file, config.key_file)
        server.socket = context.wrap_socket(server.socket, server_side=True)
        scheme = "https"
    print(f"Agent Files Connector listening on {scheme}://{config.bind}:{config.port} ({len(config.roots)} roots)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
