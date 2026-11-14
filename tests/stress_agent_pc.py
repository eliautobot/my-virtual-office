#!/usr/bin/env python3
"""Repeatable Agent PC load test for filesystem, SQLite, and Saved storage."""

from __future__ import annotations

import json
import sys
import tempfile
import threading
import time
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
APP_ROOT = PROJECT_ROOT / "app"
if str(APP_ROOT) not in sys.path:
    sys.path.insert(0, str(APP_ROOT))

from agent_pc import AgentPCStore, TREE_LIMIT  # noqa: E402


def timed(metrics, name, operation):
    started = time.perf_counter()
    result = operation()
    metrics[name] = round((time.perf_counter() - started) * 1000, 2)
    return result


def main():
    metrics = {}
    with tempfile.TemporaryDirectory(prefix="vo-agent-pc-stress-") as temporary:
        root = Path(temporary)
        workspace = root / "workspace"
        workspace.mkdir()
        for index in range(750):
            (workspace / f"resource-{index:04}.md").write_text(f"# Resource {index}\n", encoding="utf-8")

        store = AgentPCStore(root / "data", recent_limit=100)
        store.ensure_profile({
            "id": "stress-agent", "statusKey": "stress-agent", "name": "Stress Agent",
            "providerKind": "test", "providerAgentId": "stress-agent", "workspace": str(workspace),
        })

        listing = timed(metrics, "tree_750_files_ms", lambda: store.list_tree(
            "stress-agent", "home", home_path=str(workspace),
        ))
        assert len(listing["entries"]) == TREE_LIMIT and listing["truncated"]

        errors = []
        worker_count = 16
        touches_per_worker = 250

        def activity_worker(worker_index):
            try:
                for touch in range(touches_per_worker):
                    resource = (worker_index * touches_per_worker + touch) % 160
                    store.record_activity("stress-agent", {
                        "kind": "file", "path": f"resource-{resource:04}.md",
                        "toolName": "write" if touch % 3 == 0 else "read",
                        "runId": f"run-{worker_index}",
                    }, home_path=str(workspace))
            except Exception as exc:  # pragma: no cover - asserted below
                errors.append(repr(exc))

        def run_activity_workers():
            threads = [threading.Thread(target=activity_worker, args=(index,)) for index in range(worker_count)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()

        timed(metrics, "activity_4000_concurrent_upserts_ms", run_activity_workers)
        assert not errors, errors
        activity = store.list_activity("stress-agent")
        assert len(activity) == 100
        assert sum(row["touchCount"] for row in activity) <= worker_count * touches_per_worker

        saved_ids = []

        def save_duplicates():
            for _ in range(64):
                saved_ids.append(store.save_item("stress-agent", {
                    "kind": "file", "rootId": "home", "path": "resource-0000.md",
                }, home_path=str(workspace))["savedId"])

        timed(metrics, "save_64_deduplicated_snapshots_ms", save_duplicates)
        assert len(list((root / "data" / "saved").iterdir())) == 1
        timed(metrics, "delete_64_saved_rows_ms", lambda: [store.delete_saved("stress-agent", saved_id) for saved_id in saved_ids])
        assert not list((root / "data" / "saved").iterdir())

        state = {
            "section": "preview",
            "tabs": [{"rootId": "home", "path": f"resource-{index:04}.md"} for index in range(20)],
        }
        timed(metrics, "persist_20_tab_state_ms", lambda: store.set_ui_state("stress-agent", state))
        reopened = AgentPCStore(root / "data", recent_limit=100)
        assert reopened.get_ui_state("stress-agent") == state

    report = {
        "ok": True,
        "treeLimit": TREE_LIMIT,
        "concurrentWorkers": worker_count,
        "activityTouches": worker_count * touches_per_worker,
        "recentRowsRetained": 100,
        "savedCopies": 64,
        "metrics": metrics,
    }
    print(json.dumps(report, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
