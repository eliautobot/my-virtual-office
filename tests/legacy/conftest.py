"""Tests of the Python OpenClaw and Hermes stack that v0.11 retired (openclaw_adapter, openclaw_gateway_client,
openclaw_device, providers/hermes_*): it runs only on the legacy path, VO_PROVIDER_LAYER=0, kept for one release.
With the provider layer on (the default) these files are not collected."""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "app"))
import provider_layer_proxy  # noqa: E402

collect_ignore_glob = ["test_*.py"] if provider_layer_proxy.enabled() else []
