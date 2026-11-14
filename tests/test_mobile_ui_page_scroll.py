from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
UI_CSS = (ROOT / "app" / "ui-modern.css").read_text(encoding="utf-8")
INDEX_HTML = (ROOT / "app" / "index.html").read_text(encoding="utf-8")


def _mobile_block():
    """Every rule inside the compact-layout media blocks (phones and narrow tablets)."""
    return "".join(part.split("\n}\n", 1)[0] for part in UI_CSS.split("@media (max-width: 900px)")[1:])


def test_compact_layout_is_an_app_shell_without_page_scroll():
    # v0.8: top bar + canvas + action bar + dashboard bottom sheet. The page never scrolls;
    # the sheet, menus and windows scroll inside themselves.
    mobile = _mobile_block()
    assert "html,\n  body {\n    width: 100%;\n    height: 100%;\n    overflow: hidden;" in mobile
    assert ".vo-actionbar {\n    position: fixed;" in mobile
    assert ".sidebar.vo-sidebar,\n  .sidebar.vo-sidebar.collapsed {\n    position: fixed;" in mobile


def test_dashboard_sheet_owns_native_vertical_gestures():
    mobile = _mobile_block()
    sheet = mobile.split(".sidebar.vo-sidebar,\n  .sidebar.vo-sidebar.collapsed {", 1)[1].split("}", 1)[0]
    assert "touch-action: pan-y;" in sheet
    assert ".vo-sidebar-scroll {\n    padding-bottom: var(--vo-space-6);\n    touch-action: pan-y;" in mobile
    # the drag handle and sheet header are dragged by script, not scrolled by the browser
    assert ".vo-sheet-grab {" in mobile and "touch-action: none;" in mobile.split(".vo-sheet-grab {", 1)[1].split("}", 1)[0]


def test_sheet_has_peek_half_and_full_states():
    mobile = _mobile_block()
    assert "--vo-sheet-peek: 40px;" in mobile
    assert "body.vo-sheet-half {\n    --vo-sheet-h: 58dvh;" in mobile
    assert "body.vo-sheet-full {" in mobile
    assert "data-vo-sheet-grab" in INDEX_HTML
    assert 'class="vo-actionbar"' in INDEX_HTML
