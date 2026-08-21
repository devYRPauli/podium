# Setting up Podium

You are an agent installing Podium for the user. Read this whole file before you
write anything.

## What you are about to do

Install a chief-of-staff orchestrator and a roster of bots into the user's pi
configuration, plus a job runner and state directory. Nothing here touches
credentials, and nothing here runs a network request during install.

## Rules

1. **Never read, print, copy, or store a credential.** If the executor is not
   authenticated, stop and tell the user the exact command to run themselves.
2. **List every destination path before writing any of them**, and get one
   explicit confirmation. If a file already exists, show the diff first.
3. **Do not invent answers to the interview.** Ask.
4. **Finish with a live acceptance test.** An installer that does not prove it
   worked is exactly the failure this tool exists to prevent.

## Interview

Ask these, one at a time:

1. **Executor.** Which CLI runs the bots - `pi`, `codex`, `claude`, or something
   else? Confirm it is on PATH (`command -v <cli>`) and that the user has
   authenticated it. Do not authenticate for them.
2. **Model.** Which model should bots use by default? Leave blank to let the
   executor decide.
3. **Home.** Where should state live? Default `~/.podium`.
4. **pi config scope.** Global (`~/.pi/agent`) or project (`.pi`)?
5. **Timeout.** Hard timeout per job in seconds. Default 1800.
6. **Parallelism.** Maximum concurrent jobs the orchestrator may launch.
   Default 3. Warn them: fanning out multiplies token spend against a
   subscription priced for one person.
7. **Check policy.** Should a job launched with no acceptance check be refused
   outright (`PODIUM_REQUIRE_CHECK=1`) or allowed and recorded as unverified?
   Default: allowed. Explain the trade - strict is honest but blocks genuinely
   uncheckable work like open-ended research.
8. **Roster.** Install all five sample bots, or a subset?
9. **Desktop console.** Install it? It needs Node and about 200 MB of Electron.
   The runner and the Pi extension work without it.

## Install

Render and write, in this order:

| Source | Destination |
|---|---|
| `bin/podium` | `<PODIUM_HOME>/bin/podium`, mode 755 |
| `templates/podium.conf.tmpl` | `<PODIUM_HOME>/podium.conf` |
| `bots/<name>/bot.md` (selected) | `<PODIUM_HOME>/bots/<name>/bot.md` |
| `templates/orchestrator.ts.tmpl` | `<PI_SCOPE>/extensions/podium/index.ts` |
| `templates/ORCHESTRATOR.md.tmpl` | `<PI_SCOPE>/skills/podium/SKILL.md` |

If the desktop console was chosen, leave `desktop/` where it is and run
`npm install` inside it. Do not copy it into the Pi scope.

Slots to fill:

- `{{PODIUM_BIN}}` - absolute path to the installed runner
- `{{PODIUM_HOME}}` - absolute path to the state directory
- `{{DEFAULT_MODEL}}` - from the interview, or empty
- `{{TIMEOUT}}` - from the interview
- `{{EXECUTOR_CLI}}` - the executor binary name, e.g. `pi` or `codex`
- `{{MAX_PARALLEL}}` - from the interview

Also write `PODIUM_REQUIRE_CHECK=<0|1>` into `podium.conf` from answer 7.

Also create `<PODIUM_HOME>/bots/<name>/workspace/` for each installed bot, and
touch an empty `memory.md` beside each `bot.md`.

Leave no unfilled `{{SLOT}}` anywhere. Grep for `{{` across everything you wrote
and confirm zero matches.

## Acceptance test

Run this and show the user the real output. Do not summarise it.

```sh
export PODIUM_HOME=<PODIUM_HOME>
P="$PODIUM_HOME/bin/podium"

"$P" doctor              # every requirement, checked
"$P" doctor --executor   # actually invoke the executor - catches a wrong flag
"$P" bots                # the roster

# 1. A job that should VERIFY. The check is real: it fails if the file is absent.
id=$("$P" run scout "Write the single word PODIUM_OK into ./podium-ok.txt" \
       --check "grep -q PODIUM_OK ./podium-ok.txt" --timeout 180)
echo "job: $id"

# 2. Confirm it detached rather than merely started.
sleep 2
pid=$(cat "$PODIUM_HOME/jobs/$id/pid")
ps -o ppid= -p "$pid" | tr -d ' '   # expect 1 once the launcher has exited

# 3. Wait it out, then read the verdict.
while : ; do
  case "$("$P" status "$id")" in *status=done*|*status=rejected*|*status=failed*|*status=timeout*|*status=rate_limited*) break ;; esac
  sleep 2
done
"$P" status "$id"
"$P" result "$id"

# 4. A job that must be REJECTED, proving the runner overrides the bot.
bad=$("$P" run scout "Do nothing at all." --check "test -f ./definitely-not-here" --timeout 120)
sleep 5; "$P" status "$bad"

# 5. The receipts.
"$P" ledger --limit 5
"$P" ledger --unverified --limit 5
```

The install is successful when **all** of these hold:

- `doctor` reports `ready.`
- `doctor --executor` reports `ok` or `WARN ... not authenticated`. If it says
  the executor rejected its own arguments, `podium.conf` is wrong and no job
  will ever run - fix that before going further
- the parent pid printed in step 2 is `1` - if it is not, the job did not detach
- job 1 reaches `status=done verdict=verified`
- job 4 reaches `status=rejected verdict=failed_check`, **even though the bot
  itself exited cleanly** - this is the property the whole kit exists for
- `ledger --unverified` lists job 4 and not job 1

Report the real output of each step. Do not summarise it as "passing". If step 4
comes back `done` rather than `rejected`, the acceptance-check path is broken and
the install has failed, however healthy everything else looks.

Finally, start pi and confirm `/bots`, `/jobs` and `/receipts` are registered and
that `delegate` appears in the tool list with a `check` parameter.

If the desktop console was installed, run `cd desktop && npm test` (47
assertions) and `npm start`, and confirm the Receipts view shows the two jobs
above with the right verdicts.

## Uninstall

```sh
rm -rf <PI_SCOPE>/extensions/podium <PI_SCOPE>/skills/podium
rm -rf <PODIUM_HOME>          # destructive: also removes job history and memory
```

Job history and bot memory live in `<PODIUM_HOME>`. Removing it discards the
ledger, which is the record of everything that was ever verified. Confirm that
with the user before running the second line.
