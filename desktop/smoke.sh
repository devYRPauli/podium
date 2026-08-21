#!/usr/bin/env bash
# Headless UI smoke test. Boots the console against a throwaway PODIUM_HOME
# seeded with one job of every verdict, drives every view, captures a screenshot
# of each, and asserts what rendered. No display and no real model required.
set -uo pipefail
cd "$(dirname "$0")"
KIT="$(cd .. && pwd)"

command -v xvfb-run >/dev/null 2>&1 || { echo "smoke: xvfb-run is required (apt install xvfb)"; exit 1; }
[ -x ./node_modules/.bin/electron ] || { echo "smoke: run npm install first"; exit 1; }

OUT=${1:-$(mktemp -d)/shot}
mkdir -p "$(dirname "$OUT")"
HOME_DIR=$(mktemp -d)
trap 'rm -rf "$HOME_DIR"' EXIT

mkdir -p "$HOME_DIR/bin"
cp "$KIT/bin/podium" "$HOME_DIR/bin/podium"; chmod +x "$HOME_DIR/bin/podium"
cp -r "$KIT/bots" "$HOME_DIR/bots"
for b in "$HOME_DIR"/bots/*/; do mkdir -p "$b/workspace"; : > "$b/memory.md"; done
printf -- '- (2026-08-20) This repo uses pnpm, never npm.\n' > "$HOME_DIR/bots/implementer/memory.md"

cat > "$HOME_DIR/podium.conf" <<CONF
podium_executor() { "$KIT/test/fixtures/fake-executor" "\$1" "\$2" "\$3" "\$4" "\$5"; }
PODIUM_BOTS_DIR="$HOME_DIR/bots"
PODIUM_JOBS_DIR="$HOME_DIR/jobs"
PODIUM_LOG="$HOME_DIR/log.jsonl"
PODIUM_DEFAULT_MODEL=gpt-5-codex
PODIUM_TIMEOUT=1800
CONF

export PODIUM_HOME="$HOME_DIR" PODIUM_CONF="$HOME_DIR/podium.conf"
P="$HOME_DIR/bin/podium"

# One job of every verdict, so the UI has something honest to render.
"$P" run scout       "Map the session store writes" --check "true"        --wait >/dev/null
"$P" run implementer "Add a null check to parse()"  --check "test 1 -eq 1" --wait >/dev/null
"$P" run reviewer    "Review the parse change"                             --wait >/dev/null
"$P" run implementer "Add retry to fetch"           --check "exit 1"       --wait >/dev/null
"$P" run researcher  "FAKE_RATELIMIT compare vector stores" --timeout 3 >/dev/null
sleep 6

report=$(PODIUM_SMOKE="$OUT" xvfb-run -a --server-args="-screen 0 1400x900x24" \
  ./node_modules/.bin/electron . --no-sandbox --disable-gpu 2>/dev/null | grep '^SMOKE ' | head -1)

if [ -z "$report" ]; then echo "smoke: the app produced no report (did it crash?)"; exit 1; fi
echo "${report#SMOKE }"

fail=0
want() {
  case "$report" in *"$1"*) echo "  ok   $2" ;; *) echo "  FAIL $2"; fail=1 ;; esac
}
want '"bots":5'                    "the roster renders"
want '"jobs":5'                    "delegated work renders"
want '"sheetVisible":false'        "no overlay covers the app at launch"
want '"bannerVisible":false'       "no error banner on a healthy install"
want '"verified"'                  "a verified verdict is shown"
want '"rejected"'                  "a rejected verdict is shown"
want '"unverified"'                "an unverified verdict is shown"
want '"throttled"'                 "throttling is shown distinctly from a timeout"
want '"noneGiven":2'               "jobs with no check are marked as such"
want '"unverifiedFilter":{"rows":3}' "the unverified filter matches the ledger"
want '"acceptance check"'          "the job sheet leads with the acceptance check"
want 'chain intact'                "the console reports the receipt chain intact"

echo
cli_unverified=$("$P" ledger --unverified --limit 100 | grep -c .)
if [ "$cli_unverified" -eq 3 ]; then
  echo "  ok   the console and the CLI agree (3 unverified)"
else
  echo "  FAIL console/CLI disagree: CLI says $cli_unverified"; fail=1
fi

echo
echo "screenshots: ${OUT}-*.png"
[ "$fail" -eq 0 ] && echo "smoke passed." || { echo "smoke FAILED."; exit 1; }
