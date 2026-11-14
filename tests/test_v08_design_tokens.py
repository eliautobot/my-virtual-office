"""v0.8 design system guards: one palette source, self-hosted fonts, stable hooks."""
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "app"
TOKENS = (APP / "ui-tokens.css").read_text(encoding="utf-8")
THEMES_JS = (APP / "ui-themes.js").read_text(encoding="utf-8")
INDEX = (APP / "index.html").read_text(encoding="utf-8")

TOKEN_FOR_KEY = {
    "bg0": "--vo-surface-0", "bg1": "--vo-surface-1", "bg2": "--vo-surface-2", "bg3": "--vo-surface-3",
    "text1": "--vo-text-1", "text2": "--vo-text-2", "text3": "--vo-text-3",
    "accent": "--vo-accent", "accent2": "--vo-accent-2", "accentContrast": "--vo-accent-ink",
    "borderSoft": "--vo-border-subtle", "borderStrong": "--vo-border-strong",
    "info": "--vo-info", "success": "--vo-success", "warning": "--vo-warning", "danger": "--vo-danger",
}
PRESETS = ("classic", "retro", "cyberpunk", "gameboy")


def css_palette(preset, mode):
    pattern = r'html\[data-ui-preset="%s"\]\[data-ui-theme="%s"\][^{]*\{([^}]*)\}' % (preset, mode)
    match = re.search(pattern, TOKENS)
    assert match, f"no {preset}/{mode} palette in ui-tokens.css"
    return dict(re.findall(r"(--vo-[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})", match.group(1)))


def js_palette(preset, mode):
    block = THEMES_JS.split("var palettes = {", 1)[1]
    block = block.split(f"{preset}: {{", 1)[1]
    block = block.split(f"{mode}: {{", 1)[1].split("}", 1)[0]
    return dict(re.findall(r"(\w+):'(#[0-9a-fA-F]{6})'", block))


def _lum(hex_color):
    def channel(v):
        v = int(v, 16) / 255
        return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
    h = hex_color.lstrip("#")
    r, g, b = (channel(h[i:i + 2]) for i in (0, 2, 4))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def _ratio(a, b):
    x, y = _lum(a), _lum(b)
    return (max(x, y) + 0.05) / (min(x, y) + 0.05)


def test_js_custom_theme_seed_matches_css_tokens():
    for preset in PRESETS:
        for mode in ("dark", "light"):
            css = css_palette(preset, mode)
            js = js_palette(preset, mode)
            for key, token in TOKEN_FOR_KEY.items():
                assert key in js, f"{preset}/{mode} JS palette is missing {key}"
                assert js[key].lower() == css[token].lower(), f"{preset}/{mode} {key}: JS {js[key]} != CSS {css[token]}"


def test_every_palette_meets_wcag_aa():
    for preset in PRESETS:
        for mode in ("dark", "light"):
            c = css_palette(preset, mode)
            for text in ("--vo-text-1", "--vo-text-2", "--vo-text-3"):
                for surface in ("--vo-surface-0", "--vo-surface-1", "--vo-surface-2", "--vo-surface-3"):
                    assert _ratio(c[text], c[surface]) >= 4.5, f"{preset}/{mode} {text} on {surface}"
            assert _ratio(c["--vo-accent-ink"], c["--vo-accent"]) >= 4.5, f"{preset}/{mode} accent ink"
            for surface in ("--vo-surface-1", "--vo-surface-2"):
                assert _ratio(c["--vo-accent"], c[surface]) >= 4.5, f"{preset}/{mode} accent text on {surface}"
                assert _ratio(c["--vo-border-strong"], c[surface]) >= 3, f"{preset}/{mode} strong border on {surface}"


def test_fonts_are_self_hosted():
    assert "fonts.googleapis.com" not in INDEX
    assert "fonts.googleapis.com" not in (APP / "style.css").read_text(encoding="utf-8")
    for name in ("PressStart2P-latin.woff2", "Inter-latin.woff2", "OFL-Inter.txt", "OFL-PressStart2P.txt"):
        assert (APP / "fonts" / name).is_file(), name
    # v0.10.1 I7: versioned (?v=) so the server can serve them immutable
    assert re.search(r'url\("fonts/PressStart2P-latin\.woff2(\?v=[^"]*)?"\)', TOKENS)
    assert re.search(r'url\("fonts/Inter-latin\.woff2(\?v=[^"]*)?"\)', TOKENS)


def test_tokens_load_first_and_auth_loads_early():
    head = INDEX.split("</head>", 1)[0]
    sheets = re.findall(r'<link rel="stylesheet" href="([^"?]+)', head)
    assert sheets[0] == "ui-tokens.css"
    assert head.index("vo-auth.js") < head.index("ui-tokens.css")


def test_index_keeps_hooks_other_scripts_use():
    ids = [
        "officeCanvas", "main-menu-panel", "btn-main-menu", "btn-edit-office", "btn-save-edits", "btn-undo-edit",
        "btn-agent-settings", "sms-toggle", "browser-toggle", "chat-toggle", "sidebar", "sidebar-edge",
        "sidebar-edge-arrow", "brand-title", "count-working", "count-idle", "count-meeting", "count-break",
        "branch-sections-container", "sidebar-projects-list", "sidebar-projects-lb", "sidebar-mtg-active", "log-list",
        "pc-monitor-body", "pc-toggle-arrow", "pc-status-dot", "pc-cpu-val", "pc-cpu-bar", "pc-cpu-graph",
        "pc-cpu-detail", "pc-ram-val", "pc-ram-bar", "pc-ram-graph", "pc-ram-detail", "pc-gpus-container",
        "api-usage-body", "api-toggle-arrow", "api-status-dot", "api-usage-cards", "voAccessSettings",
        "mm-office-name", "mm-ap-openclaw-list", "mm-ap-hermes-list", "mm-pcmetrics-enable", "mm-apiusage-enable",
        "mm-browser-enable", "mm-import-file", "chat-panel", "chat-close", "sms-panel", "browser-panel",
    ]
    for element_id in ids:
        assert f'id="{element_id}"' in INDEX, element_id
    assert INDEX.count('class="toolbar vo-dock"') == 1
    assert 'class="sidebar vo-sidebar"' in INDEX
    assert 'class="game-wrapper"' in INDEX


def test_no_links_wrap_buttons_and_close_controls_are_buttons():
    assert not re.search(r"<a [^>]*>\s*<button", INDEX)
    assert 'class="close-btn" onclick' not in INDEX.replace('type="button" class="close-btn"', "")
    assert "<span class=\"close-btn\"" not in INDEX
    assert "<h4 onclick" not in INDEX
    assert 'class="bio-toggle" onclick' not in INDEX


def test_icon_sprite_has_every_symbol_used():
    used = set(re.findall(r'href="#i-([a-z]+)"', INDEX))
    defined = set(re.findall(r'<symbol id="i-([a-z]+)"', INDEX))
    js_used = set(re.findall(r"icon\('([a-z]+)'", (APP / "ui-modern.js").read_text(encoding="utf-8")))
    assert used <= defined, used - defined
    assert js_used <= defined, js_used - defined


def test_window_helpers_contract_c3_is_exposed():
    js = (APP / "ui-modern.js").read_text(encoding="utf-8")
    for name in ("openWindow", "closeWindow", "showUpsell", "toast", "confirm", "prompt"):
        assert f"{name}:" in js.split("window.VOUI = Object.assign", 1)[1], name
    assert "observe(document.body, { childList: true, subtree: true" not in js
