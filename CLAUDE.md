# Podium

Verified delegation for [Pi](https://github.com/earendil-works/pi). A chief-of-staff
agent hands briefed work to a roster of persistent bots, and the **runner** —
bash, not a model — decides whether the work landed.

## The one invariant

**Nothing but the runner may declare work verified.** Not the bot, not the
orchestrator, not an exit code. A job is `verified` only when a shell command
recorded in `--check` was executed by `bin/podium` and exited 0.

Every change must preserve this. If a change would let a model's own report
influence the verdict, it is the wrong change.

Three verdicts, deliberately not collapsible:

| verdict | means |
|---|---|
| `verified` | a check ran and exited 0 |
| `failed_check` | a check ran and failed — job status becomes `rejected` |
| `unverified` | no check passed; nothing confirms the work |

`unverified` is never a soft pass. A job that finished cleanly with no check
stays unverified forever and surfaces under `podium ledger --unverified`.

## Layout

```
bin/podium              the runner. Zero deps beyond bash + coreutils. POSIX only.
bots/<name>/bot.md      a bot: YAML frontmatter + system prompt as the body
templates/              rendered at install time by SETUP.md. Slots are {{LIKE_THIS}}
  podium.conf.tmpl        defines podium_executor() — how a job actually runs
  orchestrator.ts.tmpl    the Pi extension: roster, delegate, check, collect, receipts, remember
  ORCHESTRATOR.md.tmpl    the chief-of-staff prompt, installed as a Pi skill
desktop/                Electron console. main/preload/renderer split, no Node in the renderer
test/run.sh             the runner suite — 86 assertions against a stand-in executor
demo.sh                 thirty-second walkthrough, no auth needed
```

State lives in `$PODIUM_HOME` (default `~/.podium`): `jobs/<id>/`, `log.jsonl`,
`log.jsonl.head`.

## Things that are load-bearing and non-obvious

- **Durability comes from being orphaned.** Jobs launch via `nohup` with an
  exiting parent so init adopts them. The test asserts the worker's parent pid
  is `1`. Do not "fix" this by keeping the parent alive.
- **`is_settled()` is the single definition of a terminal state.** Adding a
  status without adding it there strands `--wait` in an infinite loop. That
  already happened once.
- **Environment beats config beats default.** Exported variables are captured at
  the very top of `bin/podium`, before the defaults block, because assigning to
  an already-exported name overwrites the exported value.
- **Receipts are hash-chained**, with the newest hash in a separate
  `log.jsonl.head` — nothing chains to the last line yet, so without the head
  file, editing the most recent receipt goes unnoticed. Appends take an atomic
  `mkdir` lock; concurrent settles would otherwise fork the chain.
- **`rate_limited` is not `timeout`.** A throttled executor and a hung one look
  identical from outside and are different problems.
- **Pi's RPC mode is strict JSONL, LF only.** Node's `readline` also splits on
  U+2028/U+2029, which are legal inside JSON strings. `desktop/lib/orchestrator.js`
  splits by hand and a test proves a payload carrying both survives.
- **The executor config has no unit coverage by nature** — the stand-in executor
  never parses flags. `podium doctor --executor` exists because `pi --cwd`, a
  flag that does not exist, shipped in v0 and would have killed every job.
  Run it after changing `podium_executor()`.

## Working on this

```sh
./test/run.sh                 # runner:  86 assertions
cd desktop && npm test        # bridges: 51 assertions
cd desktop && npm run smoke    # the UI:  13 assertions + screenshots (needs xvfb on Linux)
./demo.sh                     # see the whole argument in 30 seconds
```

None of these calls a real model. CI runs all three on macOS and Linux.

**Before claiming anything works, run it.** This project exists because agents
assert completion. Holding it to a lower standard than it holds its own bots
would be absurd. Two shipped bugs — the `--cwd` flag and the `*.md` ignore rule
that silently dropped the bot roster from a commit — were both "obviously fine"
until someone looked.

## Style

Match the surrounding code: POSIX shell in `bin/`, CommonJS in `desktop/`, no
dependencies unless they earn their place. Prose in docs and bot prompts is
plain and direct — no throat-clearing, no marketing. State limitations where a
reader would otherwise assume more.

## Where it stands

Runner, extension, console, receipts and CI are done and green on macOS and
Linux. The Pi extension is confirmed loading in pi 0.84.2.

**Not yet earned:** a job that produces real work from a live model. Everything
to date is proved with a stand-in executor or an unauthenticated `pi`.

Honest limits, stated in the README rather than hidden: an acceptance check is
only as good as its author; the concurrency cap is still a prompt rather than a
mechanism; there is no sandbox by default; and fanning out multiplies token
spend against a subscription priced for one person.
