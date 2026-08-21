# Podium

*Verified delegation for [Claude Code](https://code.claude.com/docs/en/overview).
One agent hands briefed work to a roster of bots, and a shell command - not a
model - decides whether the work actually landed.*

You give the chief of staff a task. It writes a brief, hands it to a specialist
bot, and comes back with an answer. Every job carries an acceptance check that
**the runner executes**, so "done" is a verdict rather than a claim. Jobs are
detached and outlive the session that launched them. Every settled job leaves a
receipt.

## The moment it exists for

```
$ podium ledger --unverified
20260821-052315-157325573  researcher   rate_limited  unverified
20260821-052313-1565818314 implementer  rejected      failed_check  exit 1
20260821-052311-155861591  reviewer     done          unverified
```

Look at the third row. That job ran to completion, exited cleanly, and reported
success. No check ever ran, so nothing confirms it did anything at all. It stays
on that list forever.

Three verdicts, and they never collapse into each other:

| verdict | means |
|---|---|
| `verified` | a check ran and exited 0 |
| `failed_check` | a check ran and failed, so the job is rejected whatever the bot claimed |
| `unverified` | no check passed, so nothing confirms the work |

`unverified` is never a soft pass.

## See it work first

No model, no auth, no config. Thirty seconds:

```sh
./demo.sh              # run five jobs and print the receipts
./demo.sh --console    # the same, then open the desktop console on it
```

It uses a stand-in executor, so nothing calls a real model and your `~/.podium`
is untouched. It delegates five jobs - two that pass their acceptance check, one
given no check at all, one whose check fails, and one that gets rate limited -
then shows you which of them actually proved anything, and finally edits the
ledger in front of you so you can watch `podium audit` catch it.

## Getting started

macOS or Linux with bash and coreutils. The durability guarantee rests on
`nohup`, `ps` and process reparenting, so Windows is out rather than faked.

You need one executor CLI, installed and logged in. The default is `codex exec`
on a ChatGPT subscription; `templates/podium.conf.tmpl` keeps Claude Code and pi
as commented alternatives. Podium never reads, stores or passes a credential.
You run the login command.

Then point your agent at this directory:

> Set up Podium from this repo.

It follows [`docs/SETUP.md`](docs/SETUP.md): it interviews you, lists every file
it will write, asks once, installs, and ends with a live acceptance test. Read
that file first if you would rather see what it is about to do.

Once installed, a new Claude Code session picks up the skill and you can simply
ask it to delegate something. Or drive the runner yourself.

## Using it

```
$ podium bots
scout          Fast codebase recon. Returns compressed, structured context.
implementer    Writes code against a brief. Smallest change that passes.
reviewer       Reviews a change for correctness and scope creep.

$ podium run implementer "Add a null check to parse() in src/parser.ts" \
    --check "npm test -- parser"
podium: implementer may write in /Users/you/project
20260821-052308-155126519

$ podium status 20260821-052308-155126519
id=... bot=implementer status=done verdict=verified duration_secs=41 exit_code=0
```

**Write the check first, and make sure it fails.** A check that already passes
records nothing as verification. Red, then green, or the verdict is decoration.

`podium doctor` preflights everything. `podium doctor --executor` goes further
and actually invokes your executor, because an executor you have not invoked is
an executor you have not tested:

```
$ podium doctor --executor
FAIL  the executor rejected its own arguments - podium.conf is wrong
      Error: Unknown option: --cwd

$ podium doctor --executor
FAIL  the executor ran, but could not write a file
      Check the sandbox mode in podium_executor() in ~/.podium/podium.conf

$ podium doctor --executor
WARN  the executor runs, but is not authenticated
```

Those three look identical in a job log and are completely different problems.
Two of them have shipped here: that exact `--cwd` line, for a flag pi does not
have, and a Codex line missing its sandbox flag, which left the implementer bot
unable to write a byte.

Plain `podium doctor` also checks statically that your executor reads `$5`, the
bot's system prompt and memory. An executor that ignores it does not crash. It
returns confident, generic output from the wrong persona, which is worse.

`podium verify <id>` re-runs a recorded check by hand. Set
`PODIUM_REQUIRE_CHECK=1` to refuse any job launched without one.

Receipts are hash-chained, so the ledger is tamper-evident:

```
$ podium audit
79 receipt(s), chain intact.
head: 6a08b11f99f439be4b3ac36d58f481de858cbb4795b0a2ab3c80f8451e027c2d
```

Each receipt carries the SHA-256 of the one before it, and the newest hash is
kept separately because nothing chains to the last line yet. Editing a verdict,
deleting a receipt, or truncating the file are all detected and located. This is
hashing, not signing: it catches a bad edit or a torn write, not an adversary
with write access to the whole directory. If you need the stronger property,
[Agent Receipts](https://github.com/agent-receipts/obsigna) and
[Nobulex](https://github.com/nobulexdev/nobulex) do Ed25519 properly.

## How it works

```
  you --> Claude Code --> podium --> detached job --> executor --> bot
          chief of staff   runner         |                         |
                                          |                         `- prompt + memory
                                          +-- acceptance check (run by the runner)
                                          `-- log.jsonl  (the receipts)
```

- **A bot is a directory.** `bot.md` is its system prompt, `memory.md` is durable
  notes prepended on every future job, `workspace/` persists between jobs.
- **The runner detaches every job** through `nohup` and an exiting parent, so
  init adopts it and the work outlives your terminal, your editor, and the
  session that launched it.
- **The runner runs the acceptance check**, not the bot and not the orchestrator.
  A failing check turns the job `rejected`, whatever the bot reported.
- **A bot's `tools:` list is enforced, not advised.** A bot with no `write` or
  `edit` runs in a read-only sandbox and cannot create a file even when the brief
  tells it to. The receipt records which policy applied. The grain is the
  executor's: `codex` gives read-only or read-write, `claude` gives a per-tool
  list. A bot with no `tools:` line is unrestricted.
- **Throttling is not a hang.** A job killed while its output shows a rate limit
  settles as `rate_limited`, so starvation never gets debugged as a crash.

## What is in here

| path | what it is |
|---|---|
| `bin/podium` | the runner. Bash and coreutils, no other dependencies |
| `bots/<name>/bot.md` | a bot: YAML frontmatter, then its system prompt |
| `templates/` | `podium.conf` and the chief-of-staff skill, rendered at install |
| `desktop/` | the Electron console |
| `test/` | the suites, and the ASCII hygiene check CI runs |
| [`docs/SETUP.md`](docs/SETUP.md) | the installer an agent follows |
| [`docs/architecture.md`](docs/architecture.md) | the design decisions, including one that was reversed |
| [`docs/research.md`](docs/research.md) | what the alternatives do, and what each subscription costs |

State lives in `~/.podium`: one directory per job, plus `log.jsonl` and its head
hash.

## The desktop console

```sh
cd desktop && npm install && npm start
```

It opens on **Receipts**: every settled job with the check that ran and the
verdict it produced. **Roster** shows the bots and their memory. Delegated jobs
appear live on the right with their verdict badge.

The third view, **Talk**, needs a harness that speaks Pi's RPC protocol, and it
is the last part of this project that does. It drives `pi --mode rpc`; point it
at another binary with the `piBin` setting. Without one it says so plainly, and
the other two views work normally, because they read the ledger straight off
disk. If Claude Code is your orchestrator, your terminal already is the Talk
pane.

The receipts are why the console exists.

## Where it stands

v0, honestly labelled:

- **Runner: complete and tested.** 108 assertions, including a live check that a
  detached worker's parent pid becomes 1 after its launching shell exits, that a
  failed acceptance check rejects a job whose executor exited 0, and that editing
  or deleting a receipt is detected.
- **Live model: 19 jobs.** On 2026-08-21, Podium ran 19 real jobs through Codex.
  17 reached `verified`, and four of those changed this repository. Two reached
  `rejected / failed_check` with `exit_code=0`; the runner overrode a clean
  executor exit both times. The receipt chain stayed intact across all 19.
- **Fan-out measured, twice.** Four light jobs: 93s in sequence against 22s at
  once. Four heavy jobs of 220 to 357 seconds each: 1248s of work in 359s of
  wall clock, a 3.5x speedup. No throttling in either round. The ceiling above
  four concurrent jobs is untested, because finding it costs real quota.
- **It found two of its own bugs.** Those four heavy jobs were reviews, one per
  subsystem. They reported that the desktop console dropped every acceptance
  check before it reached the runner, and that cancelling a job left no receipt
  at all. Both were real, both are fixed, and both broke the one rule this
  project has.
- **Desktop console: works, unsigned.** Smoke-tested headless with a screenshot
  of every view. Not notarized, so macOS needs a right-click and Open the first
  time.

When it pays, measured rather than guessed: reach for it when you have **two or
more independent tasks that each take longer to run than to specify**. Below
that line, one delegated task costs more to brief and check than to just do.

## Should you use this?

Be honest with yourself first. There is a crowded field here and some of it is
better than this for most people:

- **[OpenMausBot](https://github.com/milind-soni/OpenMausBot)** - the closest
  thing to an open Grok Bot. A chat app where each contact is a real Claude,
  Codex or Grok CLI on your own subscriptions, with cloud desktops and 500+ app
  integrations. Signed installers for macOS, Windows and Ubuntu. **If you want a
  polished desktop Grok Bot today, install this instead.**
- **[Rakazo](https://github.com/elie222/rakazo)** - persistent AI teammates on
  web, desktop and mobile, with voice, routines and peer delegation. Needs
  Postgres, Docker and a server. Excellent if you want a platform.
- **[pi-gui](https://github.com/minghinmatthewlam/pi-gui)** - a Codex-style
  desktop for Pi with worktrees, diffs and an integrated terminal.
- **[CopilotKit/OpenBot](https://github.com/CopilotKit/openbot)** - governance
  first. Every action is checked against a CEL policy *before* it runs, with an
  audit row written first and a container plus browser profile per bot. If your
  problem is "what is this agent allowed to touch", that is the answer, and it is
  a different problem from this one.

Three different problems get called trust. OpenBot answers *may the agent do
this?* Agent Receipts and Nobulex answer *can the record be edited afterwards?*
Podium answers the third: **did the work actually land?**

It is for one thing those do not do: **it will not let an agent tell you the
work is done.** If that distinction does not matter to you, use one of the above.

It is also small on purpose: a few hundred lines of bash and one skill file,
readable in a sitting, with no database, no daemon and no server.

## Boundaries

- macOS and Linux only.
- Podium never handles secrets. Authentication is you, running the command.
- **A bot is confined only as well as its executor confines it.** A bot with no
  `write` or `edit` in its `tools:` runs read-only and is genuinely stopped from
  writing. Beyond that one boundary, bots share your filesystem: a writing bot
  can edit anything under its working directory, which defaults to wherever you
  ran `podium run`. Run the executor in a container if you need more, and check
  `podium doctor` - it warns when the configured executor enforces nothing.
- **An acceptance check is only as good as the person who wrote it.** The runner
  proves the check passed; it cannot prove the check was worth running. The
  ledger stores every check verbatim so a worthless one is visible rather than
  laundered.
- Fanning out multiplies token spend against a subscription priced for one
  person. Expect throttling before you expect failure, and read `rate_limited`
  in the ledger as exactly that.

## Working on it

```sh
./test/ascii.sh               # hygiene: every tracked file is plain ASCII
./test/run.sh                 # runner:  108 assertions
cd desktop && npm test        # bridges: 52 assertions
cd desktop && npm run smoke   # the UI:  13 assertions + screenshots
```

None of them calls a real model or touches your roster. The smoke test seeds a
throwaway home with one job of every verdict, boots the console in a headless
Electron, drives every view, captures a screenshot of each, and asserts that the
console's unverified count matches `podium ledger --unverified` exactly. It needs
`xvfb-run` on Linux. CI runs all four on macOS and Linux.

Licensed under the terms in [LICENSE](LICENSE).
