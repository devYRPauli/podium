# Podium

Verified delegation, driven by Claude Code. A chief-of-staff agent hands briefed
work to a roster of persistent bots, and the **runner** - bash, not a model -
decides whether the work landed.

There is no extension. Claude Code runs `bin/podium` with the Bash tool it
already has, guided by a skill.

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
| `failed_check` | a check ran and failed - job status becomes `rejected` |
| `unverified` | no check passed; nothing confirms the work |

`unverified` is never a soft pass. A job that finished cleanly with no check
stays unverified forever and surfaces under `podium ledger --unverified`.

## Layout

```
bin/podium              the runner. Zero deps beyond bash + coreutils. POSIX only.
bots/<name>/bot.md      a bot: YAML frontmatter + system prompt as the body
templates/              rendered at install time by SETUP.md. Slots are {{LIKE_THIS}}
  podium.conf.tmpl        defines podium_executor() - how a job actually runs
  ORCHESTRATOR.md.tmpl    the chief-of-staff prompt, installed as a Claude Code skill
desktop/                Electron console. main/preload/renderer split, no Node in the renderer
test/run.sh             the runner suite - 102 assertions against a stand-in executor
test/ascii.sh           repo hygiene: every tracked file is plain ASCII. CI runs it.
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
  `log.jsonl.head` - nothing chains to the last line yet, so without the head
  file, editing the most recent receipt goes unnoticed. Appends take an atomic
  `mkdir` lock; concurrent settles would otherwise fork the chain.
- **`rate_limited` is not `timeout`.** A throttled executor and a hung one look
  identical from outside and are different problems.
- **A job's cwd defaults to wherever `podium run` was invoked**, not to the bot's
  `workspace/`. A detached job with a writing executor will edit the repository
  you were standing in, and it keeps doing so after you close the terminal. Pass
  `--cwd` when that is not what you want. `podium run` prints the bot, the
  directory and the write policy to stderr before it detaches, so the surprise
  happens before the job does. Keep that on stderr: callers capture the job id
  from stdout.
- **A bot's `tools:` frontmatter is enforced through the executor, at the
  executor's grain.** The runner derives one boolean, "may this bot write", from
  whether the list contains `write` or `edit`, exports it as
  `PODIUM_BOT_WRITES`, and the executor turns it into a sandbox flag. That is a
  real boundary: a read-only bot cannot create a file even when the brief tells
  it to, proved live against codex with a neutral prompt. Two limits worth
  stating: the grain is coarse under codex (read-only or read-write, nothing
  finer), and an executor that ignores the variable silently enforces nothing,
  which is why `doctor` warns about exactly that. A bot with no `tools:` line is
  unrestricted, because tightening that would silently break existing rosters.
- **`JOB_TOOLS` and `JOB_WRITES` must stay defaulted where the worker reads
  them.** `set -u` is on. A job queued by an older podium has neither in its
  `meta.env`, and a bare reference killed the worker mid-flight: the job stranded
  in `running`, which is not settled, so `--wait` hung and no receipt was ever
  written. A test now runs the worker against a pre-upgrade `meta.env`. Any new
  `JOB_` field needs the same treatment.
- **The desktop console's chat pane still drives `pi --mode rpc`.** It is the one
  Pi dependency left. Pi's RPC mode is strict JSONL, LF only, and Node's
  `readline` also splits on U+2028/U+2029, which are legal inside JSON strings.
  `desktop/lib/orchestrator.js` splits by hand and a test proves a payload
  carrying both survives. The ledger and receipt views need no Pi, so `main.js`
  preflights the harness binary and says what is missing rather than surfacing
  `spawn pi ENOENT`, which reads like the whole console is broken.
- **The executor config has no unit coverage by nature** - the stand-in executor
  never parses flags. Three real bugs have shipped there: `pi --cwd`, a flag that
  does not exist; a Codex line that dropped `$5` and silently ran every bot as
  nobody; and a Codex line with no `-s workspace-write`, so the implementer bot
  could not write a byte. `podium doctor --executor` now separates a bad flag, a
  missing login and a read-only sandbox. Run it after changing
  `podium_executor()`.

## Working on this

```sh
./test/ascii.sh               # hygiene: plain ASCII everywhere
./test/run.sh                 # runner:  102 assertions
cd desktop && npm test        # bridges: 51 assertions
cd desktop && npm run smoke   # the UI:  13 assertions + screenshots (needs xvfb on Linux)
./demo.sh                     # see the whole argument in 30 seconds
```

None of these calls a real model. CI runs all four, on macOS and Linux.

**Before claiming anything works, run it.** This project exists because agents
assert completion. Holding it to a lower standard than it holds its own bots
would be absurd. Every bug listed above was "obviously fine" until someone
actually invoked the thing.

## Style

Match the surrounding code: POSIX shell in `bin/`, CommonJS in `desktop/`, no
dependencies unless they earn their place.

### Plain ASCII, everywhere, enforced

Every tracked file is plain ASCII. No em dashes, no en dashes, no smart quotes,
no ellipsis characters, no arrows, no middots, no box-drawing characters, no
emoji. Draw diagrams with `-`, `|`, `+` and a backtick.

`./test/ascii.sh` enforces this and runs in CI beside the other suites. Run it
before you commit. It allowlists exactly one file, `desktop/test/orchestrator.test.js`,
which embeds U+2028 and U+2029 deliberately, and it also fails if that file ever
stops containing them.

### Simplified Technical English

All prose - docs, README, bot prompts, code comments, commit messages - follows
ASD-STE100:

- One idea per sentence. About 20 words maximum.
- Active voice. "The runner executes the check", not "the check is executed".
- The same word for the same thing every time. A `check` stays a `check`. A
  `verdict` stays a `verdict`. Never reach for a synonym for variety.
- Simple tenses. Present, past, future. No perfect or continuous forms.
- Keep the articles. Prefer a list or a table over a long sentence.
- State facts, numbers and measured results. Do not editorialise.

Banned: opening filler ("This PR aims to"), connective filler ("Additionally",
"Furthermore", "It is worth noting"), hedging ("arguably", "essentially", "it
seems"), inflation ("robust", "seamless", "comprehensive", "leverage",
"utilize"), and a closing paragraph that repeats what the text already said.

Prose is plain and direct. State limitations where a reader would otherwise
assume more.

## Where it stands

Runner, console, receipts and CI are done and green on macOS and Linux.

**Proved live on 2026-08-21.** Podium ran seven real jobs through `codex exec`
on a ChatGPT subscription. Five reached `verified`. Two reached `rejected /
failed_check` with `exit_code=0`, which is the entire thesis: the bot exited
cleanly and the runner overrode it. A detached worker's parent pid was 1. The
receipt chain stayed intact throughout.

Three of the verified jobs changed this repository: the `doctor --executor`
write probe, the repository-wide ASCII conversion, and tool-policy enforcement.

**Role boundaries are now real, and were proved the only way that counts.** Two
probe bots with identical neutral prompts, differing only in `tools:`, were each
told to create a file. The read-only one could not. Testing this with `scout`
would have proved nothing, because scout's prompt already tells it never to
change anything: a pass could have meant the sandbox worked or that the model
politely declined. Isolate the boundary from the persuasion or you are measuring
the wrong thing.

Four things that run taught us, all worth keeping:

- **The brief is the first suspect.** One rejected job was a scribe that found a
  contradiction in its own brief and stopped. The bot was right and the brief
  was wrong.
- **A detached bot cannot ask a question.** That scribe asked one. Nobody was
  listening, so the question became a failed job. Briefs for detached work must
  say what to do when something is ambiguous.
- **A check you wrote can still be vacuous.** One assertion in a hand-written
  acceptance check used a broken bracket expression and passed on every input.
  It was an ASCII check that could not detect a non-ASCII character. Run a check
  against a known-bad input before you trust it.
- **A green check is not a review.** Tool-policy enforcement passed every
  assertion and still stranded any job queued before the upgrade, because every
  test builds a fresh job and none simulated a migration. The check tested the
  feature; nobody had asked what the change did to work already in flight.

**Fan-out measured, same day.** The same four jobs ran once in sequence and once
at once: 93s against 22s, a 4x speedup over 4 jobs, zero `rate_limited`, all
eight verified. Concurrency works and four-way fan-out is not throttled. Two
limits on that number: the parallel jobs happened to be individually faster
(17s average against 22s), which is latency variance rather than a real
superlinear effect, and every job was tiny. Four concurrent jobs the weight of
the 872-second one are untested, and finding that ceiling costs real quota.

The honest note on cost, and the fan-out number sharpens it rather than
softening it: writing the brief and an independent check took longer than either
task took to run. **Parallelism amortizes the waiting, not the supervision.**
Four jobs at once still cost four briefs and four checks to save 71 seconds. So
the value is not "parallel tasks". It is *long* parallel tasks, where execution
dominates supervision, plus tasks you would otherwise never have verified at
all. Delegating one short task remains a net loss.

**Not yet earned:** any measurement of this running unattended over hours rather
than minutes, and a Talk pane that works without Pi.

Honest limits, stated in the README rather than hidden: an acceptance check is
only as good as its author; role boundaries are only as fine as the executor's
sandbox; the concurrency cap is still a prompt rather than a mechanism; and
fanning out multiplies token spend against a subscription priced for one person.
