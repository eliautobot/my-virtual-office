from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CHAT_JS = (ROOT / "app" / "chat.js").read_text(encoding="utf-8")
INDEX_HTML = (ROOT / "app" / "index.html").read_text(encoding="utf-8")
STYLE_CSS = (ROOT / "app" / "style.css").read_text(encoding="utf-8")


def test_every_chat_window_inherits_a_jump_to_latest_control():
    assert 'class="chat-scroll-latest"' in INDEX_HTML
    assert 'aria-label="Jump to latest message"' in INDEX_HTML
    assert "const panel = primaryPanel.cloneNode(true);" in CHAT_JS
    assert "this.scrollLatestBtn = root.querySelector('.chat-scroll-latest');" in CHAT_JS
    assert "this.scrollLatestBtn?.addEventListener('click', () => this.resumeLatest());" in CHAT_JS


def test_manual_wheel_touch_and_scrollbar_intent_detach_follow_mode():
    assert "this.messages.addEventListener('scroll'" in CHAT_JS
    assert "this.messages.addEventListener('wheel'" in CHAT_JS
    assert "this.messages.addEventListener('touchmove'" in CHAT_JS
    assert "this.messages.addEventListener('pointerdown'" in CHAT_JS
    assert "this.manualScrollDirection < 0 || movedUp" in CHAT_JS
    assert "this.cancelPendingScrollBottom();" in CHAT_JS


def test_true_bottom_and_arrow_race_safely_restore_follow_mode():
    assert "this.manualScrollBottomTarget" in CHAT_JS
    assert "reachedManualBottom" in CHAT_JS
    assert "CHAT_BOTTOM_REATTACH_THRESHOLD" in CHAT_JS
    assert "if (this.followLatest && !nearBottom) this.scrollBottom();" in CHAT_JS
    assert "if (force) scrollToEnd();" in CHAT_JS
    assert "scrollIntoView" not in CHAT_JS
    assert "scrollSettleFrame" in CHAT_JS
    assert "scrollSettleTimer" in CHAT_JS


def test_history_refresh_preserves_paused_position():
    assert "replaceHistoryMessages(renderMessages)" in CHAT_JS
    assert "this.scrollTrackingSuspended = true;" in CHAT_JS
    assert "this.followLatest = !maxScrollTop;" in CHAT_JS
    assert "this.renderHistoryItems" in CHAT_JS


def test_jump_control_layout_and_cache_bust():
    assert ".chat-body {" in STYLE_CSS and "position: relative;" in STYLE_CSS
    assert ".chat-scroll-latest {" in STYLE_CSS
    assert ".chat-scroll-latest[hidden]" in STYLE_CSS
    assert 'style.css?v=' in INDEX_HTML
    assert 'chat.js?v=' in INDEX_HTML
