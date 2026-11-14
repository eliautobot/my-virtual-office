# v0.12 moves: filmstrip sheets (not tests)

Key frames drawn by the real Agent.draw and the real frame sort (desk art, chair, sitter) on a fixture page
(http://office.test, app/ of the tree, 8 fixture agents). Each writes one JPEG; nothing touches a running office.

    PLAYWRIGHT_CORE_PATH=... node tests/sheets_v12_moves/sheet_work.mjs app out.jpg 0,180     # work animations, desk at 0 and 180
    PLAYWRIGHT_CORE_PATH=... node tests/sheets_v12_moves/sheet_work.mjs app out.jpg 90,270    # work animations in profile
    Q=0.5 PLAYWRIGHT_CORE_PATH=... node tests/sheets_v12_moves/sheet_moves.mjs app out.jpg sig-stand   # signature moves standing
    Q=0.36 PLAYWRIGHT_CORE_PATH=... node tests/sheets_v12_moves/sheet_moves.mjs app out.jpg sig-seat   # signature moves seated
    Q=0.5 PLAYWRIGHT_CORE_PATH=... node tests/sheets_v12_moves/sheet_moves.mjs app out.jpg waves       # waves

Q is the JPEG quality (keep sheets under 120 KB).
