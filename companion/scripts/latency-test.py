# Isolated end-to-end latency test: fixture dirs only, never the real ~/.claude or ~/.codex.
import json, os, subprocess, sys, threading, time, urllib.request, datetime

EXE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "companion", "target", "release", "icue-edge-companion.exe")
root = os.path.join(os.environ.get("TEMP", "."), "icue-edge-companion-latency")
for d in ("local", "claude/projects/demo", "codex/sessions", "appdata"):
    os.makedirs(os.path.join(root, d), exist_ok=True)
log = os.path.join(root, "claude/projects/demo/session.jsonl")
open(log, "w").close()
env = dict(os.environ, LOCALAPPDATA=os.path.join(root, "local"), CLAUDE_CONFIG_DIR=os.path.join(root, "claude"),
           CODEX_HOME=os.path.join(root, "codex"), APPDATA=os.path.join(root, "appdata"))
proc = subprocess.Popen([EXE, "--allow-token"], env=env)
try:
    token = None
    for _ in range(80):
        time.sleep(0.5)
        try:
            token = json.load(open(os.path.join(root, "local/icue-edge-companion/state.json")))["widget_token"]
            break
        except Exception:
            pass
    assert token, "state.json never written"
    arrivals = []
    def listen():
        req = urllib.request.Request("http://127.0.0.1:47821/api/usage/events", headers={"Authorization": "Bearer " + token})
        with urllib.request.urlopen(req, timeout=60) as r:
            for raw in r:
                line = raw.decode()
                if line.startswith("data:"):
                    s = json.loads(line[5:])
                    arrivals.append((time.time(), s["providers"]["claude"]["lastEventAt"]))
    threading.Thread(target=listen, daemon=True).start()
    time.sleep(12)  # past the first discovery
    results = []
    for i in range(8):
        ts = datetime.datetime.now(datetime.timezone.utc)
        ts_ms = int(ts.timestamp() * 1000)
        line = {"type": "assistant", "sessionId": "lat", "entrypoint": "cli", "requestId": f"r{i}", "timestamp": ts.isoformat().replace("+00:00", "Z"),
                "message": {"id": f"m{i}", "model": "test", "usage": {"input_tokens": 1, "output_tokens": 1, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}}}
        written = time.time()
        with open(log, "a") as f:
            f.write(json.dumps(line) + "\n")
        deadline = written + 6
        while time.time() < deadline and not any(le == ts_ms for _, le in arrivals):
            time.sleep(0.02)
        hit = [t for t, le in arrivals if le == ts_ms]
        results.append(round((hit[0] - written) * 1000) if hit else None)
        time.sleep(1.3)
    ok = [r for r in results if r is not None]
    print("latency ms per event:", results)
    print("median %d ms, max %d ms, missed %d" % (sorted(ok)[len(ok) // 2], max(ok), results.count(None)))
finally:
    proc.kill()
