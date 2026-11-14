"""tests/tools/lab-hermes.sh: the private lab copies are fully offline.

Every profile (the default one AND every profiles/<name>) must answer from the lab's stub model, and no provider key,
token or credential may be copied. Runs the script's `copy` command on a made-up source folder (no Hermes, no ports).
"""
import json
import os
import re
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "tools", "lab-hermes.sh")
KEYS = ("sk-or-v1-fakefakefake0123456789", "sk-ant-fake0123456789abcdef", "ghp_fakefake0123456789",
        "pool-secret-0123456789", "hunter2-not-a-real-one")


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def make_source(root):
    home = os.path.join(root, "home")
    write(os.path.join(home, "config.yaml"),
          "model:\n  default: stub-1\n  provider: custom\n  base_url: http://127.0.0.1:19480/v1\n"
          "  api_key: stub-key-not-secret\n\n_config_version: 50\ndisplay:\n  busy_input_mode: interrupt\n")
    write(os.path.join(home, ".env"), "# keys\nOPENROUTER_API_KEY=%s\nHERMES_TIMEZONE=UTC\n" % KEYS[0])
    write(os.path.join(home, "auth.json"), json.dumps({
        "version": 1, "providers": {}, "updated_at": "x",
        "credential_pool": {"copilot": [{"id": "c1", "access_token": KEYS[3], "secret_fingerprint": "ab"}]}}))
    q = os.path.join(home, "profiles", "quill")
    write(os.path.join(q, "config.yaml"),
          "model:\n  default: google/gemini-3-flash-preview\n  provider: openrouter\n_config_version: 50\n"
          "stt:\n  enabled: false\n")
    write(os.path.join(q, ".env"), "OPENROUTER_API_KEY=%s\n" % KEYS[0])
    write(os.path.join(q, "auth.json"), json.dumps({
        "version": 1, "providers": {}, "updated_at": "x",
        "credential_pool": {"openrouter": [{"id": "o1", "secret_fingerprint": "cd", "source": "env"}]}}))
    s = os.path.join(home, "profiles", "scout")   # no config.yaml at all: must still get the stub
    write(os.path.join(s, ".env"),
          "export ANTHROPIC_API_KEY=%s\nGITHUB_TOKEN=%s\nSUDO_PASSWORD=%s\nSOME_SETTING=on\n" % (KEYS[1], KEYS[2], KEYS[4]))
    r = os.path.join(home, "profiles", "research")
    write(os.path.join(r, "config.yaml"), "model: some-model-name\nterminal:\n  backend: local\n")
    write(os.path.join(root, "fakehome", ".local", "bin", "hermes"), "#!/bin/sh\n")
    write(os.path.join(root, "fakehome", "tool.env"), "OPENAI_API_KEY=%s\n" % KEYS[0])


def run(args, lab, src, port="19580"):
    env = dict(os.environ, LAB=lab, HERMES_LAB_SRC=src, LAB_PORT_STUB=port)
    return subprocess.run(["bash", SCRIPT] + args, env=env, capture_output=True, text=True, timeout=60)


class LabCopyIsOffline(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="vo-hp-lab-")
        self.src = os.path.join(self.tmp.name, "src")
        self.lab = os.path.join(self.tmp.name, "lab")
        make_source(self.src)

    def tearDown(self):
        self.tmp.cleanup()

    def test_every_profile_on_the_stub_and_no_key_copied(self):
        r = run(["copy"], self.lab, self.src)
        self.assertEqual(r.returncode, 0, r.stderr)
        for side in ("a", "b"):
            home = os.path.join(self.lab, side, "home")
            for prof in ("", "profiles/quill", "profiles/scout", "profiles/research"):
                cfg = open(os.path.join(home, prof, "config.yaml"), encoding="utf-8").read()
                model = re.search(r"^model:\n((?:[ \t]+.*\n)+)", cfg, re.M)
                self.assertIsNotNone(model, (side, prof, cfg))
                self.assertIn("base_url: http://127.0.0.1:19580/v1", model.group(1), (side, prof))
                self.assertIn("provider: custom", model.group(1), (side, prof))
                self.assertEqual(cfg.count("model:"), 1, (side, prof, cfg))
                self.assertNotIn("openrouter", cfg, (side, prof))
            # other settings are kept
            self.assertIn("busy_input_mode: interrupt", open(os.path.join(home, "config.yaml")).read())
            self.assertIn("enabled: false", open(os.path.join(home, "profiles/quill/config.yaml")).read())
            self.assertIn("backend: local", open(os.path.join(home, "profiles/research/config.yaml")).read())
            self.assertIn("HERMES_TIMEZONE=UTC", open(os.path.join(home, ".env")).read())
            self.assertIn("SOME_SETTING=on", open(os.path.join(home, "profiles/scout/.env")).read())
            for name in ("auth.json", "profiles/quill/auth.json"):
                j = json.load(open(os.path.join(home, name)))
                self.assertEqual(j["credential_pool"], {}, name)
        # no key, token, password or pooled credential anywhere in either copy
        found = []
        for d, _dirs, files in os.walk(self.lab):
            for n in files:
                text = open(os.path.join(d, n), encoding="utf-8", errors="replace").read()
                found += [(os.path.relpath(os.path.join(d, n), self.lab), k) for k in KEYS if k in text]
                if re.search(r"(?im)^\s*(export\s+)?\w*(API_KEY|TOKEN|PASSWORD)\w*\s*=", text):
                    found.append((n, "key line"))
        self.assertEqual(found, [])
        # the source is read only
        self.assertIn(KEYS[0], open(os.path.join(self.src, "home/profiles/quill/.env")).read())
        self.assertIn("openrouter", open(os.path.join(self.src, "home/profiles/quill/config.yaml")).read())

    def test_custom_stub_port_reaches_every_profile(self):
        r = run(["copy"], self.lab, self.src, port="19581")
        self.assertEqual(r.returncode, 0, r.stderr)
        cfg = open(os.path.join(self.lab, "a/home/profiles/scout/config.yaml")).read()
        self.assertIn("base_url: http://127.0.0.1:19581/v1", cfg)

    def test_restart_needs_a_side_and_a_running_lab(self):
        r = run(["restart", "c"], self.lab, self.src)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("restart a|b", r.stderr)
        r = run(["restart", "a"], self.lab, self.src)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("run start first", r.stderr)
        self.assertFalse(os.path.exists(os.path.join(self.lab, "a.pid")))


if __name__ == "__main__":
    unittest.main()
