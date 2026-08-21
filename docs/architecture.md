# Podium: architecture and build order

The goal: one agent you talk to, which runs a roster of persistent specialist
bots, on subscriptions you already pay for, with the work auditable afterwards.

## Design decisions, settled first

These are the expensive-to-reverse ones. Everything else follows from them.

> **Decision 1 was reversed on 2026-08-21.** The record below stays as written,
> because the reasoning was sound and the reversal is the interesting part. Read
> the note under it before you act on it.

**1. Pi is the harness, not Claude Code.** Not because Claude Code is worse at
coding - because Pi is a harness and Claude Code is a product. Pi exposes the
agent loop, the provider layer and the session store as primitives, ships OAuth
for seven subscription providers, and has an extension API that can register
tools rather than only hooks. See `research.md` section 4.

**Reversed.** Claude Code is the harness. Three things falsified the decision:

- The decision was never expensive. `podium_executor()` takes five arguments and
  maps them onto any CLI, so the harness was always one function body. The cost
  of reversal was a config file, not a rewrite.
- The extension was not needed. Pi needed 243 lines of TypeScript to learn the
  tools. Claude Code runs `podium` with the Bash tool it already has. A skill
  teaches the loop. The extension was deleted, not ported.
- Pi was never installed on the machine this was built for. The harness argued
  for over a page of prose had not been run once, while two authenticated CLIs
  sat idle. That is the failure this project exists to catch, committed by the
  project itself.

What survives is the part that mattered: the runner does not care which harness
orchestrates it or which executor does the work.

**2. Durability is a property, not a hope.** A background job whose lifetime is
tied to the agent session is not durable, which is the lesson Baton already paid
for. Podium detaches through `nohup` and an exiting parent so init adopts the
worker, and the test suite asserts a parent pid of 1 rather than trusting it.

**3. A bot is a directory, not a database row.** Prompt, memory and workspace are
files on disk. You can read them, diff them, put them in git, and edit one with a
text editor. Grok Bot's equivalent state is inside xAI.

**4. The orchestrator never does delegable work.** This is the discipline Baton
packages, generalised from one executor to a roster. The orchestrator briefs; the
bots write. Without this the system degrades into one agent that occasionally
shells out.

**4b. Verification is a mechanism, not a prompt.** This decision replaced an
earlier, weaker one, and it is the reason the project is worth building at all.

The first draft put "verify before reporting done" in the chief-of-staff system
prompt. That fails this project's own standard. A prompt is an aspiration a model
may drop under context pressure, it produces nothing observable, and any of the
five competitors in `research.md` section 4b could paste the same paragraph tomorrow.
Judged by "find the observable version of your claim and check it", it was not a
differentiator - it was a rationalisation.

So the check moved into the runner. `podium run --check "<command>"` records a
shell command; when the bot finishes, **bash runs it**, in the job's working
directory, and writes the exit code and verdict to disk and to the ledger. A
non-zero exit turns the job `rejected` no matter what the bot claimed or what
exit code the executor returned. Neither the bot nor the orchestrator can mark
work verified.

Three verdicts, deliberately not collapsible:

| verdict | means |
|---|---|
| `verified` | a check ran and exited 0 |
| `failed_check` | a check ran and failed - job is `rejected` |
| `unverified` | no check passed; nothing confirms the work |

`unverified` is not a soft pass. A job that finished cleanly with no check is
recorded as unverified forever and surfaces under `podium ledger --unverified`.

**4b-ii. The ledger is hash-chained, not signed.** A plain appended file is a
log, not an audit trail: any editor can rewrite `failed_check` into `verified`.
Each receipt now carries the SHA-256 of the one before it, and the newest hash
lives in a separate `log.jsonl.head` because nothing chains to the last line yet.
`podium audit` walks the chain and names the first break. Appends take an atomic
`mkdir` lock - parallel jobs settling in the same instant would otherwise chain
to the same tail and fork the chain.

Ed25519 signing, which Nobulex and the Agent Receipts protocol use, was
considered and rejected. Signing exists so a third party can verify without
trusting the operator. Podium runs on your machine for you: the threat is a bad
edit or a torn write, not an adversary with your filesystem. Hashing catches
those with no keys and no dependencies, and the README claims exactly that and
nothing more.

**4c. A check the model wrote can still be worthless.** Enforcement stops a bot
lying about the outcome; it cannot stop an orchestrator writing `--check true`.
The mitigation is visibility, not cleverness: every check is stored verbatim in
the ledger and shown in the console, so a vacuous one is legible rather than
laundered into a green tick. The orchestrator prompt names this failure directly
and tells it to prefer no check over a fake one.

**5. Models are configuration; discipline is fixed text.** Model names go stale
in weeks. The invariants - smallest diff, acceptance check in every brief, verify
before reporting done, never paste logs upward - are the product and are not
interview-able.

**6. No credential handling, ever.** Podium never reads, prints, copies or stores
a secret. You run `pi /login` yourself. This costs a little setup convenience and
removes the entire class of problem.

## The layers

```
   you --> Claude Code --> podium --> detached job --> executor --> bot
           (chief of staff)  (runner)                  (subscription)
              |                 |
              |                 +-- jobs/<id>/  brief, system prompt, output, meta
              |                 `-- log.jsonl   one line per settled job
              |
              `-- podium bots | run --check | status | result | ledger
```

**Layer 0 - Harness.** Pi. `/login` against Codex, Copilot, xAI or a flat-rate
coding plan. Nothing here is written by you.

**Layer 1 - Bots.** `~/.podium/bots/<name>/`:
- `bot.md` - YAML frontmatter (name, description, tools, model) plus the system
  prompt as the body
- `memory.md` - durable notes, appended by the orchestrator via `remember`, and
  prepended to the system prompt on every future job
- `workspace/` - the bot's own directory, persisting between jobs

Five ship by default: scout, implementer, reviewer, researcher, scribe. Adding a
bot means writing a markdown file.

**Layer 2 - Runner.** `bin/podium`, zero-dependency bash. `run`, `status`, `show`,
`brief`, `result`, `list`, `bots`, `cancel`, `verify`, `ledger`, `doctor`.
Detached execution, a hard-timeout watchdog, runner-executed acceptance checks,
throttle classification, and one JSONL receipt per settled job. The executor is a
shell function in `podium.conf`, so swapping Codex for Claude or pi is a five-line
edit.

Two behaviours here are load-bearing and were each found by a test rather than by
design:

- **One definition of "settled".** `is_settled()` is the single list of terminal
  states. Adding `rejected` without it stranded `--wait` in an infinite loop, and
  the suite caught it. Every waiter now shares the one definition.
- **Environment beats config beats default.** Exported variables are captured
  before the defaults block runs, because assigning to an already-exported name
  overwrites the exported value - so `PODIUM_REQUIRE_CHECK=1 podium run` was
  silently ignored until the capture moved to the top of the file.

**Layer 2b - Throttle classification.** An executor killed at the hard timeout is
`timeout`; one whose output matched a rate-limit pattern before the kill is
`rate_limited`. These look identical from the outside and are completely
different problems. Fanning out three specialists against a subscription priced
for one interactive human is the highest-risk assumption in this whole design,
and starvation reported as a hang would send you debugging the wrong thing.

**Layer 3 - Orchestrator.** *(revised 2026-08-21, with decision 1.)* Originally a
pi extension registering five tools: `roster`, `delegate`, `check`, `collect`
and `remember`. That extension is deleted. Claude Code runs `podium` with the
Bash tool it already has, so the five tools became five commands and 243 lines
of TypeScript became none. The chief-of-staff prompt survives as a Claude Code
skill, and it still tells the orchestrator to return paths rather than paste
output, which is what keeps its context from filling with other agents' logs.

**Layer 4 - Memory.** Looma. Per-bot session history becomes token-budgeted
context packs, injected as "what we did last time". This is the layer that turns
a roster of stateless workers into something that accumulates. It is also the
part you have already built and the part Grok Bot fakes with shared browser
state.

**Layer 5 - Surface.** Two, plus one off the shelf.

*The desktop console* (`desktop/`) is an Electron app: a narrow main/preload/
renderer split, no Node in the renderer, and a strict CSP. The main process owns
the podium CLI and a `pi --mode rpc` child; the renderer is a pure view over a
typed IPC surface. Three views - **Talk** (the front door, because a read-only
dashboard is a thing you open twice), **Roster**, and **Receipts**. Delegated
jobs sit on the right with their verdict badge.

The transport carries one non-obvious rule: Pi's RPC mode is strict JSONL with LF
as the *only* delimiter, and Node's `readline` also splits on U+2028 and U+2029,
which are legal inside JSON strings. Using it would corrupt any message
containing them. The client splits by hand, and a test proves a payload with both
separators survives as one record.

*pi-chat* gives Discord and Telegram for free. You message the orchestrator from
your phone; it delegates on a machine at home; jobs survive your phone locking,
because they were never tied to it.

**Layer 6 - Sandbox.** Optional. Gondolin micro-VM per channel, already wired
into pi-chat, if you want bots that cannot touch your real filesystem.

## Where this beats Grok Bot

- **Cost.** Runs on subscriptions you have, against $300/month for SuperGrok
  Heavy with an unpublished weekly allowance and metered overflow.
- **Auditability.** `log.jsonl` tells you which bot ran what, on which model, for
  how long, and whether it failed. Grok Bot tells you nothing.
- **Verification.** A first-class step with a named owner. Grok Bot has no
  equivalent; it reports what the sub-agent said.
- **Portability.** Bots are markdown. Executors are a shell function. When a
  better model or CLI appears you change one line, rather than waiting for xAI.

## Where Grok Bot beats this

Worth being straight about.

- **Real app access.** Grok Bot drives Gmail, Notion and Calendar through a
  browser with your logins. Podium has no equivalent and building one is a
  bigger project than everything above.
- **Zero setup.** Four minutes to first bot. Podium is an install and an
  interview.
- **Always-on infrastructure.** Their bots run in xAI's cloud. Yours run on a
  machine you keep awake.

If browser-driving real SaaS apps is the actual need, this is the wrong project
and you should pay the $300. If the need is a chief of staff that farms coding
and research work out to specialists and proves it did the work, this is better
and roughly free.

## Build order

Each step ends in something demonstrable. Do not start the next one until the
current one is proved.

**Step 1 - Harness and auth.** *(30 min)*
Install pi, `/login` with Codex, run one interactive session. Proof: pi answers
using your ChatGPT subscription, no API key set.

**Step 2 - Runner and verification.** *(done)*
`bin/podium` plus the test suite. Proof: `./test/run.sh` is 68/68 green,
including a live assertion that a detached worker's parent pid is 1 after its
launching shell exits, and that a job whose executor exited 0 is still `rejected`
when its acceptance check fails.

**Step 2b - Desktop console.** *(done, unsigned)*
`desktop/` plus 52 assertions and a headless smoke test that drives every view
and writes screenshots. Proof: the smoke run reports the right verdict badges and
the console's unverified count matches `podium ledger --unverified` exactly.
Not notarized - macOS needs a right-click -> Open the first time.

**Step 3 - One bot, one job, one executor.** *(1 hour)*
Point `podium.conf` at real Codex. Run `podium run scout "..."` against a real
repository. Proof: `podium result` contains a real report and `log.jsonl` gained
a well-formed line.

**Step 4 - The orchestrator.** *(2 hours)*
Install the extension and the skill. Proof: from a pi session, "have scout map
the auth code, then have the implementer add a null check" produces two job ids,
two results, and a verification step you can see it perform.

**Step 5 - Parallel and chained work.** *(1 hour)*
Three scouts at once on different subsystems; a scout -> implementer -> reviewer
chain. Proof: three ids returned before the first finishes; the reviewer's brief
visibly contains the implementer's output.

**Step 6 - Memory.** *(2 hours)*
Wire Looma to emit a context pack per bot and prepend it the way `memory.md` is
prepended. Proof: a bot references a decision from a previous session it was
never told about in this one.

**Step 7 - The phone.** *(2 hours)*
Install pi-chat, create a Telegram bot, connect it to the orchestrator session.
Proof: you delegate from your phone, close Telegram, and collect the result an
hour later.

**Step 8 - Harden.** *(ongoing)*
Concurrency cap in the runner rather than only in the prompt. Retry on transient
executor failure. A `podium doctor`. Gondolin for bots that should not see your
filesystem.

Steps 1-5 are a weekend and get you the thing you actually asked for. 6 and 7 are
what make it feel like Grok Bot rather than a job queue.

## Known weaknesses in v0

Stated so they do not get discovered later as surprises.

- **Subscription capacity is the highest-risk assumption in the design.** An
  orchestrator plus three specialists burns roughly 4x against limits priced for
  one interactive human. The likely first-real-workday failure is exhausting the
  window by mid-morning, with throttled workers indistinguishable from hangs.
  Podium mitigates the *diagnosis* (`rate_limited` is its own status) but cannot
  mitigate the *cause*. Nothing overnight fixes this; only running it will show
  the real ceiling.
- **A check is only as good as its author.** Enforcement proves the check passed,
  never that it was worth running. Mitigated by storing every check verbatim, not
  solved.
- **The concurrency cap is still a prompt.** `{{MAX_PARALLEL}}` asks the
  orchestrator to behave; nothing stops it launching twenty jobs. This belongs in
  the runner and is step 8.
- **One sandbox boundary, and only one.** A bot with no `write` or `edit` in its
  `tools:` runs read-only and genuinely cannot write. Past that, a writing bot
  runs with your permissions under its working directory, which defaults to
  wherever `podium run` was invoked.
- **`cancel` kills the worker, not necessarily its grandchildren.** An executor
  that spawns its own children can leak them. It does now write a receipt before
  it goes, so a cancelled job is recorded rather than vanishing.
- **The desktop app is unsigned and un-notarized.** Fine for you; a bad first
  impression for a stranger, against competitors shipping signed installers.
- **Untested against a live model.** Everything is proved with a fake executor.
  Step 3 is where that claim gets earned.

## What the review changed

The design was put to a stronger reasoning model as a critic before this
revision, the same way Baton was. Three of its findings changed the build:

1. **"Verification is first-class" was a rationalisation.** It lived in a prompt
   and produced nothing observable. This became decision 4b, and is now the
   project's only defensible differentiator.
2. **A live-fanout "mission control" is a dashboard nobody opens twice.** The
   console was rebuilt conversation-first, with the receipts as the reason it
   exists rather than a radar screen as the centrepiece.
3. **Name the competition in the README and send some users to it.** Done. If you
   want a polished desktop Grok Bot today, OpenMausBot is the better answer, and
   the README says so.

It also argued for cutting the desktop app entirely on the grounds that an
unsigned overnight Electron shell competes badly with signed installers. That one
was overruled: a UI was asked for, it is for personal use rather than
distribution, and it is tested. The signing gap is documented instead of hidden.
