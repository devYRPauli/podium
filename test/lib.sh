# Minimal assertion helpers. No dependencies.
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1"; [ $# -gt 1 ] && printf '       %s\n' "$2"; }
assert_eq()       { [ "$2" = "$3" ] && ok "$1" || bad "$1" "expected '$3', got '$2'"; }
assert_contains() { case "$2" in *"$3"*) ok "$1" ;; *) bad "$1" "'$3' not found in: $(printf '%s' "$2" | head -c 300)" ;; esac; }
assert_ne()       { [ "$2" != "$3" ] && ok "$1" || bad "$1" "expected not '$3'"; }
summary()         { printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"; [ "$FAIL" -eq 0 ]; }

wait_for_status() {
  # wait_for_status <id> <status> <max_secs>
  local id=$1 want=$2 max=${3:-30} i=0
  while [ "$i" -lt "$max" ]; do
    case "$("$PODIUM" status "$id")" in *"status=$want"*) return 0 ;; esac
    sleep 1; i=$((i+1))
  done
  return 1
}

wait_settled() {
  local id=$1 max=${2:-30} i=0 s
  while [ "$i" -lt "$max" ]; do
    s=$("$PODIUM" status "$id")
    case "$s" in
      *status=done*|*status=failed*|*status=timeout*|*status=rejected*|*status=rate_limited*|*status=cancelled*) return 0 ;;
    esac
    sleep 1; i=$((i+1))
  done
  return 1
}
