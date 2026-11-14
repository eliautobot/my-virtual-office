from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CHAT_JS = (ROOT / "app" / "chat.js").read_text(encoding="utf-8")
STYLE_CSS = (ROOT / "app" / "style.css").read_text(encoding="utf-8")
INDEX_HTML = (ROOT / "app" / "index.html").read_text(encoding="utf-8")


def test_mobile_chat_does_not_globally_freeze_the_office_page():
    assert "chat-mobile-scroll-locked" not in CHAT_JS
    assert "chat-mobile-scroll-locked" not in STYLE_CSS
    assert "--chat-mobile-scroll-offset" not in STYLE_CSS


def test_mobile_chat_contains_only_boundary_gestures():
    assert "function installMobileChatTouchContainment(root)" in CHAT_JS
    assert "const wouldLeaveSurface" in CHAT_JS
    assert "if (wouldLeaveSurface && event.cancelable) event.preventDefault();" in CHAT_JS
    assert "installMobileChatTouchContainment(this.root);" in CHAT_JS


def test_mobile_chat_keeps_native_scrolling_inside_scroll_surfaces():
    assert "MOBILE_CHAT_SCROLL_SURFACE_SELECTOR" in CHAT_JS
    assert ".chat-messages, .chat-sessions-list, .chat-input" in CHAT_JS
    assert "event.stopPropagation();" in CHAT_JS


def test_mobile_chat_does_not_autofocus_the_composer():
    # Chat windows (2026-11-02): a restore after a reload opens windows without focus too.
    assert "if (focus && !shouldUseSingleWindowMobileLayout()) primaryWindow.input.focus();" in CHAT_JS
    assert "if (focus && !shouldUseSingleWindowMobileLayout()) windowInstance?.input?.focus();" in CHAT_JS


def test_mobile_scroll_region_assets_are_cache_busted_together():
    assert 'style.css?v=' in INDEX_HTML
    assert 'chat.js?v=' in INDEX_HTML
