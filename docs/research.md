# Research: what Grok Bot actually is, and what it would take to have one

Compiled 2026-08-21. Sources are listed at the bottom; where reporting
disagrees, both versions are given rather than one being picked.

## 1. Grok Bot is not Grok 4 Heavy

These get conflated and they are different products solving different problems.

**Grok 4 Heavy** (July 2025, extended through Grok 4.20 in Feb 2026) is
*test-time compute*. One request spawns several agents on the same backbone -
four in 4.20, scaling to sixteen on SuperGrok Heavy - which explore hypotheses in
parallel, cross-check each other, and get synthesised into one answer. xAI claims
the internal debate cuts hallucination ~65% against single-pass inference. The
agents are ephemeral. They exist for the duration of one answer.

**Grok Bot** (August 2026) is *persistent coworkers*. You create named bots that
stay alive between conversations, hold their own memory, operate a cloud computer
with real logins to real apps, and hand work to each other. This is the thing
worth copying.

## 2. How Grok Bot is put together

- **Named, persistent bots.** Each has its own configuration, its own
  conversation history, and its own learned context. They persist across
  sessions.
- **The chief-of-staff pattern.** One bot is the entry point. You talk to it and
  nothing else. It does not do the work; it decides what work needs to happen,
  assigns sub-tasks to specialists, passes context between them, and assembles
  the result. xAI's own design guidance favours narrow single-purpose bots over
  one do-everything agent - the same conclusion Claude Code and Codex reached.
- **Handoff through group chats.** Bots exchange context and deliverables by
  being in a shared conversation, rather than through a formal message bus.
- **A cloud computer.** Bots browse, log into accounts, and run tasks
  independently of your laptop. **Reporting disagrees here**: several outlets say
  each bot gets a dedicated cloud computer; TechTimes reports one shared computer
  hosting up to 50 bots, with files, browser sessions and logins shared between
  them. The shared version matches the described behaviour better - bots learning
  from each other's interactions on shared accounts only makes sense if the
  accounts are shared.
- **Plugins over APIs.** Gmail, Drive, Calendar, Notion and so on are added
  through a plugin panel. The pitch is "any app, no API" - the bot drives the
  real web UI with your login rather than calling an integration.
- **Always on.** Work continues without your device involved.

## 3. What it costs

SuperGrok Heavy at **$300/month** is the documented access route; some Cursor
accounts are also eligible. There is no free tier, no trial, and no standalone
per-bot price. Eligible subscriptions include a weekly Grok Bot allowance whose
size xAI does not publish, and on-demand usage beyond it bills by model and
tokens through their managed router.

So: the subscription is an access floor, not a budget. That is the single
strongest argument for building your own.

## 4. The harness decision

The orchestrator has to run on something. Four candidates, judged on whether they
can host a persistent multi-bot system and bill against a subscription.

| | Claude Code | Codex CLI | Pi | Roll your own |
|---|---|---|---|---|
| Subscription auth | Yes, but only for itself | Yes (ChatGPT Plus/Pro) | Yes, **seven providers** | You build it |
| Sub-agents | Yes (Task tool) | Limited | Yes (subagent extension) | You build it |
| Persistent agent identity | No | No | No | - |
| Durable background jobs | No - die with the session | No | No | - |
| Extension API | Hooks, skills, MCP | Thin | Full TS API: tools, events, commands, UI | - |
| Embeddable SDK | Agent SDK | No | Yes (`createAgentSession`) | - |
| Headless protocol | `-p`, stream-json | `exec` | RPC mode (JSONL), JSON event mode | - |
| Chat surface | No | No | **pi-chat**: Discord + Telegram | You build it |
| Sandbox | Limited | Yes | Gondolin micro-VM, Docker, OpenShell | - |

**Pi wins, and not narrowly.** It is the only one of the four that is a *harness*
rather than a product: the agent loop, provider abstraction, session store and
TUI are exposed as composable primitives. Its own tagline is "adapt pi to your
workflows, not the other way around, without having to fork and modify pi
internals" - which is exactly the position you need to be in to build a bot
platform on top of something.

Concretely, Pi already ships:

- `packages/agent` - the agent runtime, tool calling, state
- `packages/ai` - unified provider API with OAuth for seven subscription providers
- `packages/coding-agent` - the CLI, plus an SDK (`createAgentSession`,
  `session.prompt/steer/followUp`, `session.subscribe`, `SessionManager`,
  `AgentSessionRuntime` with fork/resume/import)
- RPC mode - JSONL over stdin/stdout, so any front end can drive a session
- `examples/extensions/subagent` - single, parallel (max 8, 4 concurrent) and
  chained delegation, spawning `pi --mode json -p --no-session --model ... --tools
  ... --append-system-prompt ...`
- `examples/extensions/handoff.ts` - lossless context transfer into a fresh
  session, which is what Grok Bot's group-chat handoff is doing underneath
- **`earendil-works/pi-chat`** - Discord and Telegram channels bridged to a pi
  session, each with a Gondolin micro-VM, persistent workspace, shared storage,
  durable per-account and per-channel memory, agent-created skills, file
  attachments, and tmux orchestration across channels

That last one is the surprise. pi-chat is most of Grok Bot's surface already
built: a bot you message from your phone, with its own persistent sandboxed
computer.

## 4b. The open-source field, surveyed

Grok Bot has been cloned. Several times, well. Anyone building here should know
what already exists before writing a line.

| Project | Shape | Runs on | Notable |
|---|---|---|---|
| **OpenMausBot** | Electron chat app; every contact is a real agent | `claude`, `codex`, `grok` CLIs on **your subscriptions** | Explicitly "an open-source Grok Bot". Local harness on 127.0.0.1, state in `~/.openmausbot`. Cloud Linux desktop or local VM per bot. 500+ apps via Composio. Signed macOS/Windows/Ubuntu installers. |
| **Rakazo** | Full platform: web + Electron + Expo mobile | BYO model **through Pi** | Persistent bots with memory, routines, history. Voice mode. Bots delegate to peers or short-lived subagents. Shared Team Computers vs isolated Private ones. Needs Postgres, Prisma, Docker. |
| **pi-gui** | Codex-style desktop for Pi | Pi's own auth | Threaded timeline, git worktree per thread, PTY terminal, inline diffs. Orchestrator threads spawn and supervise child worker threads. MIT, signed releases, Homebrew tap. |
| **SwarmClaw** | Self-hosted agent runtime | 23+ providers | Memory, MCP tools, schedules, delegation. Electron and CLI. |
| **OpenClaw** | Personal agent wired to messaging apps | BYO | **214,000 GitHub stars by February 2026.** The category's centre of gravity. |

Three things fall out of this.

**The idea is not the moat.** "Chief-of-staff agent that delegates to persistent
specialists on your own subscriptions" is, as of August 2026, a solved and
shipped problem with signed installers. Building it again to have it is wasted
effort; the only defensible reason to build is a property none of them have.

**Pi keeps turning up.** Rakazo uses it for model credentials. pi-gui is a shell
around it. That is independent confirmation of the harness choice in section 4.

**Nobody enforces verification.** Every one of these will happily tell you a task
is complete because the sub-agent said so. Not one runs a mechanical acceptance
check and records the verdict; not one can answer "which of last week's jobs
finished without proving anything?" That gap is the whole reason Podium exists,
and it is the gap that matches this author's actual signature - the TabFM and
TurboQuant evaluations are both "someone asserted a result and I checked it."

The design consequence is sharp: verification cannot live in a system prompt.
A prompt is an aspiration a model may ignore, and any competitor can paste the
same paragraph tomorrow. It has to be a few hundred lines of auditable shell that
runs the check itself and writes the verdict down. That is what v0 does.

## 4c. The governance and receipts wing

A second survey, prompted by CopilotKit's OpenBot, turned up a whole category the
first pass missed. These are not Grok Bot clones. They are the answer to a
different question - *can you trust what the agent did?* - and they are closer to
Podium than any of the chat apps.

| Project | What it does |
|---|---|
| **CopilotKit/OpenBot** | "AI coworkers you can hand real work to, and actually trust with the access." Every action is decided **before** execution against a CEL policy, and an audit row is written before the call is made. Container, `/workspace` volume and browser profile per bot; optional gVisor. Agents conform to the AG-UI protocol, so LangGraph, Mastra, CrewAI and Pydantic AI agents all plug in. **Fails closed - a missing policy permits nothing.** |
| **Agent Receipts** (`agent-receipts/obsigna`) | An open protocol for cryptographically signed, tamper-evident records of agent actions. Defines the receipt format, signing scheme, chain structure and a taxonomy of action types. SDKs in Go, TypeScript and Python, plus an MCP proxy. |
| **Nobulex** | Every action produces a receipt: Ed25519-signed **before and after** execution, hash-chained for tamper evidence. A third party can verify the history without trusting the agent *or* the operator. Agents earn "Trust Capital" that gates what they may do. |
| **MartinLoop** | Governs autonomous coding agents - turns open-ended runs into budgeted, verified software work with signed outcome receipts. |
| **agent-fleet-o** | Self-hosted orchestration with a visual DAG builder, 450+ MCP tools, human-in-the-loop approvals and a full audit trail. |

### The distinction that matters

Three different problems get called "trust", and conflating them is how you end
up building the wrong thing:

- **Authorization** - *may the agent do this?* Decided before the action.
  OpenBot's CEL policy, Nobulex's Trust Capital, agent-fleet-o's approvals.
- **Verification** - *did the work actually land?* Decided after the action, by
  running something that fails if it did not. **This is the gap.** OpenBot will
  faithfully record that an agent was permitted to edit a file and did; it will
  not tell you the change works.
- **Tamper-evidence** - *can the record be edited afterwards?* Agent Receipts and
  Nobulex, via signing and hash chains.

Podium sits squarely on the second, and the survey says nobody else does. But it
was weak on the third, and that was worth fixing.

### What this changed

Podium's ledger was a plain appended JSONL file. Calling that an "audit trail"
was generous - any text editor could rewrite a `failed_check` into a `verified`
and nothing would notice. For a tool whose entire pitch is "do not take the
agent's word for it", that was the wrong place to be relaxed.

So receipts are now **hash-chained**: each one carries the SHA-256 of the
receipt before it, and the newest hash is kept in a separate `log.jsonl.head`
file because nothing chains to the last line yet. `podium audit` walks the chain
and names the first broken link. Editing a receipt, deleting one, or truncating
the file are all detected. Concurrent appends take an atomic `mkdir` lock, since
parallel jobs settling at the same instant would otherwise each chain to the same
tail and split the chain.

What was deliberately **not** copied: Ed25519 signing. Nobulex signs because a
third party must verify without trusting the operator. Podium runs on your
machine, for you - the threat is a bad edit or a corrupted write, not an
adversary. Hashing catches those with no key management and no dependencies.
The README says exactly this rather than implying stronger guarantees than the
mechanism provides.

## 5. Subscription billing: what actually works

This is the requirement that constrains the design, so it is worth being exact.

Pi's `/login` supports subscription OAuth for **ChatGPT Plus/Pro (Codex), Claude
Pro/Max, GitHub Copilot, xAI (Grok/X), OpenRouter, Kimi and Radius**, plus
flat-rate coding plans behind API keys (ZAI, Qwen Token Plan, MiniMax, Xiaomi
MiMo). Tokens live in `~/.pi/agent/auth.json` and auto-refresh.

Ranked by how cleanly they meet "my subscription, not API credit":

1. **ChatGPT Plus/Pro via Codex.** Officially endorsed by OpenAI for third-party
   harnesses under their Codex for OSS programme. This is the clean answer and
   should be the executor fleet.
2. **GitHub Copilot.** Flat rate, officially supported, cheap. Good second
   provider so a rate limit on one does not stop everything.
3. **xAI (Grok/X subscription).** Native `/login xai` -> "Use a subscription".
   Ironic and effective.
4. **Flat-rate coding plans** (ZAI, Kimi, Qwen, MiniMax). Cheap per-month, no
   metering anxiety, fine for scouts and other high-volume low-stakes bots.
5. **Claude Pro/Max - read this carefully.** Pi implements Anthropic OAuth, but
   Pi's own docs state that third-party harness usage "draws from extra usage and
   is billed per token, not against Claude plan limits." Separately, Anthropic's
   stated policy restricts subscription OAuth tokens to Claude Code and
   Claude.ai, and directs third-party integrations to API keys. The sanctioned
   route for using a Claude plan programmatically is the **Claude Agent SDK**,
   which since 15 June 2026 draws on a separate monthly Agent SDK credit rather
   than your interactive plan limits, with overflow at API rates.

   So: logging into pi with Claude Pro/Max is not free and is not clearly within
   terms. If you want Claude in the roster, run it through the Agent SDK as its
   own executor and spend the Agent SDK credit deliberately.

**Recommendation:** Codex as the default executor, Copilot as the fallback, a
flat-rate plan for the cheap high-volume bots, and Claude via the Agent SDK only
where its judgement is worth the credit.

## 6. The gap

Pi plus pi-chat gets you most of the way. Six things stand between that and Grok
Bot, and you already own two of them.

| Gap | Grok Bot's answer | Yours |
|---|---|---|
| Jobs die with the session | Cloud workers, always on | **Podium runner** - detached, reparented to init, verified |
| No persistent agent identity | Named bots with own memory | **Podium bot dirs** - prompt, memory, workspace |
| Nothing verifies the work | (nothing - it is a black box) | **Runner-enforced acceptance checks** - built, tested, and the only differentiator that survived review |
| Context dies between sessions | Shared files and browser state | **Looma** - you already built this |
| No chat surface | X, app | **pi-chat** - Discord/Telegram, already built |
| No sandbox | Cloud VM | **Gondolin** micro-VM, already integrated with pi-chat |

Two of six are already yours. Two more are off-the-shelf. Podium is the only
genuinely new construction, and it is a few hundred lines of bash plus one
extension.

The survey in section 4b narrows that further. Durability, persistent bot identity and a
chat surface all exist elsewhere. Enforced verification does not. That is the one
column in the table above where the honest answer is "nobody, yet".

## Sources

Grok Bot and Grok 4 Heavy:
- [VentureBeat - Grok Bot turns agents into persistent digital coworkers](https://venturebeat.com/orchestration/spacexais-grok-bot-turns-agents-into-persistent-digital-coworkers-that-can-operate-your-apps-for-120-per-month)
- [Composio - A Guide to Grok Bot](https://composio.dev/content/guide-to-frok-bot)
- [MindStudio - What Is Grok Bot?](https://www.mindstudio.ai/blog/grok-bot-ai-agent-fleet)
- [atal upadhyay - Grok 4.6, Grok Bot, and the rise of the chief-of-staff agent pattern](https://atalupadhyay.wordpress.com/2026/08/16/grok-4-6-grok-bot-and-the-rise-of-the-chief-of-staff-agent-pattern/)
- [TechTimes - all bots share one cloud computer and every login](https://www.techtimes.com/articles/324176/20260812/grok-bot-launches-any-app-no-api-all-bots-share-one-cloud-computer-every-login.htm)
- [ZharfAI - How xAI's persistent AI teammate actually works](https://zharfai.com/en/blog/grok-bot-persistent-ai-teammate-guide)
- [AI Pricing Guru - Grok Bot pricing, plans and limits](https://www.aipricing.guru/news/xai-grok-bot-launch-pricing-impact-august-2026/)
- [Verdent - Grok 4.20 multi-agent system](https://www.verdent.ai/guides/grok-4-20-multi-agent-system)
- [ai-x.chat - Grok 4 Heavy architecture](https://ai-x.chat/models/grok-4-heavy/)

Open-source alternatives:
- [CopilotKit/OpenBot](https://github.com/CopilotKit/openbot)
- [Agent Receipts / obsigna](https://github.com/agent-receipts/obsigna)
- [Nobulex](https://github.com/nobulexdev/nobulex)
- [agent-fleet-o](https://github.com/escapeboy/agent-fleet-o)
- [awesome-ai-agent-governance](https://github.com/systempromptio/awesome-ai-agent-governance)
- [OpenMausBot](https://github.com/milind-soni/OpenMausBot)
- [Rakazo](https://github.com/elie222/rakazo)
- [pi-gui](https://github.com/minghinmatthewlam/pi-gui)
- [SwarmClaw](https://github.com/swarmclawai/swarmclaw)
- [openalternative.co - Grok Bot alternatives](https://openalternative.co/alternatives/grok-bot)
- [What Is OpenClaw?](https://www.mindstudio.ai/blog/what-is-openclaw-ai-agent)

Pi:
- [earendil-works/pi (pi-mono)](https://github.com/badlogic/pi-mono)
- [pi-chat](https://github.com/earendil-works/pi-chat)
- [awesome-cli-coding-agents](https://github.com/bradagi/awesome-cli-coding-agents)

Subscription auth:
- [Claude Code authentication docs](https://code.claude.com/docs/en/authentication)
- [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
- [Anthropic restricts subscription authentication for third-party use](https://alternativeto.net/news/2026/2/anthropic-officially-bans-using-subscription-authentication-for-third-party-claude-use)
- [OpenAI - Codex for OSS](https://developers.openai.com/community/codex-for-oss)
