"""v0.11 relfix: docs/UPDATING.md tells 0.11's OpenClaw pairing story (the layer: Agent Providers, the device in
provider-layer/next.db sealed with provider-layer.key, backed up together), not 0.10.1's openclaw-device.json card,
and the words it quotes are the ones the office shows.
"""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOC = (ROOT / "docs" / "UPDATING.md").read_text(encoding="utf-8")
AP_JS = (ROOT / "app" / "provider-layer" / "client" / "js" / "ui" / "agent-providers.js").read_text(encoding="utf-8")


def section(title):
    start = DOC.index(title)
    nxt = DOC.find("\n## ", start + len(title))
    return DOC[start:nxt if nxt > 0 else len(DOC)]


class UpdatingDoc(unittest.TestCase):
    def test_backup_section_keeps_layer_and_key_together(self):
        backup = section("## 1. Back up your data first")
        for word in ("provider-layer/", "provider-layer.key", "together"):
            self.assertIn(word, backup)

    def test_pairing_section_describes_the_layer(self):
        pairing = section("## OpenClaw in Docker or on another computer")
        layer, _, legacy = pairing.partition("With `VO_PROVIDER_LAYER=0`")
        self.assertTrue(legacy, "the 0.10 path is described after its own heading line")
        for word in ("Agent Providers", "provider-layer/next.db", "provider-layer.key", "Back\n  up both together",
                     "host.docker.internal", "2026.7", "devices approve", "My Virtual Office"):
            self.assertIn(word, layer)
        # (0.10's file appears in the 0.11 part only as what is taken over once)
        for m in re.finditer(r"openclaw-device\.json", layer):
            self.assertIn("is taken over once", " ".join(layer[m.start():m.start() + 80].split()))
        self.assertNotIn("Device: Paired with OpenClaw", layer, "0.10.1's card")
        self.assertIn("openclaw-device.json", legacy)

    def test_quoted_words_are_the_offices(self):
        self.assertIn("Waiting for approval", AP_JS)
        self.assertIn("openclaw devices approve ${esc(st.requestId)}", AP_JS)
        self.assertIn("`Connected · ${k.label} ${st.version}`", AP_JS)
        self.assertIn('"Connected ·\n   OpenClaw" with OpenClaw\'s version', DOC)
        self.assertIn('data-copy="openclaw devices approve', AP_JS, "the Copy button the doc mentions")

    def test_no_em_dashes(self):
        self.assertNotIn("—", DOC)


if __name__ == "__main__":
    unittest.main()
