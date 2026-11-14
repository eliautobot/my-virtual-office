"""The office's ids for the provider layer's OpenClaw and Hermes agents (SHARED.md 5.6), and the 0.10 migration handoff.

- ``handoff(layer_data_dir, url, token)``: before the layer starts, the OpenClaw gateway address and token the office
  itself uses (its environment, ``vo-config.json`` or OpenClaw's own settings) go to ``<layer>/.migrate-in.json``
  (0600) for vo-migrate.mjs, which reads and deletes it. Written only until the layer has recorded OpenClaw's migration
  (``<layer>/vo-migrate.json``), so after that no token is handed over again.
- ``OfficeIds``: office id <-> layer agent. Migrated agents keep their office ids (desks, looks, XP, journals and tasks
  stay theirs); agents of a connection added in the layer get one from the layer's key. Read from
  ``GET /api/pl/internal/office-agents`` and kept current by the bus's ``office.agent`` events.
- ``roster_rows(skip)``: office roster rows for the layer's agents the office does not already list.
"""

import http.client
import json
import os
import threading
import time

import private_files

HANDOFF_FILE = ".migrate-in.json"
REPORT_FILE = "vo-migrate.json"
REFRESH_S = 30.0
MISS_REFRESH_S = 5.0


def migrated_sources(layer_data_dir):
    """The sources vo-migrate.mjs has recorded (no secret in that file)."""
    try:
        with open(os.path.join(layer_data_dir, REPORT_FILE), encoding="utf-8") as handle:
            data = json.load(handle)
        return set((data.get("sources") or {}).keys()) if isinstance(data, dict) else set()
    except (OSError, ValueError, AttributeError):
        return set()


def openclaw_connected(layer_data_dir):
    """Whether the migration (or a later adoption) ever made the layer's OpenClaw connection from the office's gateway."""
    try:
        with open(os.path.join(layer_data_dir, REPORT_FILE), encoding="utf-8") as handle:
            data = json.load(handle)
        return bool(((data.get("sources") or {}).get("openclaw") or {}).get("connectionId"))
    except (OSError, ValueError, AttributeError):
        return False


def handoff(layer_data_dir, url, token):
    """Hands OpenClaw's address and token to the layer's migration; True when written. Once the layer has made its
    OpenClaw connection from them, never again; until then (a fresh office: no token at the first start), the gateway
    saved since is adopted at the next start (vo-migrate.mjs adoptOpenClaw)."""
    url, token = str(url or "").strip(), str(token or "").strip()
    if not token or openclaw_connected(layer_data_dir):
        return False
    private_files.private_dir(layer_data_dir)   # (as root: the data folder's owner, like the layer's own files)
    private_files.write_private(os.path.join(layer_data_dir, HANDOFF_FILE),
                                json.dumps({"openclaw": {"url": url, "auth": "token", "token": token}}))
    return True


class OfficeIds:
    """office id <-> layer agent id, for one running layer (thread-safe)."""

    def __init__(self, layer, on_change=None):
        self.layer = layer
        self.on_change = on_change   # () -> None: the office roster should be read again (agents or their state changed)
        self.lock = threading.Lock()
        self.rows = {}        # office id -> row (GET /api/pl/internal/office-agents)
        self.conn_state = {}  # layer connection id -> its last provider.status state
        self.loaded_at = 0.0
        layer.subscribers.append(self.on_event)

    def refresh(self, timeout=1.5):
        if not self.layer or not self.layer.ready():
            return False
        try:
            conn = http.client.HTTPConnection("127.0.0.1", self.layer.port, timeout=timeout)
            conn.request("GET", "/api/pl/internal/office-agents",
                         headers={"X-VO-Principal": self.layer.internal_principal()})
            resp = conn.getresponse()
            body = resp.read()
            conn.close()
            if resp.status != 200:
                return False
            rows = json.loads(body).get("agents") or []
        except (OSError, ValueError, AttributeError, http.client.HTTPException):
            return False
        with self.lock:
            fresh = {str(r["officeId"]): r for r in rows if isinstance(r, dict) and r.get("officeId")}
            changed = not self.loaded_at or _shape(fresh) != _shape(self.rows)
            self.rows = fresh
            self.loaded_at = time.time()
        if changed:
            self._changed()
        return True

    def _changed(self):
        if self.on_change is not None:
            try:
                self.on_change()
            except Exception:
                pass

    def _fresh(self):
        if time.time() - self.loaded_at > REFRESH_S:
            self.refresh()

    def on_event(self, event):
        if isinstance(event, dict) and event.get("type") in ("provider.status", "provider.disconnected"):
            state = "offline" if event["type"] == "provider.disconnected" else str(event.get("state") or "")
            cid = str(event.get("connectionId") or "")
            if state in ("connected", "offline", "error", "pairing") and self.conn_state.get(cid) != state:
                self.conn_state[cid] = state
                self._changed()
            return
        if not isinstance(event, dict) or event.get("type") != "office.agent" or not event.get("officeId"):
            return
        with self.lock:
            row = dict(self.rows.get(str(event["officeId"])) or {})
            row.update({k: event.get(k) for k in ("officeId", "key", "connectionId", "nativeId", "name", "emoji")})
            row["layerId"] = event.get("agentId")
            row["state"] = "retired" if event.get("action") == "retire" else "live"
            self.rows[str(event["officeId"])] = row
        if event.get("action") == "add":
            self.loaded_at = 0.0   # (its connection's kind and label come with the next read)
        self._changed()

    def all(self):
        self._fresh()
        with self.lock:
            return [dict(r) for r in self.rows.values()]

    def layer_id(self, office_id):
        """The layer agent id of an office id, or None."""
        self._fresh()
        with self.lock:
            row = self.rows.get(str(office_id or ""))
            return row.get("layerId") if row else None

    def office_id(self, layer_id):
        """The office id of a layer agent id (or its layer key), or None."""
        self._fresh()
        ref = str(layer_id or "")
        with self.lock:
            for oid, row in self.rows.items():
                if str(row.get("layerId")) == ref or row.get("key") == ref:
                    return oid
        return None

    def office_for(self, connection_id, native):
        """The office id of a connection's agent (its native id: an OpenClaw agent id, a Hermes profile), or None."""
        cid, native = str(connection_id or ""), str(native or "")
        if not cid or not native:
            return None
        for attempt in (0, 1):
            with self.lock:
                for oid, row in self.rows.items():
                    if str(row.get("connectionId")) == cid and str(row.get("nativeId")) == native:
                        return oid
            # (a new agent: its row comes with the next read, at most every few seconds)
            if attempt or time.time() - self.loaded_at < MISS_REFRESH_S or not self.refresh():
                break
        return None

    def of_connection(self, connection_id):
        """The office ids of a connection's live agents."""
        self._fresh()
        cid = str(connection_id or "")
        with self.lock:
            return [oid for oid, row in self.rows.items()
                    if str(row.get("connectionId")) == cid and row.get("state") != "retired"]

    def roster_rows(self, skip=()):
        """Roster rows (the shape of discovery.hermes_serve_rows) for live agents not already listed under their
        office id: a migrated agent keeps the row the office makes for it; a new gateway's agents appear here."""
        skip = {str(x) for x in skip}
        out = []
        for r in self.all():
            oid = str(r.get("officeId") or "")
            if not oid or oid in skip or r.get("state") != "live" or not r.get("enabled", True) \
                    or not r.get("connectionEnabled", True):
                continue
            kind = str(r.get("kind") or "")
            label = {"openclaw": "OpenClaw", "hermes": "Hermes"}.get(kind, kind or "Agent")
            # (its connection's state from the layer's bus; none heard yet: taken as up, so a start never flickers)
            state = str(self.conn_state.get(str(r.get("connectionId"))) or "connected")
            out.append({
                "id": oid, "statusKey": oid, "name": str(r.get("name") or oid), "emoji": str(r.get("emoji") or ""),
                "role": str(r.get("role") or f"{label} agent"), "providerKind": kind, "providerType": "runtime",
                "providerTransport": "layer", "transport": "provider-layer",
                "providerConnectionId": f"pl-{r.get('connectionId')}", "providerAgentId": str(r.get("nativeId") or ""),
                "provider": label, "layerAgentId": r.get("layerId"), "layerKey": r.get("key"),
                "connectionLabel": r.get("connection"), "available": state == "connected", "connectionState": state,
                "apiAvailable": False, "cliAvailable": False, "workspace": "", "home": "",
            })
        return out


def _shape(rows):
    return sorted((oid, r.get("state"), r.get("name"), r.get("emoji"), r.get("enabled"), r.get("connectionEnabled"))
                  for oid, r in rows.items())


_IDS = None


def attach(layer, on_change=None):
    """The id map of the running layer (server.py calls this once the layer exists). ``on_change``: the office roster
    should be read again (the map's first read, an agent added, retired or renamed, a connection up or down)."""
    global _IDS
    _IDS = OfficeIds(layer, on_change) if layer is not None else None
    return _IDS


def ids():
    return _IDS


def roster_rows(skip=()):
    """Layer rows for the office roster; [] while the layer is off or not answering."""
    return _IDS.roster_rows(skip) if _IDS is not None and _IDS.layer.ready() else []
