#!/usr/bin/env python3
"""Unit tests for _wf_parse_review_response — the review parser."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

# We can't import server.py directly (side effects), so extract the function
import re as re_module

def _wf_parse_review_response(response_text, checklist):
    """Copy of the fixed parser for isolated testing."""
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
            or re_module.match(r'^\d+[\.\):\s]', line_stripped)
            or "item " in line_lower
        )
        matched_status = None
        for pattern, status_val in status_patterns:
            if pattern in line_lower:
                matched_status = status_val
                break
        if matched_status and (is_review_line or item_idx == 0 or len(checklist) == 1):
            results.append({"id": checklist[item_idx].get("id"), "text": checklist[item_idx].get("text", ""), "status": matched_status})
            item_idx += 1
        elif matched_status and not is_review_line:
            if len(results) > 0:
                results.append({"id": checklist[item_idx].get("id"), "text": checklist[item_idx].get("text", ""), "status": matched_status})
                item_idx += 1
    for i in range(len(results), len(checklist)):
        results.append({"id": checklist[i].get("id"), "text": checklist[i].get("text", ""), "status": "needs_more_work"})
    return results

PASS = "✅"
FAIL = "❌"
results_log = []

def check(name, condition, detail=""):
    status = PASS if condition else FAIL
    results_log.append((name, condition))
    print(f"  {status} {name}" + (f" — {detail}" if detail else ""))

checklist3 = [
    {"id": "a", "text": "Item A"},
    {"id": "b", "text": "Item B"},
    {"id": "c", "text": "Item C"},
]

# Test 1: Standard REVIEW_ITEM format
resp1 = "REVIEW_ITEM_1: PASS\nREVIEW_ITEM_2: NEEDS_MORE_WORK\nREVIEW_ITEM_3: DID_NOT_PASS"
r1 = _wf_parse_review_response(resp1, checklist3)
check("Standard format: item 1 = pass", r1[0]["status"] == "pass")
check("Standard format: item 2 = needs_more_work", r1[1]["status"] == "needs_more_work")
check("Standard format: item 3 = did_not_pass", r1[2]["status"] == "did_not_pass")

# Test 2: DID_NOT_PASS should NOT match "pass" (the critical bug)
resp2 = "REVIEW_ITEM_1: DID_NOT_PASS\nREVIEW_ITEM_2: PASS\nREVIEW_ITEM_3: REQUIRES_USER_REVIEW"
r2 = _wf_parse_review_response(resp2, checklist3)
check("DID_NOT_PASS != pass (critical)", r2[0]["status"] == "did_not_pass", f"got: {r2[0]['status']}")
check("PASS after DID_NOT_PASS", r2[1]["status"] == "pass")
check("REQUIRES_USER_REVIEW", r2[2]["status"] == "requires_user_review")

# Test 3: Numbered format
resp3 = "1. PASS\n2. NEEDS MORE WORK\n3. PASS"
r3 = _wf_parse_review_response(resp3, checklist3)
check("Numbered: 1 = pass", r3[0]["status"] == "pass")
check("Numbered: 2 = needs_more_work", r3[1]["status"] == "needs_more_work")
check("Numbered: 3 = pass", r3[2]["status"] == "pass")

# Test 4: Verbose agent response with extra text
resp4 = """Here's my review:

REVIEW_ITEM_1: PASS - The implementation looks correct
REVIEW_ITEM_2: DID_NOT_PASS - This was not implemented at all
REVIEW_ITEM_3: NEEDS_MORE_WORK - Partially done but has bugs"""
r4 = _wf_parse_review_response(resp4, checklist3)
check("Verbose: 3 results", len(r4) == 3)
check("Verbose: item 1 = pass", r4[0]["status"] == "pass")
check("Verbose: item 2 = did_not_pass", r4[1]["status"] == "did_not_pass")
check("Verbose: item 3 = needs_more_work", r4[2]["status"] == "needs_more_work")

# Test 5: Empty/garbage response defaults to needs_more_work
resp5 = "I couldn't review anything, here's what I found..."
r5 = _wf_parse_review_response(resp5, checklist3)
check("Garbage defaults to needs_more_work", all(r["status"] == "needs_more_work" for r in r5))

# Test 6: Single item checklist
resp6 = "This item PASS the review."
r6 = _wf_parse_review_response(resp6, [{"id": "x", "text": "Solo item"}])
check("Single item: detected pass", r6[0]["status"] == "pass")

# Test 7: All items count matches checklist
check("Result count always matches checklist", len(r1) == 3 and len(r5) == 3)

# Summary
print()
passed = sum(1 for _, ok in results_log if ok)
total = len(results_log)
print(f"  Review Parser: {passed}/{total} passed")
if passed < total:
    for name, ok in results_log:
        if not ok:
            print(f"    {FAIL} {name}")
    sys.exit(1)
else:
    print(f"  {PASS} ALL PARSER TESTS PASSED")
