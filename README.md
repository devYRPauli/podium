# Podium

*Verified delegation driven by
[Claude Code](https://code.claude.com/docs/en/overview). A chief-of-staff agent
hands work to a roster of persistent bots, and a runner - not a model - decides
whether the work actually landed.*

You talk to one agent. It writes a brief, hands it to a specialist bot, and comes
back with an answer. Every job carries an acceptance check that **the runner
executes**, so "done" is a verdict rather than a claim. Jobs are detached and
survive the session that launched them. Every settled job leaves a receipt.

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
  desktop for Pi with worktrees, diffs and an integrated terminal. If you want a
  coding IDE around Pi, this is it, and Podium's tools show up inside it because
  they are ordinary Pi tools.
- **[CopilotKit/OpenBot](https://github.com/CopilotKit/openbot)** - governance
  first. Every action is checked against a CEL policy *before* it runs, with an
  audit row written first and a container plus browser profile per bot. If your
  problem is "what is this agent allowed to touch", that is the answer, and it is
  a different problem from this one.

Three different problems get called trust. OpenBot answers *may the agent do
this?* Agent Receipts and Nobulex answer *can the record be edited afterwards?*
Podium answers the third: **did the work actually land?**

It is for one thing those do not do: **it will not let an agent tell you the
work is done.** A job is verified only when a shell command the runner ran exited
zero. Everything else is recorded as unverified, permanently, and is one query
away. If that distinction does not matter to you, use one of the above.

It is also small on purpose - a few hundred lines of bash and one skill file,
readable in a sitting, with no database, no daemon and no server.

## What it does

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
  orchestrator session.
- **The runner runs the acceptance check**, not the bot and not the orchestrator.
  A failing check turns the job `rejected`, whatever the bot reported.
- **Throttling is not a hang.** A job killed while its output shows a rate limit
  settles as `rate_limited`, so starvation never gets debugged as a crash.
- **A bot's `tools:` list is enforced, not advised.** A bot with no `write` or
  `edit` runs in a read-only sandbox and cannot create a file even when the brief
  tells it to. The receipt records which policy applied. The grain is the
  executor's: `codex` gives read-only or read-write, `claude` gives a per-tool
  list. A bot with no `tools:` line is unrestricted.

## Status

v0, honestly labelled:

- **Runner: complete and tested.** 108 assertions, including a live check that a
  detached worker's parent pid becomes 1 after its launching shell exits, that a
  failed acceptance check rejects a job whose executor exited 0, and that editing
  or deleting a receipt is detected.
- **Desktop console: works, unsigned.** Boots, renders, and is smoke-tested
  headless with screenshots on every view. Not notarized, so macOS will need a
  right-click -> Open the first time.
- **Claude Code skill: complete.** The Pi extension is gone. Claude Code needs no
  extension. `templates/ORCHESTRATOR.md.tmpl` teaches it to run `podium` with the
  Bash tool it already has.
- **Live model: 19 jobs.** On 2026-08-21, Podium ran 19 real jobs through Codex.
  17 reached `verified`, and four of those changed this repository. Two reached
  `rejected / failed_check` with `exit_code=0`; the runner overrode a clean
  executor exit both times. A detached worker's parent pid was 1. The receipt
  chain stayed intact across all 19.
- **Fan-out measured, twice.** Four light jobs: 93s in sequence against 22s at
  once. Four heavy jobs of 220 to 357 seconds each: 1248s of work in 359s of
  wall clock, a 3.5x speedup. No throttling in either round. The ceiling above
  four concurrent jobs is untested, because finding it costs real quota.
- **Executor preflight: three failures separated.** `podium doctor --executor`
  distinguishes a bad flag, a missing login, and a read-only sandbox.
- **It found two of its own bugs.** The four heavy jobs were reviewers, one per
  subsystem. They reported that the desktop console dropped every acceptance
  check before it reached the runner, and that cancelling a job left no receipt
  at all. Both were real, both are fixed, and both broke the one rule this
  project has.

## Requirements

macOS or Linux with bash and coreutils. The durability guarantee rests on
`nohup`, `ps` and process reparenting, so Windows is out rather than faked.

Install an executor CLI and log in to it. The default is `codex exec`, using a
ChatGPT subscription. `templates/podium.conf.tmpl` keeps Claude Code and pi as
commented alternatives.

Podium never reads, stores or passes a credential. You run the executor's login
command.

[docs/research.md section 5](docs/research.md) covers what each subscription
costs you under a third-party harness, including the Claude caveat. Read it
before you fan out.

## Install

Read [`docs/SETUP.md`](docs/SETUP.md) first - it is short, and it describes an
agent writing files into your configuration. Then point your agent at this
directory:

> Set up Podium from this repo.

It interviews you, lists every file it will write, asks once, installs, and ends
with a live acceptance test.

## Using the runner directly

```
$ podium bots
scout          Fast codebase recon. Returns compressed, structured context.
implementer    Writes code against a brief. Smallest change that passes.
reviewer       Reviews a change for correctness and scope creep.

$ podium run implementer "Add a null check to parse() in src/parser.ts" \
    --check "npm test -- parser"
20260821-052308-155126519

$ podium status 20260821-052308-155126519
id=... bot=implementer status=done verdict=verified duration_secs=41 exit_code=0

$ podium ledger --unverified
20260821-052315-157325573  researcher   rate_limited  unverified
20260821-052313-1565818314 implementer  rejected      failed_check  exit 1
20260821-052311-155861591  reviewer     done          unverified
```

That last command is the point of the whole project. The third row is a job that
finished successfully and proved nothing.

`podium doctor` preflights everything, and `podium doctor --executor` actually
invokes your executor and tells a configuration bug apart from a missing login:

```
$ podium doctor --executor
FAIL  the executor rejected its own arguments - podium.conf is wrong
      Error: Unknown option: --cwd

$ podium doctor --executor
WARN  the executor runs, but is not authenticated
      UnrecognizedClientException: The security token included in the request is invalid.
```

Run it before your first job, and after any change to `podium_executor()`. An
executor you have not invoked is an executor you have not tested - that exact
`--cwd` line shipped in v0 and would have killed every job launched with the
default config.

Plain `podium doctor` also checks statically that your executor reads `$5`, the
bot's system prompt and memory. An executor that ignores it does not fail; it
returns confident, generic output from the wrong persona, which is a much worse
failure than a crash. The Codex example shipped in v0 with exactly that bug.

`podium doctor` preflights everything. `podium verify <id>` re-runs a recorded
check by hand. Set `PODIUM_REQUIRE_CHECK=1` to refuse any job launched without
one.

Receipts are hash-chained, so the ledger is tamper-evident:

```
$ podium audit
79 receipt(s), chain intact.
head: 6a08b11f99f439be4b3ac36d58f481de858cbb4795b0a2ab3c80f8451e027c2d
```

Each receipt carries the SHA-256 of the one before it, and the newest hash is
kept separately because nothing chains to the last line yet. Editing a verdict,
deleting a receipt, or truncating the file are all detected and located. This is
hashing, not signing - it catches a bad edit or a torn write, not an adversary
with write access to the whole directory. If you need the stronger property,
[Agent Receipts](https://github.com/agent-receipts/obsigna) and
[Nobulex](https://github.com/nobulexdev/nobulex) do Ed25519 properly.

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

## Tests

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
`xvfb-run` on Linux.

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
