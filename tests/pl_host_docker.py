"""C1 Docker acceptance (not in the offline suite): the image's office, with VO_PROVIDER_LAYER=1, reaches a lab OpenClaw
gateway over the Docker bridge, pairs, lists the lab agents, answers one turn and opens the layer's socket.

  LAB=/tmp/x/oclab LAB_OC_PORT=<p> LAB_OC_STUB=<p+1> LAB_OC_BIND=172.17.0.1 tests/tools/lab-openclaw.sh start
  docker build -t vo-pl-test:c1 app && docker run -d --name vo-pl-test-c1 -p 127.0.0.1:<o>:8090 -e VO_PROVIDER_LAYER=1 vo-pl-test:c1
  LAB=/tmp/x/oclab LAB_OC_URL=ws://172.17.0.1:<p> python3 tests/pl_host_docker.py <o>
  docker rm -f vo-pl-test-c1 && docker rmi vo-pl-test:c1
"""
import http.client, json, os, subprocess, sys, time
BASE_PORT = int(sys.argv[1]); LAB = os.environ["LAB"]; URL = os.environ["LAB_OC_URL"]
TOOLS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tools", "lab-openclaw.sh")
def req(m, p, body=None):
    c = http.client.HTTPConnection("127.0.0.1", BASE_PORT, timeout=60)
    c.request(m, p, body=json.dumps(body) if body is not None else None, headers={"Content-Type": "application/json"} if body is not None else {})
    r = c.getresponse(); raw = r.read(); c.close()
    try: return r.status, json.loads(raw)
    except ValueError: return r.status, raw[:200]
end = time.time() + 60
while time.time() < end:
    try:
        s, h = req("GET", "/health")
        if s == 200 and (h.get("providerLayer") or {}).get("running"): break
    except OSError: pass
    time.sleep(1)
print("health", s, json.dumps(h.get("providerLayer")))
s, me = req("GET", "/api/pl/me"); print("me", s, me.get("role"), me.get("via"))
token = open(os.path.join(LAB, "token")).read().strip()
s, conn = req("POST", "/api/connections", {"kind": "openclaw", "label": "Lab", "scope": "installation", "config": {"url": URL, "auth": "token", "access": "full"}, "secrets": {"token": token}})
print("connection", s, conn.get("id")); cid = conn["id"]
def prov():
    return next(p for p in req("GET", "/api/agent-providers")[1]["providers"] if p["id"] == cid)
state, end = None, time.time() + 60
while time.time() < end:
    state = (prov().get("status") or {}).get("state")
    if state in ("pairing", "connected"): break
    time.sleep(0.5)
print("state", state)
if state == "pairing":
    out = subprocess.run([TOOLS, "cli", "devices", "list", "--json"], capture_output=True, text=True, timeout=90)
    rid = json.loads(out.stdout)["pending"][-1]["requestId"]
    subprocess.run([TOOLS, "cli", "devices", "approve", rid], capture_output=True, text=True, timeout=90, check=True)
    print("approved", rid)
end = time.time() + 90
while time.time() < end:
    p = prov()
    if (p.get("status") or {}).get("state") == "connected" and len(p.get("agents") or []) >= 2: break
    time.sleep(0.5)
print("connected agents", {a["nativeId"]: a["name"] for a in p["agents"]})
agent = next(a["id"] for a in p["agents"] if a["nativeId"] == "main")
s, sess = req("POST", "/api/chat-sessions/create", {"agent": agent, "label": "docker"})
s, run = req("POST", "/api/providers/runs", {"agent": agent, "session": sess["session"]["id"], "input": "hello from the image"})
since, events, end = 0, [], time.time() + 90
while time.time() < end:
    s, out = req("GET", f"/api/providers/runs/events?run={run['runId']}&since={since}")
    for e in out.get("events") or []: events.append(e["event"]); since = max(since, e["seq"])
    if out.get("done"): break
    time.sleep(0.3)
last = [e for e in events if e["type"] == "run.end"][-1]
print("turn", last["status"], "stub reply" in json.dumps(events))
from websockets.sync.client import connect
with connect(f"ws://127.0.0.1:{BASE_PORT}/api/pl/ws", open_timeout=10) as ws:
    print("ws hello", json.loads(ws.recv(timeout=10)).get("t"))
