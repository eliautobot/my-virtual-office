from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
GAME_JS = (ROOT / "app" / "game.js").read_text(encoding="utf-8")
UI_CSS = (ROOT / "app" / "ui-modern.css").read_text(encoding="utf-8")
INDEX_HTML = (ROOT / "app" / "index.html").read_text(encoding="utf-8")


def test_mobile_canvas_reserves_touch_for_office_controls():
    mobile_block = "".join(part.split("\n}\n", 1)[0] for part in UI_CSS.split("@media (max-width: 900px)")[1:])
    assert ".game-wrapper" in mobile_block
    assert "#officeCanvas" in mobile_block
    assert mobile_block.count("touch-action: none;") >= 2


def test_single_finger_mobile_swipe_pans_the_office_camera():
    assert "function mobilePageOwnsSingleFingerCanvasScroll()" not in GAME_JS
    assert "_isPanning = true;" in GAME_JS
    assert "canvas.addEventListener('touchmove', function(e) {\n    e.preventDefault();" in GAME_JS


def test_mobile_canvas_chat_bubble_touch_scroll_remains_available():
    bubble_touch = GAME_JS.split("// Touch scroll on chat bubbles", 1)[1].split("// === LIVE CHAT BUBBLE SYSTEM ===", 1)[0]
    assert "chatTouchBubble = tb;" in bubble_touch
    assert "e.preventDefault();" in bubble_touch


def test_mobile_ui_scroll_assets_are_cache_busted_together():
    assert 'ui-modern.css?v=' in INDEX_HTML
    assert 'game.js?v=' in INDEX_HTML
