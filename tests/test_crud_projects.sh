#!/bin/bash
# CRUD Test Script — Projects & Tasks API
# Run: bash tests/test_crud_projects.sh [base_url]
# Default: http://localhost:8090
set -e
BASE="${1:-http://localhost:8090}"
PASS=0; FAIL=0

echo "CRUD TEST: Projects & Tasks API ($BASE)"
echo "=========================================="

# 1. Create Project
echo -e "\n── TEST 1: Create Project ──"
RESP=$(curl -s -X POST "$BASE/api/projects" \
  -H "Content-Type: application/json" \
  -d '{"title":"QA CRUD Test","description":"Automated CRUD verification","tags":["qa","test"]}')
PROJECT_ID=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['project']['id'])")
COLS=$(echo "$RESP" | python3 -c "import sys,json; print(','.join(c['title'] for c in json.load(sys.stdin)['project']['columns']))")
if echo "$COLS" | grep -q "Backlog.*In Progress.*Review.*Done"; then
  echo "✅ PASS: Project created with 4 columns"; PASS=$((PASS+1))
else echo "❌ FAIL: Columns=$COLS"; FAIL=$((FAIL+1)); fi

BACKLOG=$(echo "$RESP" | python3 -c "import sys,json; [print(c['id']) for c in json.load(sys.stdin)['project']['columns'] if c['title']=='Backlog']")
INPROG=$(echo "$RESP" | python3 -c "import sys,json; [print(c['id']) for c in json.load(sys.stdin)['project']['columns'] if c['title']=='In Progress']")

# 2. Create 2 Tasks
echo -e "\n── TEST 2: Create 2 Tasks ──"
T1=$(curl -s -X POST "$BASE/api/projects/$PROJECT_ID/tasks" -H "Content-Type: application/json" \
  -d "{\"title\":\"Task A\",\"columnId\":\"$BACKLOG\",\"checklist\":[{\"text\":\"A1\",\"done\":false}]}")
T1_ID=$(echo "$T1" | python3 -c "import sys,json; print(json.load(sys.stdin)['task']['id'])")
T2=$(curl -s -X POST "$BASE/api/projects/$PROJECT_ID/tasks" -H "Content-Type: application/json" \
  -d "{\"title\":\"Task B\",\"columnId\":\"$BACKLOG\",\"checklist\":[{\"text\":\"B1\",\"done\":false}]}")
COUNT=$(curl -s "$BASE/api/projects/$PROJECT_ID" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['project']['tasks']))")
if [ "$COUNT" = "2" ]; then echo "✅ PASS: 2 tasks created"; PASS=$((PASS+1))
else echo "❌ FAIL: task count=$COUNT"; FAIL=$((FAIL+1)); fi

# 3. Update Task
echo -e "\n── TEST 3: Update Task ──"
curl -s -X PUT "$BASE/api/projects/$PROJECT_ID/tasks/$T1_ID" -H "Content-Type: application/json" \
  -d '{"title":"Task A UPDATED","priority":"critical"}' > /dev/null
RB=$(curl -s "$BASE/api/projects/$PROJECT_ID" | python3 -c "
import sys,json
for t in json.load(sys.stdin)['project']['tasks']:
  if t['id']=='$T1_ID': print(t['title']+'|'+t.get('priority',''))
")
if [ "$RB" = "Task A UPDATED|critical" ]; then echo "✅ PASS: Update persisted"; PASS=$((PASS+1))
else echo "❌ FAIL: readback=$RB"; FAIL=$((FAIL+1)); fi

# 4. Move Task
echo -e "\n── TEST 4: Move Task ──"
curl -s -X PUT "$BASE/api/projects/$PROJECT_ID/tasks/$T1_ID" -H "Content-Type: application/json" \
  -d "{\"columnId\":\"$INPROG\"}" > /dev/null
COL=$(curl -s "$BASE/api/projects/$PROJECT_ID" | python3 -c "
import sys,json
for t in json.load(sys.stdin)['project']['tasks']:
  if t['id']=='$T1_ID': print(t['columnId'])
")
if [ "$COL" = "$INPROG" ]; then echo "✅ PASS: Task moved"; PASS=$((PASS+1))
else echo "❌ FAIL: col=$COL"; FAIL=$((FAIL+1)); fi

# 5. Delete Project
echo -e "\n── TEST 5: Delete Project ──"
curl -s -X DELETE "$BASE/api/projects/$PROJECT_ID" > /dev/null
FOUND=$(curl -s "$BASE/api/projects" | python3 -c "
import sys,json; ids=[p['id'] for p in json.load(sys.stdin)['projects']]
print('found' if '$PROJECT_ID' in ids else 'gone')
")
if [ "$FOUND" = "gone" ]; then echo "✅ PASS: Project deleted"; PASS=$((PASS+1))
else echo "❌ FAIL: project still exists"; FAIL=$((FAIL+1)); fi

echo -e "\n===================="
echo "RESULTS: $PASS/5 passed, $FAIL failed"
[ $FAIL -eq 0 ] && echo "ALL TESTS PASSED ✅" || echo "SOME TESTS FAILED ❌"
exit $FAIL
