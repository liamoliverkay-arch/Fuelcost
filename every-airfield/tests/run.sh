#!/bin/bash
# Every Airfield end-to-end tests.  usage: tests/run.sh [server] [desktop] [dark] [phone] [noapi]   (default: all)
# Needs python3 and firefox. Each browser suite gets a fresh Firefox profile, its own test server on a
# free port and an empty price store; output lands in tests/out/<suite>/. Headless Firefox ignores
# --window-size when given a URL, so desktop suites run at its default 1366x682 viewport (the suite
# records the size) and the phone suite runs the app inside a 390x844 iframe at device pixel ratio 2.
T=$(cd "$(dirname "$0")" && pwd); SITE=$(dirname "$T"); OUT=${QA_OUT:-$T/out}
SUITES=${*:-server desktop dark phone noapi}
TIMEOUT=${QA_TIMEOUT:-600}
status=0; set -o pipefail
freeport() { python3 -I -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }

for s in $SUITES; do
  echo "### $s"
  if [ "$s" = server ]; then python3 -I "$T/test_server.py" "$SITE" 2>&1 | grep -E '\.\.\. |^Ran|^OK|^FAILED' || status=1; continue; fi
  D=$OUT/$s; rm -rf "$D"; mkdir -p "$D/prof"
  URL="index.html?suite=$s#home"; APIFAIL=0
  cat > "$D/prof/user.js" <<'EOF'
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("geo.provider.use_geoclue", false);
user_pref("geo.provider.use_gpsd", false);
user_pref("geo.provider.testing", true);
user_pref("geo.prompt.testing", true);
user_pref("geo.provider.network.url", "data:application/json,{\"location\":{\"lat\":34.05,\"lng\":-118.25},\"accuracy\":50}");
EOF
  case $s in
    desktop) echo 'user_pref("geo.prompt.testing.allow", true); user_pref("permissions.default.geo", 1);' >> "$D/prof/user.js" ;;
    dark)    echo 'user_pref("layout.css.prefers-color-scheme.content-override", 0); user_pref("ui.systemUsesDarkTheme", 1);' >> "$D/prof/user.js" ;;
    phone)   URL="__frame?suite=phone&w=390&h=844"   # app in a 390x844 iframe at device pixel ratio 2
             echo 'user_pref("layout.css.devPixelsPerPx", "2.0"); user_pref("geo.prompt.testing.allow", false); user_pref("permissions.default.geo", 2);' >> "$D/prof/user.js" ;;
    noapi)   APIFAIL=1 ;;
  esac
  PORT=$(freeport)
  QA_APIFAIL=$APIFAIL python3 -I "$T/qa_server.py" "$SITE" "$PORT" "$D" & SRV=$!
  for i in $(seq 1 50); do python3 -I -c "import socket; socket.create_connection(('127.0.0.1',$PORT),1)" 2>/dev/null && break; sleep 0.2; done
  timeout "$TIMEOUT" firefox --headless --no-remote --profile "$D/prof" "http://127.0.0.1:$PORT/$URL" >"$D/firefox.log" 2>&1 & FF=$!
  for i in $(seq 1 "$TIMEOUT"); do
    grep -q '"done": *true' "$D/results.jsonl" 2>/dev/null && break
    kill -0 $FF 2>/dev/null || break
    sleep 1
  done
  kill $FF 2>/dev/null; pkill -f -- "--profile $D/prof" 2>/dev/null; kill $SRV 2>/dev/null; wait 2>/dev/null
  python3 -I "$T/report.py" "$D/results.jsonl" "$s" || status=1
done
exit $status
