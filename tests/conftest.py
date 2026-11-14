"""The classic office suites test the office on the legacy provider path (VO_PROVIDER_LAYER=0, 0.10's Python OpenClaw
and Hermes stack, kept for one release) unless the caller sets the flag; the copied OpenClaw + Hermes layer (on by
default in v0.11) has its own suites: tests/test_pl_*.py, tests/test_pl_*.mjs, tests/e2e/pl_*.mjs and
LIFE_PL=1 tests/test_life_e2e.py. Tests of the retired Python modules live in tests/legacy/."""
import os

os.environ.setdefault("VO_PROVIDER_LAYER", "0")
