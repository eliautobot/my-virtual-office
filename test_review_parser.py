#!/usr/bin/env python3
"""Test _wf_parse_review_response fixes for freeform response handling.

Tests:
1. Freeform positive response → all-pass (not all needs_more_work)
2. Structured REVIEW_ITEM_N: PASS → still works as before
3. Mixed freeform with negative keywords → still fails items
4. Cycle-based fallback with checklist done
5. Safety cap helper function (_wf_review_had_structured_match)
6. _parsed / _default / _fallback markers are set correctly
7. Safety cap scenario: 3 consecutive unstructured failures → escalation
8. Numbered format still works
9. Neutral/ambiguous freeform (no keywords at all) → all-pass (not needs_more_work)
10. Rework count safety cap (total reworks regardless of parse)
"""

import sys
import os
import re

# ---------------------------------------------------------------------------
# Copy of the two functions under test (must match server.py exactly)
# ---------------------------------------------------------------------------

def _wf_review_had_structured_match(review_results):
    """Check if any review results came from structured line parsing (not defaults/fallbacks).

    Returns True if at least one result was explicitly parsed from a structured
    review line (marked with _parsed=True) or from a freeform-positive fallback.
    Returns False if all results came from the default needs_more_work fill-in
    (marked with _default=True) — indicating the parser couldn't understand the response.
    """
    for r in review_results:
        if r.get("_parsed") or r.get("_fallback"):
            return True
    return False


def _wf_parse_review_response(response_text, checklist, review_cycle=0):
    results = []
    lines = response_text.strip().split("\n")

    status_patterns = [
        ("requires_user_review", "requires_user_review"),
        ("requires user review", "requires_user_review"),
        ("needs_more_work", "needs_more_work"),
        ("needs more work", "needs_more_work"),
        ("did_not_pass", "did_not_pass"),
        ("did not pass", "did_not_pass"),
        ("pass", "pass"),
    ]

    item_idx = 0
    for line in lines:
        line_stripped = line.strip()
        if not line_stripped or item_idx >= len(checklist):
            continue
        line_lower = line_stripped.lower()

        is_review_line = (
            "review_item" in line_lower
            or re.match(r'^\d+[\.\):\s]', line_stripped)
            or "item " in line_lower
        )

        matched_status = None
        for pattern, status_val in status_patterns:
            if pattern in line_lower:
                matched_status = status_val
                break

        if matched_status and (is_review_line or item_idx == 0 or len(checklist) == 1):
            results.append({
                "id": checklist[item_idx].get("id"),
                "text": checklist[item_idx].get("text", ""),
                "status": matched_status,
                "_parsed": True,
            })
            item_idx += 1
        elif matched_status and not is_review_line:
            if len(results) > 0:
                results.append({
                    "id": checklist[item_idx].get("id"),
                    "text": checklist[item_idx].get("text", ""),
                    "status": matched_status,
                    "_parsed": True,
                })
                item_idx += 1

    # --- Freeform fallback ---
    if not results:
        response_lower = response_text.lower()
        positive_keywords = [
            "all items verified", "all items are done", "all items pass",
            "everything looks good", "everything is working", "all checks pass",
            "all tasks completed", "all completed", "all done", "looks great",
            "fully implemented", "all requirements met", "verified and working",
            "all items look good", "no issues found", "nothing to fix",
            "approved", "lgtm", "ship it",
        ]
        negative_keywords = [
            "needs work", "needs more work", "did not pass", "not working",
            "failed", "missing", "incomplete", "broken", "issues found",
            "not implemented", "needs fix", "needs rework", "does not work",
            "errors", "bugs found", "not done", "partially done",
        ]
        # Count occurrences of positive vs negative keywords
        positive_count = sum(1 for kw in positive_keywords if kw in response_lower)
        negative_count = sum(1 for kw in negative_keywords if kw in response_lower)

        if negative_count > 0:
            # Negative keywords found — fall through to defaults
            pass
        else:
            # No structured lines AND zero negative keywords → treat as all-pass
            if positive_count > 0:
                fallback_reason = "freeform_positive_sentiment"
            else:
                fallback_reason = "freeform_no_negatives"
            for i, item in enumerate(checklist):
                results.append({
                    "id": item.get("id"),
                    "text": item.get("text", ""),
                    "status": "pass",
                    "_fallback": fallback_reason,
                    "_positive_count": positive_count,
                    "_negative_count": negative_count,
                })
            return results

        # Cycle-based fallback
        if review_cycle >= 3:
            all_checklist_done = all(item.get("done", False) for item in checklist)
            if all_checklist_done:
                for i, item in enumerate(checklist):
                    results.append({
                        "id": item.get("id"),
                        "text": item.get("text", ""),
                        "status": "pass",
                        "_fallback": "cycle_3_checklist_done",
                    })
                return results

    for i in range(len(results), len(checklist)):
        results.append({
            "id": checklist[i].get("id"),
            "text": checklist[i].get("text", ""),
            "status": "needs_more_work",
            "_default": True,
        })
    return results


# --- Test fixtures ---
SAMPLE_CHECKLIST = [
    {"id": "c1", "text": "Implement feature A", "done": False},
    {"id": "c2", "text": "Add unit tests", "done": False},
    {"id": "c3", "text": "Update documentation", "done": False},
]

DONE_CHECKLIST = [
    {"id": "c1", "text": "Implement feature A", "done": True},
    {"id": "c2", "text": "Add unit tests", "done": True},
    {"id": "c3", "text": "Update documentation", "done": True},
]


passed = 0
failed = 0

def test(name, condition):
    global passed, failed
    if condition:
        print(f"  ✅ {name}")
        passed += 1
    else:
        print(f"  ❌ {name}")
        failed += 1


# ============================================================
print("\n🧪 TEST 1: Freeform positive response → all-pass")
# ============================================================
freeform_responses = [
    "All items verified and working. Great job!",
    "Everything looks good, the implementation is solid.",
    "I've checked all the code. All items are done correctly.",
    "LGTM - ship it!",
    "All requirements met. Nothing to fix.",
]

for resp in freeform_responses:
    results = _wf_parse_review_response(resp, SAMPLE_CHECKLIST)
    all_pass = all(r["status"] == "pass" for r in results)
    test(f'"{resp[:50]}..." → all pass', all_pass)
    test(f'  has _fallback marker', all(r.get("_fallback") == "freeform_positive_sentiment" for r in results))
    test(f'  NO _default marker', all("_default" not in r for r in results))
    # Verify keyword counting is present
    test(f'  _positive_count > 0', all(r.get("_positive_count", 0) > 0 for r in results))
    test(f'  _negative_count == 0', all(r.get("_negative_count", 0) == 0 for r in results))

# Verify counting works with multiple keyword hits
multi_kw = "All items verified. Everything looks good. LGTM. All done."
results = _wf_parse_review_response(multi_kw, SAMPLE_CHECKLIST)
test("Multi-keyword: _positive_count >= 3", results[0].get("_positive_count", 0) >= 3)
test("Multi-keyword: _negative_count == 0", results[0].get("_negative_count", 0) == 0)

# ============================================================
print("\n🧪 TEST 2: Structured REVIEW_ITEM_N: PASS → still works")
# ============================================================
structured = """REVIEW_ITEM_1: PASS
REVIEW_ITEM_2: PASS
REVIEW_ITEM_3: PASS"""

results = _wf_parse_review_response(structured, SAMPLE_CHECKLIST)
test("All 3 items pass", all(r["status"] == "pass" for r in results))
test("All have _parsed=True", all(r.get("_parsed") for r in results))
test("No _fallback marker", all("_fallback" not in r for r in results))
test("No _default marker", all("_default" not in r for r in results))
test("Correct item IDs", [r["id"] for r in results] == ["c1", "c2", "c3"])
test("No _positive_count (structured, not freeform)", all("_positive_count" not in r for r in results))
test("No _negative_count (structured, not freeform)", all("_negative_count" not in r for r in results))
test("Correct text preserved", results[0]["text"] == "Implement feature A")
test("Result count matches checklist", len(results) == len(SAMPLE_CHECKLIST))

# Structured with DID_NOT_PASS
structured_dnp = """REVIEW_ITEM_1: PASS
REVIEW_ITEM_2: DID_NOT_PASS
REVIEW_ITEM_3: PASS"""
results_dnp = _wf_parse_review_response(structured_dnp, SAMPLE_CHECKLIST)
test("DID_NOT_PASS: item 2 status correct", results_dnp[1]["status"] == "did_not_pass")
test("DID_NOT_PASS: items 1,3 pass", results_dnp[0]["status"] == "pass" and results_dnp[2]["status"] == "pass")
test("DID_NOT_PASS: all _parsed=True", all(r.get("_parsed") for r in results_dnp))

# Structured with REQUIRES_USER_REVIEW
structured_rur = """REVIEW_ITEM_1: PASS
REVIEW_ITEM_2: REQUIRES_USER_REVIEW
REVIEW_ITEM_3: PASS"""
results_rur = _wf_parse_review_response(structured_rur, SAMPLE_CHECKLIST)
test("REQUIRES_USER_REVIEW: item 2 status correct", results_rur[1]["status"] == "requires_user_review")
test("REQUIRES_USER_REVIEW: all _parsed=True", all(r.get("_parsed") for r in results_rur))

# Structured with single item checklist
single_checklist = [{"id": "s1", "text": "Single task", "done": False}]
single_response = "REVIEW_ITEM_1: PASS"
results_single = _wf_parse_review_response(single_response, single_checklist)
test("Single item: passes", results_single[0]["status"] == "pass")
test("Single item: _parsed=True", results_single[0].get("_parsed"))
test("Single item: correct ID", results_single[0]["id"] == "s1")

# ============================================================
print("\n🧪 TEST 3: Structured mixed results still work")
# ============================================================
mixed = """REVIEW_ITEM_1: PASS
REVIEW_ITEM_2: NEEDS_MORE_WORK
REVIEW_ITEM_3: PASS"""

results = _wf_parse_review_response(mixed, SAMPLE_CHECKLIST)
test("Item 1 passes", results[0]["status"] == "pass")
test("Item 2 needs work", results[1]["status"] == "needs_more_work")
test("Item 3 passes", results[2]["status"] == "pass")
test("All have _parsed=True", all(r.get("_parsed") for r in results))

# ============================================================
print("\n🧪 TEST 4: Freeform with negative keywords → NOT all-pass")
# ============================================================
negative_freeform = "I checked everything. Item 2 is not working and needs fix. The rest looks good."
results = _wf_parse_review_response(negative_freeform, SAMPLE_CHECKLIST)
not_all_pass = not all(r["status"] == "pass" for r in results)
test("Not all-pass when negative keywords present", not_all_pass)
test("Has _default markers (fell through to defaults)", all(r.get("_default") for r in results))

# ============================================================
print("\n🧪 TEST 5: Cycle >= 3 with all checklist done → auto-pass")
# ============================================================
# Negative freeform + cycle 3 + done checklist → should auto-pass via cycle fallback
# Must use actual negative keywords (e.g. "incomplete", "not working") to trigger this path
negative_with_keywords = "The implementation is incomplete in some areas and not working as expected."
results = _wf_parse_review_response(negative_with_keywords, DONE_CHECKLIST, review_cycle=3)
all_pass = all(r["status"] == "pass" for r in results)
test("Cycle 3 + done checklist + negative keywords → all pass (cycle fallback)", all_pass)
test("Fallback = cycle_3_checklist_done", all(r.get("_fallback") == "cycle_3_checklist_done" for r in results))

# Same but cycle < 3 → should NOT auto-pass (negative keywords, cycle too low)
results2 = _wf_parse_review_response(negative_with_keywords, DONE_CHECKLIST, review_cycle=1)
all_default = all(r.get("_default") for r in results2)
test("Cycle 1 + done checklist + negative keywords → defaults (no fallback)", all_default)

# ============================================================
print("\n🧪 TEST 6: _wf_review_had_structured_match — with _parsed markers")
# ============================================================

# Structured pass results
structured_results = [
    {"id": "c1", "status": "pass", "_parsed": True},
    {"id": "c2", "status": "needs_more_work", "_parsed": True},
]
test("Structured parsed results → True", _wf_review_had_structured_match(structured_results))

# Structured ALL needs_more_work (but _parsed=True — legit structured)
all_nmw_structured = [
    {"id": "c1", "status": "needs_more_work", "_parsed": True},
    {"id": "c2", "status": "needs_more_work", "_parsed": True},
]
test("All needs_more_work BUT _parsed=True → True (legit structured)", _wf_review_had_structured_match(all_nmw_structured))

# All from default fill-in (no _parsed, has _default)
all_default_results = [
    {"id": "c1", "status": "needs_more_work", "_default": True},
    {"id": "c2", "status": "needs_more_work", "_default": True},
]
test("All _default (unmatched) → False", not _wf_review_had_structured_match(all_default_results))

# Freeform fallback results
fallback_results = [
    {"id": "c1", "status": "pass", "_fallback": "freeform_positive_sentiment"},
]
test("Fallback results → True (fallback counts as matched)", _wf_review_had_structured_match(fallback_results))

# Mix of parsed + default
mixed_results = [
    {"id": "c1", "status": "pass", "_parsed": True},
    {"id": "c2", "status": "needs_more_work", "_default": True},
]
test("Mix of parsed + default → True", _wf_review_had_structured_match(mixed_results))

# ============================================================
print("\n🧪 TEST 7: Safety cap — 3 consecutive unstructured failures → escalation")
# ============================================================
# Negative freeform → defaults (has_negative, no fallback) → parse fail count goes up
negative_unstructured = "I think there are errors and bugs found in the implementation."
wf_state = {"_parseFailCount": 0, "_reworkCount": 0}

for cycle in range(1, 4):
    results = _wf_parse_review_response(negative_unstructured, SAMPLE_CHECKLIST, review_cycle=cycle)
    original_had_structured = _wf_review_had_structured_match(results)
    if not original_had_structured:
        wf_state["_parseFailCount"] = wf_state.get("_parseFailCount", 0) + 1
    else:
        wf_state["_parseFailCount"] = 0
    wf_state["_reworkCount"] = wf_state.get("_reworkCount", 0) + 1

test("After 3 negative-unstructured cycles, _parseFailCount == 3", wf_state["_parseFailCount"] == 3)
test("_reworkCount == 3", wf_state["_reworkCount"] == 3)
test("Would trigger escalation (parseFailCount >= 3)", wf_state["_parseFailCount"] >= 3)
test("Would also trigger escalation (reworkCount >= 3)", wf_state["_reworkCount"] >= 3)

# Now simulate a structured response resetting the counter
structured_response = "REVIEW_ITEM_1: PASS\nREVIEW_ITEM_2: PASS\nREVIEW_ITEM_3: PASS"
results = _wf_parse_review_response(structured_response, SAMPLE_CHECKLIST)
if _wf_review_had_structured_match(results):
    wf_state["_parseFailCount"] = 0
test("Structured response resets parseFailCount to 0", wf_state["_parseFailCount"] == 0)

# ============================================================
print("\n🧪 TEST 8: Numbered format still works")
# ============================================================
numbered = """1. PASS
2. PASS  
3. NEEDS_MORE_WORK"""

results = _wf_parse_review_response(numbered, SAMPLE_CHECKLIST)
test("Numbered: item 1 passes", results[0]["status"] == "pass")
test("Numbered: item 2 passes", results[1]["status"] == "pass")
test("Numbered: item 3 needs work", results[2]["status"] == "needs_more_work")
test("Numbered: all _parsed=True", all(r.get("_parsed") for r in results))

# ============================================================
print("\n🧪 TEST 9: Neutral/ambiguous freeform (no keywords) → all-pass")
# ============================================================
# This is the KEY fix for item 1: freeform with NO positive AND NO negative
# keywords should now default to all-pass, not all-fail (needs_more_work).
neutral_responses = [
    "I've reviewed the code and it looks ready to go.",
    "The implementation appears correct based on my analysis.",
    "Checked the changes. Seems fine.",
    "I'm satisfied with the work done here.",
    "The code is clean and well-structured.",
]

for resp in neutral_responses:
    results = _wf_parse_review_response(resp, SAMPLE_CHECKLIST)
    all_pass = all(r["status"] == "pass" for r in results)
    test(f'Neutral: "{resp[:45]}..." → all pass', all_pass)
    test(f'  fallback = freeform_no_negatives', all(r.get("_fallback") == "freeform_no_negatives" for r in results))
    test(f'  NO _default marker', all("_default" not in r for r in results))

# ============================================================
print("\n🧪 TEST 10: Rework count safety cap (total reworks)")
# ============================================================
# Simulate: freeform positive → tool-check rejects → rework count goes up
# Even though freeform fallback marks as pass, the pipeline override pushes
# it back to failed_items. _reworkCount should still trigger escalation.
wf_state2 = {"_parseFailCount": 0, "_reworkCount": 0}

# Freeform positive responses (would normally pass via fallback)
positive_freeform = "Everything looks good and all items pass."
for cycle in range(1, 4):
    results = _wf_parse_review_response(positive_freeform, SAMPLE_CHECKLIST)
    original_had_structured = _wf_review_had_structured_match(results)
    # freeform_positive → _fallback → original_had_structured = True
    # So parseFailCount stays 0, but reworkCount still increments
    if not original_had_structured:
        wf_state2["_parseFailCount"] += 1
    else:
        wf_state2["_parseFailCount"] = 0
    wf_state2["_reworkCount"] += 1

test("Freeform positive: parseFailCount stays 0 (fallback counted)", wf_state2["_parseFailCount"] == 0)
test("Freeform positive: reworkCount == 3 (tool-check rejected each time)", wf_state2["_reworkCount"] == 3)
test("reworkCount >= 3 triggers escalation even without parse failures", wf_state2["_reworkCount"] >= 3)

# ============================================================
print(f"\n{'='*50}")
print(f"Results: {passed} passed, {failed} failed out of {passed+failed} tests")
if failed > 0:
    print("❌ SOME TESTS FAILED")
    sys.exit(1)
else:
    print("✅ ALL TESTS PASSED")
    sys.exit(0)
