"""Print the results of one browser suite. usage: report.py <results.jsonl> <suite>; exit 1 on failure."""
import json
import sys

path, suite = sys.argv[1], sys.argv[2]
rows, done, errors = [], False, []
try:
    for line in open(path, encoding="utf-8"):
        if not line.strip():
            continue
        r = json.loads(line)
        if r.get("done"):
            done, errors = True, r.get("errors") or []
        else:
            rows.append(r)
except FileNotFoundError:
    pass
fails = [r for r in rows if not r["ok"]]
for r in rows:
    print(f"  {'PASS' if r['ok'] else 'FAIL'}  [{suite}/{r.get('phase', '')}] {r['name']}" + (f"\n        -> {r['msg']}" if not r["ok"] else ""))
if not done:
    print(f"  FAIL  [{suite}] suite did not finish (timeout or crash)")
if errors:
    print(f"  page errors: {errors}")
print(f"== {suite}: {len(rows) - len(fails)}/{len(rows)} passed{'' if done else ', INCOMPLETE'}")
sys.exit(0 if done and not fails else 1)
