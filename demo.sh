#!/usr/bin/env bash
# See Podium work in about thirty seconds, with no model, no auth and no config.
#
#   ./demo.sh            run the jobs and print the receipts
#   ./demo.sh --console  the same, then open the desktop console on it
#
# Everything lands in a throwaway directory that is printed at the end. Your
# real ~/.podium is not touched.
set -uo pipefail
cd "$(dirname "$0")"
KIT="$PWD"

CONSOLE=0
[ "${1:-}" = "--console" ] && CONSOLE=1

TMP_BASE=${TMPDIR:-/tmp}; TMP_BASE=${TMP_BASE%/}
HOME_DIR=$(mktemp -d "$TMP_BASE/podium-demo-XXXXXX")
mkdir -p "$HOME_DIR/bin"
cp bin/podium "$HOME_DIR/bin/podium"; chmod +x "$HOME_DIR/bin/podium"
cp -R bots "$HOME_DIR/bots"
for b in "$HOME_DIR"/bots/*/; do mkdir -p "$b/workspace"; : > "$b/memory.md"; done
printf -- '- (2026-08-20) This repo uses pnpm, never npm.\n' > "$HOME_DIR/bots/implementer/memory.md"

cat > "$HOME_DIR/podium.conf" <<CONF
# The demo uses a stand-in executor so nothing calls a real model.
podium_executor() { "$KIT/test/fixtures/fake-executor" "\$1" "\$2" "\$3" "\$4" "\$5"; }
PODIUM_EXECUTOR_CLI=""
PODIUM_BOTS_DIR="$HOME_DIR/bots"
PODIUM_JOBS_DIR="$HOME_DIR/jobs"
PODIUM_LOG="$HOME_DIR/log.jsonl"
PODIUM_DEFAULT_MODEL=demo-model
PODIUM_TIMEOUT=1800
CONF

export PODIUM_HOME="$HOME_DIR" PODIUM_CONF="$HOME_DIR/podium.conf"
P="$HOME_DIR/bin/podium"

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }

say "1. The roster. A bot is a directory: prompt, memory, workspace."
"$P" bots

say "2. Four jobs, delegated. Watch what the runner does with each one."
printf '   scout        - acceptance check passes\n'
"$P" run scout "Map every write to the session store" --check "true" --wait >/dev/null
printf '   implementer  - acceptance check passes\n'
"$P" run implementer "Add a null check to parse()" --check "test 1 -eq 1" --wait >/dev/null
printf '   reviewer     - NO acceptance check given\n'
"$P" run reviewer "Review the parse() change" --wait >/dev/null
printf '   implementer  - acceptance check FAILS\n'
"$P" run implementer "Add retry to the fetch helper" --check "exit 1" --wait >/dev/null
printf '   researcher   - executor gets rate limited\n'
"$P" run researcher "FAKE_RATELIMIT compare pgvector and sqlite-vec" --timeout 3 >/dev/null
sleep 6

say "3. The receipts."
"$P" ledger --limit 10

say "4. The point: which of those proved anything?"
"$P" ledger --unverified --limit 10
cat <<'NOTE'

   The reviewer job finished cleanly and is still listed. It was given no
   acceptance check, so nothing confirms it did what it claimed. The runner
   will not round that up to done, and neither should you.

   The implementer job below it exited 0 - and was still rejected, because the
   check the runner ran came back non-zero. A bot cannot mark its own homework.
NOTE

say "5. The ledger is tamper-evident."
"$P" audit
printf '\n   Now rewrite a failure into a success, the way anyone could:\n'
sed 's/"verdict":"failed_check","verified":false/"verdict":"verified","verified":true/' \
  "$HOME_DIR/log.jsonl" > "$HOME_DIR/log.tmp" && mv "$HOME_DIR/log.tmp" "$HOME_DIR/log.jsonl"
printf '   $ podium audit\n'
"$P" audit || true

say "Done."
printf 'Everything lives in %s\n' "$HOME_DIR"
printf 'Poke at it with:  export PODIUM_HOME=%s PODIUM_CONF=%s/podium.conf\n' "$HOME_DIR" "$HOME_DIR"
printf '                  %s/bin/podium help\n' "$HOME_DIR"
printf 'Remove it with:   rm -rf %s\n' "$HOME_DIR"

if [ "$CONSOLE" -eq 1 ]; then
  if [ ! -d desktop/node_modules ]; then
    say "Installing the console (one time)"
    ( cd desktop && npm install --no-audit --no-fund ) || { echo "npm install failed"; exit 1; }
  fi
  say "Opening the console on the demo data"
  ( cd desktop && PODIUM_HOME="$HOME_DIR" npm start )
fi
