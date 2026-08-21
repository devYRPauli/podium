#!/usr/bin/env bash
# Repository hygiene: every tracked text file is plain ASCII.
#
# The project writes in Simplified Technical English and plain ASCII. A style
# rule nobody executes is decoration, so this runs in CI next to the other
# suites. It fails loudly and names the file, the line and the byte offset.
#
# Banned: em dashes, en dashes, smart quotes, ellipsis characters, arrows,
# middots, section signs, emoji, and every other byte outside printable ASCII.
# Tab, space and newline are allowed.
#
# ONE allowlisted file, for a reason worth reading before you add a second:
# desktop/test/orchestrator.test.js embeds U+2028 and U+2029 on purpose. Pi's
# RPC mode is strict JSONL with LF as the only record delimiter, but Node's
# `readline` also splits on those two characters, and they are legal inside a
# JSON string. The test proves a payload carrying both survives our hand-rolled
# splitter. Strip them and the test still passes while proving nothing.
set -uo pipefail
cd "$(dirname "$0")/.."

ALLOW="desktop/test/orchestrator.test.js"
PATTERN=$'[^ -~\t]'
fail=0

while IFS= read -r f; do
  case "$f" in
    *.png|*.jpg|*.jpeg|*.gif|*.ico|*.icns|*.pdf|*.woff|*.woff2) continue ;;
    $ALLOW) continue ;;
  esac
  [ -f "$f" ] || continue
  hits=$(LC_ALL=C grep -n "$PATTERN" "$f" 2>/dev/null) || continue
  [ -n "$hits" ] || continue
  fail=1
  printf 'FAIL  non-ASCII in %s\n' "$f"
  printf '%s\n' "$hits" | head -5 | while IFS= read -r line; do
    printf '      %s\n' "$(printf '%s' "$line" | cut -c1-110 | LC_ALL=C tr -c '[ -~]\n' '?')"
  done
done < <(git ls-files)

# The allowlisted file must still contain what it is allowlisted for. An
# over-zealous cleanup that "fixes" it would otherwise pass silently.
if ! LC_ALL=C grep -q "$PATTERN" "$ALLOW" 2>/dev/null; then
  printf 'FAIL  %s no longer contains U+2028/U+2029 - the JSONL framing test is now vacuous\n' "$ALLOW"
  fail=1
fi

if [ "$fail" -eq 0 ]; then
  printf 'ascii: clean (%s tracked files, 1 allowlisted)\n' "$(git ls-files | wc -l | tr -d ' ')"
fi
exit "$fail"
