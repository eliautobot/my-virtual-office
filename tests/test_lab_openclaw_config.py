"""tests/tools/lab-openclaw.sh writes a config the installed OpenClaw accepts, old or new.

OpenClaw 2026.11.x refuses the old `agents.list` ("moved to keyed agents.entries") and wants agents.entries +
agents.ownership="explicit" + agents.defaults.systemAgent; older builds know only agents.list. The script asks the
installed build's own config schema. Here: fake builds (one per schema shape, one without a schema command) check the
choice and the written shape; with LAB_OC_BINS=<openclaw>:<openclaw>... each real build also validates the config
(`openclaw config validate`, in the lab's own HOME / state / config, never a real ~/.openclaw).
Run: python3 -m pytest -q tests/test_lab_openclaw_config.py   (LAB_OC_BINS optional)
"""
import json
import os
import stat
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "tools", "lab-openclaw.sh")

FAKE = """#!/bin/sh
case "$1" in
  --version) echo "OpenClaw {version} (fake)" ;;
  config) [ "$2" = schema ] && {schema} ;;
  *) exit 2 ;;
esac
"""
BROWSER = ',\"browser\":{\"properties\":{\"profiles\":{\"additionalProperties\":{\"properties\":{\"cdpUrl\":{},\"attachOnly\":{}%s}}}}}'
SCHEMA_ENTRIES = "echo '{\"properties\":{\"agents\":{\"properties\":{\"defaults\":{},\"entries\":{},\"ownership\":{}}}%s}}'" % (BROWSER % "")
SCHEMA_LIST = "echo '{\"properties\":{\"agents\":{\"properties\":{\"defaults\":{},\"list\":{}}}%s}}'" % (BROWSER % ',\"color\":{}')
NO_SCHEMA = "{ echo 'error: unknown command schema' >&2; exit 1; }"


class LabOpenClawConfig(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="lab-oc-config-")
        self.addCleanup(self.tmp.cleanup)

    def fake(self, name, version, schema):
        path = os.path.join(self.tmp.name, name)
        with open(path, "w") as handle:
            handle.write(FAKE.replace("{version}", version).replace("{schema}", schema))
        os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR)
        return path

    def run_script(self, bin_path, *args, lab="lab", **extra):
        env = dict(os.environ, LAB=os.path.join(self.tmp.name, lab), OPENCLAW_BIN=bin_path,
                   LAB_OC_PORT="18940", LAB_OC_STUB="18941")
        env.pop("LAB_OC_AGENTS", None)
        env.pop("LAB_OC_KEEP_CONFIG", None)
        env.update(extra)
        return subprocess.run([SCRIPT, *args], env=env, capture_output=True, text=True, timeout=120)

    def config(self, bin_path, lab="lab", **extra):
        out = self.run_script(bin_path, "config", lab=lab, **extra)
        self.assertEqual(out.returncode, 0, out.stderr)
        with open(os.path.join(self.tmp.name, lab, "home", ".openclaw", "openclaw.json")) as handle:
            return json.load(handle), out.stdout

    def test_new_schema_gets_keyed_entries(self):
        conf, said = self.config(self.fake("oc-new", "2026.11.2", SCHEMA_ENTRIES))
        agents = conf["agents"]
        self.assertNotIn("list", agents)
        self.assertEqual(sorted(agents["entries"]), ["main", "ops"])
        self.assertEqual(agents["entries"]["ops"]["name"], "Ops")
        self.assertNotIn("id", agents["entries"]["main"])
        self.assertEqual(agents["ownership"], "explicit")
        self.assertEqual(agents["defaults"]["systemAgent"], {"agentId": "main"})
        self.assertEqual(agents["defaults"]["model"], {"primary": "stub/stub-1"})
        self.assertEqual(conf["gateway"]["port"], 18940)
        self.assertIn("2026.11.2", said)
        self.assertIn("shape: entries", said)

    def test_old_schema_and_no_schema_get_the_list(self):
        for name, schema in (("oc-old", SCHEMA_LIST), ("oc-older", NO_SCHEMA)):
            conf, said = self.config(self.fake(name, "2026.7.1", schema), lab="lab-" + name)
            self.assertEqual([a["id"] for a in conf["agents"]["list"]], ["main", "ops"], name)
            self.assertNotIn("entries", conf["agents"])
            self.assertNotIn("ownership", conf["agents"])
            self.assertIn("shape: list", said)

    def test_browser_profile_keys_follow_the_schema(self):
        # (2026.11 refuses a browser profile "color"; 2026.7 lists it): written only when the schema has it
        cdp = {"LAB_OC_BROWSER_CDP_URL": "http://127.0.0.1:18950"}
        conf, _ = self.config(self.fake("oc-new", "2026.11.2", SCHEMA_ENTRIES), **cdp)
        self.assertEqual(conf["browser"]["profiles"]["openclaw"], {"cdpUrl": "http://127.0.0.1:18950", "attachOnly": True})
        conf, _ = self.config(self.fake("oc-old", "2026.7.35", SCHEMA_LIST), lab="lab-old", **cdp)
        self.assertEqual(conf["browser"]["profiles"]["openclaw"]["color"], "#FF4500")

    def test_override_and_keep(self):
        new = self.fake("oc-new", "2026.11.2", SCHEMA_ENTRIES)
        conf, _ = self.config(new, LAB_OC_AGENTS="list")
        self.assertIn("list", conf["agents"])
        path = os.path.join(self.tmp.name, "lab", "home", ".openclaw", "openclaw.json")
        with open(path, "w") as handle:
            json.dump({"kept": True}, handle)
        conf, said = self.config(new, LAB_OC_KEEP_CONFIG="1")
        self.assertEqual(conf, {"kept": True})
        self.assertIn("keeping", said)
        self.assertEqual(self.run_script(new, "shape").stdout.split(), ["2026.11.2", "entries"])

    def test_real_builds_accept_the_config(self):
        bins = [b for b in os.environ.get("LAB_OC_BINS", "").split(":") if b]
        if not bins:
            self.skipTest("LAB_OC_BINS not set (real openclaw builds to validate against)")
        for i, bin_path in enumerate(bins):
            lab = f"real{i}"
            conf, said = self.config(bin_path, lab=lab, LAB_OC_BROWSER_CDP_URL="http://127.0.0.1:18950")
            self.assertIn("browser", conf)
            out = self.run_script(bin_path, "cli", "config", "validate", lab=lab)
            self.assertIn("Config valid", out.stdout + out.stderr, f"{bin_path}: {said} {out.stdout[-400:]} {out.stderr[-400:]}")
            print(f"  {said.strip().splitlines()[0]} -> valid")


if __name__ == "__main__":
    unittest.main()
