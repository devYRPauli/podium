#!/usr/bin/env bash
# Full test suite. Runs against a throwaway PODIUM_HOME and a fake executor,
# so it never touches your real roster or calls a real model.
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
PODIUM="$ROOT/bin/podium"
. test/lib.sh

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export PODIUM_HOME="$TMP/home"
export PODIUM_CONF="$PODIUM_HOME/podium.conf"
mkdir -p "$PODIUM_HOME/bots/tester"

cat > "$PODIUM_CONF" <<CONF
podium_executor() { "$ROOT/test/fixtures/fake-executor" "\$1" "\$2" "\$3" "\$4" "\$5"; local code=\$?; printf 'PODIUM_BOT_WRITES=%s\n' "\$PODIUM_BOT_WRITES" >> "\$3"; return "\$code"; }
PODIUM_TIMEOUT=1800
PODIUM_BOTS_DIR="$PODIUM_HOME/bots"
PODIUM_JOBS_DIR="$PODIUM_HOME/jobs"
PODIUM_LOG="$PODIUM_HOME/log.jsonl"
PODIUM_DEFAULT_MODEL=fallback-model
CONF

cat > "$PODIUM_HOME/bots/tester/bot.md" <<'BOT'
---
name: tester
description: A bot that exists only for the test suite
tools: read, bash
model: test-model-1
---
You are the tester bot. Marker: TESTER_SYSTEM_PROMPT.
BOT

echo "== runner core =="
assert_eq "version prints" "$("$PODIUM" version)" "0.1.0"
assert_contains "help mentions run" "$("$PODIUM" help)" "podium run <bot>"
assert_contains "bots lists the roster" "$("$PODIUM" bots)" "tester"
assert_contains "bots shows description" "$("$PODIUM" bots)" "only for the test suite"
assert_contains "unknown bot fails loud" "$("$PODIUM" run nosuchbot "hi" 2>&1)" "unknown bot"
assert_contains "unknown command fails loud" "$("$PODIUM" frobnicate 2>&1)" "unknown command"
assert_contains "path traversal rejected" "$("$PODIUM" run ../etc "hi" 2>&1)" "invalid bot name"

echo
echo "== job lifecycle =="
id=$("$PODIUM" run tester "hello world" 2>/dev/null)
assert_ne "run returns a job id" "$id" ""
wait_settled "$id" 30 || bad "job settles" "still running after 30s"
assert_contains "status reports done" "$("$PODIUM" status "$id")" "status=done"
assert_contains "status carries the bot" "$("$PODIUM" status "$id")" "bot=tester"
assert_contains "status carries exit code" "$("$PODIUM" status "$id")" "exit_code=0"
res=$("$PODIUM" result "$id")
assert_contains "result carries the brief" "$res" "brief=hello world"
assert_contains "bot model is used" "$res" "model=test-model-1"
assert_contains "system prompt is delivered" "$res" "TESTER_SYSTEM_PROMPT"
assert_contains "a read-only tools list denies writes" "$res" "PODIUM_BOT_WRITES=0"
assert_contains "list shows the job" "$("$PODIUM" list)" "$id"
assert_contains "list filters by bot" "$("$PODIUM" list --bot tester)" "$id"
assert_eq "list filters out other bots" "$("$PODIUM" list --bot nobody)" ""

echo
echo "== durability: the job outlives its launcher =="
# Launch from a subshell that exits immediately. If the worker were a child of
# that shell it would die with it; reparenting to init is what keeps it alive.
did=$(bash -c "\"$PODIUM\" run tester 'FAKE_SLEEP=4 durable' 2>/dev/null")
sleep 2
worker_pid=$(cat "$PODIUM_HOME/jobs/$did/pid" 2>/dev/null || echo "")
assert_ne "worker recorded a pid" "$worker_pid" ""
if [ -n "$worker_pid" ]; then
  ppid=$(ps -o ppid= -p "$worker_pid" 2>/dev/null | tr -d ' ')
  assert_eq "worker was reparented to init" "$ppid" "1"
  alive=$(kill -0 "$worker_pid" 2>/dev/null && echo yes || echo no)
  assert_eq "worker still alive after launcher exited" "$alive" "yes"
fi
wait_settled "$did" 30 || bad "detached job settles" "still running"
assert_contains "detached job produced output" "$("$PODIUM" result "$did")" "durable"

echo
echo "== failure and timeout =="
fid=$("$PODIUM" run tester "FAKE_FAIL please" 2>/dev/null)
wait_settled "$fid" 30 || bad "failing job settles" "still running"
assert_contains "failure is reported" "$("$PODIUM" status "$fid")" "status=failed"
assert_contains "failure keeps the exit code" "$("$PODIUM" status "$fid")" "exit_code=3"

tid=$("$PODIUM" run tester "FAKE_SLEEP=20 slow" --timeout 3 2>/dev/null)
wait_settled "$tid" 40 || bad "timed-out job settles" "still running"
assert_contains "watchdog stops runaways" "$("$PODIUM" status "$tid")" "status=timeout"

echo
echo "== memory injection =="
printf 'The user prefers tabs. Marker: MEMORY_MARKER.\n' > "$PODIUM_HOME/bots/tester/memory.md"
mid=$("$PODIUM" run tester "check memory" 2>/dev/null)
wait_settled "$mid" 30 || bad "memory job settles" "still running"
assert_contains "durable memory reaches the bot" "$("$PODIUM" result "$mid")" "system_has_memory=yes"

echo
echo "== audit log =="
log="$PODIUM_HOME/log.jsonl"
assert_eq "one log line per settled job" "$(wc -l < "$log" | tr -d ' ')" "5"
assert_contains "log records the bot" "$(head -1 "$log")" '"bot":"tester"'
assert_contains "log records timeout flag" "$(grep timeout "$log" | head -1)" '"timed_out":true'
assert_contains "receipt records the write policy" "$(head -1 "$log")" '"writes":0'
if command -v python3 >/dev/null 2>&1; then
  valid=$(python3 -c "
import json,sys
for line in open('$log'):
    json.loads(line)
print('yes')" 2>&1)
  assert_eq "every log line is valid JSON" "$valid" "yes"
fi

echo
echo "== --wait =="
wid=$("$PODIUM" run tester "FAKE_SLEEP=2 blocking" --wait 2>/dev/null)
assert_contains "--wait returns only once settled" "$("$PODIUM" status "$wid")" "status=done"


echo
echo "== machine-readable output =="
jid=$("$PODIUM" run tester "json shape check" --wait 2>/dev/null)
sj=$("$PODIUM" status --json "$jid")
if command -v python3 >/dev/null 2>&1; then
  parsed=$(printf '%s' "$sj" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(d['bot'], d['status'], d['exit_code'], d['model'])
" 2>&1)
  assert_eq "status --json parses and carries fields" "$parsed" "tester done 0 test-model-1"

  lj=$("$PODIUM" list --json)
  n=$(printf '%s' "$lj" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>&1)
  assert_ne "list --json parses as an array" "$n" ""
  case "$n" in ''|*[!0-9]*) bad "list --json returns jobs" "got '$n'" ;; *) [ "$n" -ge 6 ] && ok "list --json returns every job" || bad "list --json returns every job" "got $n" ;; esac

  showj=$("$PODIUM" show "$jid")
  fields=$(printf '%s' "$showj" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(d['brief'], '|', 'result' in d and len(d['result'])>0)
" 2>&1)
  assert_contains "show carries the brief" "$fields" "json shape check"
  assert_contains "show carries the result" "$fields" "True"

  # A brief containing quotes, newlines and backslashes must not break the JSON.
  hid=$("$PODIUM" run tester 'tricky "quoted" and \backslash
second line' --wait 2>/dev/null)
  hostile=$("$PODIUM" show "$hid" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('parsed', 'quoted' in d['brief'], '\n' in d['brief'])
" 2>&1)
  assert_eq "JSON survives quotes, newlines and backslashes" "$hostile" "parsed True True"
fi

assert_contains "brief returns the brief verbatim" "$("$PODIUM" brief "$jid")" "json shape check"
assert_contains "live job reports a duration" "$("$PODIUM" status --json "$jid")" '"duration_secs":'

echo
echo "== doctor =="
doc=$("$PODIUM" doctor)
assert_contains "doctor reports ready" "$doc" "ready."
assert_contains "doctor checks the executor" "$doc" "executor function defined"
assert_contains "doctor counts the roster" "$doc" "roster: 1 bot(s)"
missing_conf=$(PODIUM_CONF=/nonexistent/podium.conf "$PODIUM" doctor 2>&1 || true)
assert_contains "doctor fails loud on a missing config" "$missing_conf" "FAIL"

echo
echo "== bot tool policy =="
mkdir -p "$PODIUM_HOME/bots/writer" "$PODIUM_HOME/bots/legacy" "$PODIUM_HOME/bots/rewriter"
cat > "$PODIUM_HOME/bots/writer/bot.md" <<'BOT'
---
name: writer
tools: read, write
---
Writer bot.
BOT
cat > "$PODIUM_HOME/bots/legacy/bot.md" <<'BOT'
---
name: legacy
---
Legacy bot.
BOT
cat > "$PODIUM_HOME/bots/rewriter/bot.md" <<'BOT'
---
name: rewriter
tools: read, rewrite
---
Rewriter bot.
BOT

pid=$("$PODIUM" run writer "write policy" --wait 2>/dev/null)
assert_contains "write grants write access" "$("$PODIUM" result "$pid")" "PODIUM_BOT_WRITES=1"
pid=$("$PODIUM" run legacy "legacy policy" --wait 2>/dev/null)
assert_contains "an absent tools list preserves write access" "$("$PODIUM" result "$pid")" "PODIUM_BOT_WRITES=1"
pid=$("$PODIUM" run rewriter "rewrite policy" --wait 2>/dev/null)
assert_contains "rewrite does not grant write access" "$("$PODIUM" result "$pid")" "PODIUM_BOT_WRITES=0"

# A job queued by an older podium carries neither JOB_TOOLS nor JOB_WRITES.
# Under `set -u` the worker died on the first of them: the job stranded in
# `running`, which is not settled, so --wait hung and no receipt was written.
# A job that ran and left no record is the one outcome this project forbids.
mkdir -p "$PODIUM_HOME/bots/legacy/workspace" "$PODIUM_HOME/jobs/legacy-meta"
oldjd="$PODIUM_HOME/jobs/legacy-meta"
cat > "$oldjd/meta.env" <<META
JOB_ID=legacy-meta
JOB_BOT=legacy
JOB_MODEL=
JOB_CWD=$PODIUM_HOME
JOB_TIMEOUT=30
JOB_WS=$PODIUM_HOME/bots/legacy/workspace
JOB_CHECK=true
META
printf 'legacy brief\n' > "$oldjd/brief.txt"
printf 'legacy system\n' > "$oldjd/system.txt"
: > "$oldjd/out.txt"
echo queued > "$oldjd/status"
before=$(wc -l < "$log" | tr -d ' ')
"$PODIUM" __worker "$oldjd" >/dev/null 2>&1
assert_contains "a job queued before the upgrade still settles" \
  "$("$PODIUM" status legacy-meta 2>&1)" "status=done"
assert_ne "a job queued before the upgrade still leaves a receipt" \
  "$(wc -l < "$log" | tr -d ' ')" "$before"

# `cancelled` is a settled state, so a cancelled job with no receipt is terminal
# and unrecorded: it ran and left nothing behind. Killing the worker took its
# receipt with it, so the runner writes one here. Cancelled work is unverified.
cat > "$PODIUM_HOME/slow.conf" <<SLOW
podium_executor() { sleep 20; printf 'late\n' > "\$3"; }
PODIUM_BOTS_DIR="$PODIUM_HOME/bots"
PODIUM_JOBS_DIR="$PODIUM_HOME/jobs"
PODIUM_LOG="$log"
SLOW
before=$(wc -l < "$log" | tr -d ' ')
cid=$(PODIUM_CONF="$PODIUM_HOME/slow.conf" "$PODIUM" run writer "slow work" --check "true" --timeout 60 2>/dev/null)
sleep 2
PODIUM_CONF="$PODIUM_HOME/slow.conf" "$PODIUM" cancel "$cid" >/dev/null 2>&1
assert_contains "a cancelled job is settled as cancelled" \
  "$(PODIUM_CONF="$PODIUM_HOME/slow.conf" "$PODIUM" status "$cid" 2>&1)" "status=cancelled"
assert_contains "status and the ledger agree that it is unverified" \
  "$(PODIUM_CONF="$PODIUM_HOME/slow.conf" "$PODIUM" status "$cid" 2>&1)" "verdict=unverified"
assert_ne "a cancelled job still leaves a receipt" "$(wc -l < "$log" | tr -d ' ')" "$before"
assert_contains "a cancelled job is never verified" "$(tail -1 "$log")" '"verdict":"unverified"'
assert_contains "the cancelled receipt keeps the check it was given" "$(tail -1 "$log")" '"check":"true"'
before=$(wc -l < "$log" | tr -d ' ')
PODIUM_CONF="$PODIUM_HOME/slow.conf" "$PODIUM" cancel "$cid" >/dev/null 2>&1
assert_eq "cancelling twice does not fork the ledger" "$(wc -l < "$log" | tr -d ' ')" "$before"


echo
echo "== acceptance checks: the runner verifies, not the bot =="
vid=$("$PODIUM" run tester "job with a passing check" --check "true" --wait 2>/dev/null)
assert_contains "passing check settles as done" "$("$PODIUM" status "$vid")" "status=done"
assert_contains "passing check records verified" "$("$PODIUM" status "$vid")" "verdict=verified"

rid=$("$PODIUM" run tester "job with a failing check" --check "exit 7" --wait 2>/dev/null)
assert_contains "failing check REJECTS the job" "$("$PODIUM" status "$rid")" "status=rejected"
assert_contains "failing check records the verdict" "$("$PODIUM" status "$rid")" "verdict=failed_check"

uid=$("$PODIUM" run tester "job with no check at all" --wait 2>/dev/null)
assert_contains "no check means unverified, not done-and-trusted" "$("$PODIUM" status "$uid")" "verdict=unverified"

# The bot's own exit code must not be able to launder a failed check.
assert_contains "a rejected job still records exit_code 0" "$("$PODIUM" status "$rid")" "exit_code=0"

# A check that never ran is distinguishable from one that passed.
nid=$("$PODIUM" run tester "FAKE_FAIL with a check" --check "true" --wait 2>/dev/null)
assert_contains "check does not run when the bot failed" "$("$PODIUM" status "$nid")" "verdict=not_run"
assert_contains "failed bot still reports failed" "$("$PODIUM" status "$nid")" "status=failed"

echo
echo "== the check runs in the job's cwd, and is recorded verbatim =="
probe=$(mktemp -d)
printf 'sentinel\n' > "$probe/marker.txt"
cid=$("$PODIUM" run tester "cwd check" --cwd "$probe" --check "grep -q sentinel marker.txt" --wait 2>/dev/null)
assert_contains "check executes in the job cwd" "$("$PODIUM" status "$cid")" "verdict=verified"

if command -v python3 >/dev/null 2>&1; then
  recorded=$("$PODIUM" show "$cid" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(d['check'], '|', d['check_exit'], '|', d['verified'])
" 2>&1)
  assert_contains "the check command is stored verbatim" "$recorded" "grep -q sentinel marker.txt"
  assert_contains "the check exit code is stored" "$recorded" "| 0 |"
  assert_contains "verified is a boolean in show" "$recorded" "True"

  failout=$("$PODIUM" show "$rid" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('exit', d['check_exit'], 'verified', d['verified'])
" 2>&1)
  assert_eq "a failed check records its exit code" "$failout" "exit 7 verified False"
fi
rm -rf "$probe"

echo
echo "== a vacuous check is visible, not laundered =="
gid=$("$PODIUM" run tester "goodhart" --check "test 1 -eq 1" --wait 2>/dev/null)
assert_contains "even a trivial check is shown in the ledger" "$("$PODIUM" ledger --limit 100)" "test 1 -eq 1"

echo
echo "== require-check policy =="
refused=$(PODIUM_REQUIRE_CHECK=1 "$PODIUM" run tester "no check supplied" 2>&1 || true)
assert_contains "policy refuses an uncheckable job" "$refused" "no acceptance check"
allowed=$(PODIUM_REQUIRE_CHECK=1 "$PODIUM" run tester "checked" --check "true" --wait 2>/dev/null)
assert_ne "policy allows a checked job" "$allowed" ""

echo
echo "== throttling is not a hang =="
tlid=$("$PODIUM" run tester "FAKE_RATELIMIT slow" --timeout 3 2>/dev/null)
wait_settled "$tlid" 40 || bad "throttled job settles" "still running"
assert_contains "a throttled executor is classified, not called a timeout" "$("$PODIUM" status "$tlid")" "status=rate_limited"
plain=$("$PODIUM" run tester "FAKE_SLEEP=20 quiet stall" --timeout 3 2>/dev/null)
wait_settled "$plain" 40 || bad "silent stall settles" "still running"
assert_contains "a silent stall is still a timeout" "$("$PODIUM" status "$plain")" "status=timeout"

echo
echo "== the ledger answers 'what was actually verified?' =="
led=$("$PODIUM" ledger --limit 100)
assert_contains "ledger lists a verified job" "$led" "verified"
unv=$("$PODIUM" ledger --unverified --limit 100)
assert_contains "unverified filter includes an unchecked job" "$unv" "$uid"
case "$unv" in
  *"$vid"*) bad "unverified filter excludes verified jobs" "$vid leaked into --unverified" ;;
  *) ok "unverified filter excludes verified jobs" ;;
esac
assert_contains "unverified filter includes a rejected job" "$unv" "$rid"
botled=$("$PODIUM" ledger --bot nobody --limit 100)
assert_contains "ledger --bot filters" "$botled" "(nothing matched)"

if command -v python3 >/dev/null 2>&1; then
  lj=$("$PODIUM" ledger --json --limit 100)
  ok_json=$(printf '%s' "$lj" | python3 -c "
import json,sys
rows=json.load(sys.stdin)
v=[r for r in rows if r.get('verified') is True]
u=[r for r in rows if r.get('verified') is False]
print('rows',len(rows)>0,'verified',len(v)>0,'unverified',len(u)>0)
" 2>&1)
  assert_eq "ledger --json is valid and carries verified flags" "$ok_json" "rows True verified True unverified True"
fi

echo
echo "== manual re-verification =="
reran=$("$PODIUM" verify "$cid" 2>&1 || true)
assert_contains "verify re-runs the recorded check" "$reran" "grep -q sentinel marker.txt"
noverify=$("$PODIUM" verify "$uid" 2>&1 || true)
assert_contains "verify refuses a job with no check" "$noverify" "no acceptance check"


echo
echo "== tamper-evident receipts =="
assert_contains "audit reports an intact chain" "$("$PODIUM" audit)" "chain intact"
assert_contains "audit reports the head hash" "$("$PODIUM" audit)" "head:"
assert_contains "every receipt carries a prev link" "$(tail -1 "$PODIUM_HOME/log.jsonl")" '"prev":"'
[ -f "$PODIUM_HOME/log.jsonl.head" ] && ok "the head hash is stored separately" || bad "the head hash is stored separately"

cp "$PODIUM_HOME/log.jsonl" "$PODIUM_HOME/log.clean"

# 1. Editing the newest receipt - the case a plain chain cannot catch.
# GNU and BSD sed disagree about -i, so edit through a temp file instead.
sed 's/"verified":false/"verified":true/' "$PODIUM_HOME/log.jsonl" > "$PODIUM_HOME/log.tmp"
mv "$PODIUM_HOME/log.tmp" "$PODIUM_HOME/log.jsonl"
out=$("$PODIUM" audit 2>&1); rc=$?
assert_ne "editing a receipt is detected" "$rc" "0"
cp "$PODIUM_HOME/log.clean" "$PODIUM_HOME/log.jsonl"

# 2. Deleting a receipt.
if command -v python3 >/dev/null 2>&1; then
  python3 -c "
lines=open('$PODIUM_HOME/log.jsonl').read().split('\n')
lines=[l for l in lines if l]
del lines[1]
open('$PODIUM_HOME/log.jsonl','w').write('\n'.join(lines)+'\n')
"
  out=$("$PODIUM" audit 2>&1); rc=$?
  assert_ne "deleting a receipt is detected" "$rc" "0"
  assert_contains "the audit names the broken link" "$out" "CHAIN BROKEN"
  cp "$PODIUM_HOME/log.clean" "$PODIUM_HOME/log.jsonl"
fi

# 3. Restoring the file restores the chain - no false positives.
out=$("$PODIUM" audit 2>&1)
assert_contains "an untouched ledger still verifies" "$out" "chain intact"

echo
echo "== concurrent settles do not break the chain =="
before=$(wc -l < "$PODIUM_HOME/log.jsonl" | tr -d ' ')
for i in 1 2 3 4 5 6; do "$PODIUM" run tester "concurrent $i" --check "true" >/dev/null 2>&1 & done
wait
# Give the detached workers time to settle and append.
for _ in $(seq 1 40); do
  now=$(wc -l < "$PODIUM_HOME/log.jsonl" | tr -d ' ')
  [ "$((now - before))" -ge 6 ] && break
  sleep 1
done
after=$(wc -l < "$PODIUM_HOME/log.jsonl" | tr -d ' ')
assert_eq "all six concurrent receipts landed" "$((after - before))" "6"
assert_contains "the chain survives concurrent appends" "$("$PODIUM" audit)" "chain intact"
[ -d "$PODIUM_HOME/log.jsonl.lock" ] && bad "the append lock is released" "lock dir left behind" || ok "the append lock is released"


echo
echo "== doctor --executor tells config bugs from auth problems =="
# The class of bug this exists for: a shipped config once called `pi --cwd`,
# a flag pi does not have, and no test caught it because the stand-in executor
# never parses flags.
probe_conf() {
  cat > "$PODIUM_HOME/probe.conf" <<PROBE
podium_executor() { $1 }
PODIUM_BOTS_DIR="$PODIUM_HOME/bots"
PODIUM_JOBS_DIR="$PODIUM_HOME/jobs"
PODIUM_LOG="$PODIUM_HOME/log.jsonl"
PROBE
  PODIUM_CONF="$PODIUM_HOME/probe.conf" "$PODIUM" doctor --executor 10 2>&1
}

out=$(probe_conf 'printf "Error: Unknown option: --cwd\n" > "$3"; return 1;')
assert_contains "an invented flag is reported as a config bug" "$out" "rejected its own arguments"
assert_contains "the config bug names the file to fix" "$out" "probe.conf"

out=$(probe_conf 'printf "nosuchexecutor: command not found\n" > "$3"; return 127;')
assert_contains "a missing binary is reported as missing" "$out" "binary was not found"

out=$(probe_conf 'printf "UnrecognizedClientException: The security token included in the request is invalid.\n" > "$3"; return 1;')
assert_contains "an auth failure is NOT called a config bug" "$out" "not authenticated"
case "$out" in *"podium.conf is wrong"*) bad "auth failure is not blamed on the config" ;; *) ok "auth failure is not blamed on the config" ;; esac

out=$(probe_conf 'printf "OK\n" > "$3"; return 0;')
code=$?
assert_contains "an executor without write access is reported" "$out" "write"
assert_ne "an executor without write access fails the probe" "$code" "0"

out=$(probe_conf 'printf "PODIUM_WRITE_OK\n" > "$2/write-probe.txt"; printf "OK\n" > "$3"; return 0;')
assert_contains "a working executor is reported working" "$out" "ran and returned output"

out=$(probe_conf 'sleep 30 > "$3";')
assert_contains "a hanging executor is stopped and reported" "$out" "FAIL"

rm -f "$PODIUM_HOME/probe.conf"


echo
echo "== doctor catches an executor that silently drops the bot prompt =="
# The Codex example shipped in v0 never referenced "$5". Jobs would have
# succeeded with generic output from the wrong persona - no error anywhere.
drop_conf() {
  cat > "$PODIUM_HOME/drop.conf" <<DROP
podium_executor() { $1 }
PODIUM_BOTS_DIR="$PODIUM_HOME/bots"
PODIUM_JOBS_DIR="$PODIUM_HOME/jobs"
PODIUM_LOG="$PODIUM_HOME/log.jsonl"
DROP
  PODIUM_CONF="$PODIUM_HOME/drop.conf" "$PODIUM" doctor 2>&1
}

out=$(drop_conf 'codex exec -m "$1" -C "$2" -o "$3" - < "$4";')
assert_contains "an executor ignoring \$5 is reported" "$out" 'never reads "$5"'
assert_contains "and doctor refuses to call it ready" "$out" "not ready"

out=$(drop_conf '{ cat "$5"; cat "$4"; } | codex exec -m "$1" -C "$2" -o "$3" -;')
assert_contains "an executor passing \$5 is accepted" "$out" "passes the bot system prompt"
assert_contains "an executor ignoring tool policy is warned" "$out" "tools list is advisory only"
assert_contains "a tool policy warning remains ready" "$out" "ready."

out=$(drop_conf 'PODIUM_BOT_WRITES="${PODIUM_BOT_WRITES:-1}"; { cat "$5"; cat "$4"; } | codex exec -m "$1" -C "$2" -o "$3" -;')
case "$out" in *"tools list is advisory only"*) bad "an executor reading tool policy is accepted" "unexpected policy warning" ;; *) ok "an executor reading tool policy is accepted" ;; esac

out=$(drop_conf 'pi -p --append-system-prompt "$5" "$(cat "$4")" > "$3";')
assert_contains "the flag form of \$5 is accepted too" "$out" "passes the bot system prompt"
rm -f "$PODIUM_HOME/drop.conf"

summary
