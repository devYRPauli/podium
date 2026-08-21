"use strict";
/**
 * Podium Console renderer.
 *
 * A pure view. It has no Node access and no knowledge of the filesystem; every
 * fact comes through window.podium. Text is written with textContent
 * throughout - bot output is untrusted and never becomes markup.
 */

const api = window.podium;

const state = {
  view: "receipts",
  bots: [],
  jobs: [],
  turns: [],          // {who, text} - the local record of the conversation
  toolCalls: [],
  streaming: false,
  running: false,
  ledgerFilter: "all",
  settings: null,
};

// ---- tiny DOM helpers ------------------------------------------------------

const $ = (sel) => document.querySelector(sel);

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function banner(message, kind) {
  const b = $("#banner");
  if (!message) { b.hidden = true; return; }
  b.textContent = message;
  b.className = kind === "info" ? "info" : "";
  b.hidden = false;
}

// Verdict and duration formatting live in view-model.js so they can be tested.
const { verdictBadge, relTime, receiptSummary, filterLedger } = window.PodiumView;

// ---- views -----------------------------------------------------------------

function setView(name) {
  state.view = name;
  for (const tab of document.querySelectorAll(".tab")) {
    tab.classList.toggle("is-on", tab.dataset.view === name);
  }
  for (const view of document.querySelectorAll(".view")) {
    view.classList.toggle("is-on", view.id === `view-${name}`);
  }
  if (name === "roster") renderRosterPane();
  if (name === "receipts") renderReceipts();
  renderRail();
}

function renderRail() {
  const body = $("#rail-body");
  clear(body);

  if (state.view === "receipts") {
    const note = el("div", "empty");
    note.appendChild(el("h3", null, "Receipts"));
    note.appendChild(el("div", null,
      "Every settled job, with the acceptance check the runner actually ran."));
    body.appendChild(note);
    return;
  }

  for (const bot of state.bots) {
    const card = el("div", "bot");
    card.appendChild(el("div", "n", bot.name));
    card.appendChild(el("div", "d", bot.description));
    const bits = [];
    if (bot.model) bits.push(bot.model);
    if (bot.memoryLines) bits.push(`${bot.memoryLines} memories`);
    if (bits.length) card.appendChild(el("div", "m", bits.join(" - ")));
    body.appendChild(card);
  }

  if (!state.bots.length) {
    const note = el("div", "empty");
    note.appendChild(el("h3", null, "No bots yet"));
    note.appendChild(el("div", null, "Add one at ~/.podium/bots/<name>/bot.md"));
    body.appendChild(note);
  }
}

function renderTranscript() {
  const t = $("#transcript");
  clear(t);

  if (!state.turns.length && !state.toolCalls.length) {
    const note = el("div", "empty");
    note.appendChild(el("h3", null, "Talk to the chief of staff"));
    const p = el("div", null,
      "It does not do the work. It writes a brief, hands it to a bot, and checks the result before telling you it is done.");
    note.appendChild(p);
    const p2 = el("div");
    p2.style.marginTop = "10px";
    p2.appendChild(document.createTextNode("Try: "));
    p2.appendChild(el("code", null, "have scout map the auth code, then have the implementer add a null check"));
    note.appendChild(p2);
    t.appendChild(note);
    return;
  }

  for (const turn of state.turns) {
    const wrap = el("div", `turn ${turn.who === "you" ? "you" : ""}`);
    wrap.appendChild(el("div", "who", turn.who === "you" ? "You" : "Chief of staff"));
    wrap.appendChild(el("div", "body", turn.text));
    t.appendChild(wrap);
  }

  for (const call of state.toolCalls) {
    const row = el("div", `tool ${call.state}`);
    row.appendChild(el("span", "name", call.name));
    const detail = call.args && call.args.bot
      ? ` -> ${call.args.bot}`
      : call.args && call.args.job ? ` ${call.args.job}` : "";
    row.appendChild(document.createTextNode(detail));
    t.appendChild(row);
  }

  t.scrollTop = t.scrollHeight;
}

function renderJobs() {
  const list = $("#jobs-list");
  clear(list);
  $("#jobs-count").textContent = String(state.jobs.length);

  if (!state.jobs.length) {
    const note = el("div", "empty");
    note.appendChild(el("div", null, "Nothing delegated yet."));
    list.appendChild(note);
    return;
  }

  for (const job of state.jobs) {
    const card = el("div", "job");
    card.tabIndex = 0;
    card.setAttribute("role", "button");

    const top = el("div", "top");
    top.appendChild(el("span", "bot", job.bot));
    const badge = verdictBadge(job);
    top.appendChild(el("span", `badge ${badge.cls}`, badge.label));
    card.appendChild(top);

    card.appendChild(el("div", "brief", job.check ? `check: ${job.check}` : "no acceptance check"));

    const meta = [relTime(job.duration_secs)];
    if (job.model) meta.push(job.model);
    card.appendChild(el("div", "meta", meta.join(" - ")));

    const open = () => openJob(job.id);
    card.addEventListener("click", open);
    card.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    list.appendChild(card);
  }
}

function renderRosterPane() {
  const pane = $("#view-roster");
  clear(pane);
  const wrap = el("div", "pane");
  wrap.appendChild(el("h2", null, "Roster"));
  wrap.appendChild(el("p", "lede",
    "A bot is a directory: a system prompt, a memory file, and a workspace. Edit them in any text editor; the console reads the same files."));

  for (const bot of state.bots) {
    const f = el("div", "field");
    const head = el("div", "row");
    head.appendChild(el("strong", null, bot.name));
    if (bot.model) head.appendChild(el("span", "badge neutral", bot.model));
    if (bot.tools.length) head.appendChild(el("span", "badge neutral", `${bot.tools.length} tools`));
    f.appendChild(head);
    f.appendChild(el("div", "k", bot.description));
    const pre = el("pre", null, bot.prompt.slice(0, 1200));
    f.appendChild(pre);
    if (bot.memory.trim()) {
      f.appendChild(el("div", "k", "durable memory"));
      f.appendChild(el("pre", null, bot.memory.trim()));
    }
    wrap.appendChild(f);
  }
  pane.appendChild(wrap);
}

async function renderReceipts() {
  const pane = $("#view-receipts");
  clear(pane);
  const wrap = el("div", "pane");
  wrap.appendChild(el("h2", null, "Receipts"));
  wrap.appendChild(el("p", "lede",
    "Every settled job with the acceptance check the runner ran and the verdict it produced. A job with no check is not a passing job; it is an unverified one."));

  let rows = [];
  let stats = { total: 0, succeeded: 0, failed: 0, seconds: 0 };
  let chain = { intact: true, receipts: 0, head: "", detail: "" };
  try {
    rows = await api.ledger({ limit: 500 });
    stats = await api.stats();
    chain = await api.audit();
  } catch (err) {
    wrap.appendChild(el("div", "empty", String(err.message || err)));
    pane.appendChild(wrap);
    return;
  }

  const sum = receiptSummary(rows);

  const stats_ = el("div", "stats");
  const stat = (k, v, cls) => {
    const s = el("div", `stat ${cls || ""}`);
    s.appendChild(el("div", "v", v));
    s.appendChild(el("div", "k", k));
    return s;
  };
  stats_.appendChild(stat("jobs", sum.total));
  stats_.appendChild(stat("verified", sum.verified, "good"));
  stats_.appendChild(stat("unverified", sum.unverified, sum.unverified ? "warn" : ""));
  stats_.appendChild(stat("failed", stats.failed, stats.failed ? "warn" : ""));
  stats_.appendChild(stat("compute", relTime(stats.seconds)));
  wrap.appendChild(stats_);

  // Chain integrity. The ledger's whole value is that it cannot be quietly
  // edited, so its state belongs above the table, not buried.
  const chainRow = el("div", chain.intact ? "chainbar ok" : "chainbar bad");
  chainRow.appendChild(el("span", "badge " + (chain.intact ? "verified" : "failed"),
    chain.intact ? "chain intact" : "tampered"));
  chainRow.appendChild(el("span", "chaintext", chain.intact
    ? `${chain.receipts} receipts, hash-chained. Head ${chain.head.slice(0, 12)}...`
    : chain.detail.split("\n")[0] || "The ledger has been edited or truncated."));
  wrap.appendChild(chainRow);

  const filters = el("div", "filters");
  for (const [key, label] of [["all", "All"], ["unverified", "Unverified only"]]) {
    const b = el("button", state.ledgerFilter === key ? "is-on" : "", label);
    b.addEventListener("click", () => { state.ledgerFilter = key; renderReceipts(); });
    filters.appendChild(b);
  }
  wrap.appendChild(filters);

  const shown = filterLedger(rows, state.ledgerFilter);

  const table = el("table", "ledger");
  const thead = el("thead");
  const hr = el("tr");
  for (const h of ["When", "Bot", "Status", "Verdict", "Acceptance check", "Took"]) {
    hr.appendChild(el("th", null, h));
  }
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = el("tbody");
  for (const r of shown) {
    const tr = el("tr");
    tr.appendChild(el("td", null, (r.ts || "").replace("T", " ").replace("Z", "")));
    tr.appendChild(el("td", null, r.bot));
    tr.appendChild(el("td", null, r.status));
    const vd = el("td");
    const cls = r.verified === true ? "verified" : (r.status === "rejected" ? "failed" : "unverified");
    vd.appendChild(el("span", `badge ${cls}`, r.verdict || "-"));
    tr.appendChild(vd);
    const checkCell = el("td", "check");
    if (r.check) checkCell.textContent = r.check;
    else { checkCell.classList.add("none"); checkCell.textContent = "none given"; }
    tr.appendChild(checkCell);
    tr.appendChild(el("td", null, relTime(r.duration_secs)));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  if (!shown.length) {
    wrap.appendChild(el("div", "empty", rows.length
      ? "Nothing matches that filter."
      : "No jobs have settled yet."));
  } else {
    wrap.appendChild(table);
  }
  pane.appendChild(wrap);
}

// ---- job detail ------------------------------------------------------------

async function openJob(id) {
  const sheet = $("#sheet");
  const body = $("#sheet-body");
  $("#sheet-title").textContent = id;
  clear(body);
  body.appendChild(el("div", "empty", "Loading..."));
  sheet.hidden = false;

  let job;
  try {
    job = await api.job(id);
  } catch (err) {
    clear(body);
    body.appendChild(el("div", "empty", String(err.message || err)));
    return;
  }

  clear(body);

  const head = el("div", "row");
  const badge = verdictBadge(job);
  head.appendChild(el("span", `badge ${badge.cls}`, badge.label));
  head.appendChild(el("span", "badge neutral", job.bot));
  if (job.model) head.appendChild(el("span", "badge neutral", job.model));
  head.appendChild(el("span", "badge neutral", relTime(job.duration_secs)));
  body.appendChild(head);

  const field = (label, text, cls) => {
    const f = el("div", "field");
    f.appendChild(el("div", "k", label));
    f.appendChild(el("pre", cls, text || "(empty)"));
    body.appendChild(f);
  };

  field("brief", job.brief);

  // The differentiator, given the most prominent placement in the sheet.
  if (job.check) {
    const passed = job.check_exit === 0;
    const f = el("div", "field");
    f.appendChild(el("div", "k", `acceptance check - exit ${job.check_exit === null ? "not run" : job.check_exit}`));
    f.appendChild(el("pre", passed ? "pass" : "fail", job.check));
    body.appendChild(f);
    if (job.check_output) field("check output", job.check_output, passed ? "pass" : "fail");
  } else {
    const f = el("div", "field");
    f.appendChild(el("div", "k", "acceptance check"));
    const pre = el("pre", "fail",
      "None was given, so nothing confirms this work landed. The bot's own report is not evidence.");
    f.appendChild(pre);
    body.appendChild(f);
  }

  field("result", job.result);

  const actions = el("div", "row");
  const reveal = el("button", "ghost", "Show output file");
  reveal.style.width = "auto";
  reveal.addEventListener("click", () => api.reveal(id).catch(() => {}));
  actions.appendChild(reveal);

  if (job.status === "running" || job.status === "queued") {
    const stop = el("button", "ghost", "Cancel job");
    stop.style.width = "auto";
    stop.addEventListener("click", async () => {
      await api.cancel(id).catch(() => {});
      sheet.hidden = true;
    });
    actions.appendChild(stop);
  }
  body.appendChild(actions);
}

// ---- conversation ----------------------------------------------------------

async function ensureRunning() {
  if (state.running) return true;
  try {
    await api.orchestrator.start();
    state.running = true;
    banner(null);
    return true;
  } catch (err) {
    banner(`Could not start the orchestrator: ${err.message || err}`);
    return false;
  }
}

async function submit(text) {
  if (!text.trim()) return;
  if (!(await ensureRunning())) return;

  state.turns.push({ who: "you", text: text.trim() });
  renderTranscript();

  try {
    await api.orchestrator.send(text.trim());
  } catch (err) {
    banner(String(err.message || err));
  }
}

function setBusy(busy) {
  state.streaming = busy;
  $("#send").disabled = busy;
  $("#stop").hidden = !busy;
  $("#conn").className = `dot ${state.running ? (busy ? "busy" : "live") : ""}`;
  $("#conn").title = state.running ? (busy ? "working" : "orchestrator ready") : "orchestrator stopped";
  $("#hint").textContent = busy ? "Working - press Enter to steer it mid-turn." : "";
}

// ---- wiring ----------------------------------------------------------------

function wire() {
  for (const tab of document.querySelectorAll(".tab")) {
    tab.addEventListener("click", () => setView(tab.dataset.view));
  }

  const input = $("#input");
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      $("#composer").requestSubmit();
    }
  });

  $("#composer").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value;
    input.value = "";
    input.style.height = "auto";
    submit(text);
  });

  $("#stop").addEventListener("click", () => api.orchestrator.abort().catch(() => {}));

  $("#sheet-close").addEventListener("click", () => { $("#sheet").hidden = true; });
  $("#sheet").addEventListener("click", (e) => { if (e.target.id === "sheet") $("#sheet").hidden = true; });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("#sheet").hidden = true; });

  $("#pick-cwd").addEventListener("click", async () => {
    const dir = await api.pickCwd().catch(() => null);
    if (dir) {
      state.settings = await api.settings();
      $("#cwd-label").textContent = dir.replace(/^.*\//, "") || dir;
      $("#pick-cwd").title = dir;
    }
  });

  api.onJobs((jobs) => { state.jobs = jobs; renderJobs(); });
  api.onJobsError((msg) => banner(`Job list unavailable: ${msg}`));

  api.onView((view) => {
    state.toolCalls = view.toolCalls;
    // Replace only the assistant turns; the user's own lines are local.
    state.turns = state.turns.filter((t) => t.who === "you")
      .concat(view.messages.map((m) => ({ who: "bot", text: m.text })));
    setBusy(view.streaming);
    renderTranscript();
  });

  api.onMalformed((line) => {
    banner(`The orchestrator sent something unparseable: ${String(line).slice(0, 120)}`);
  });
  api.onOrcError((msg) => banner(String(msg)));
  api.onOrcExit((info) => {
    state.running = false;
    setBusy(false);
    banner(info.stderr
      ? `Orchestrator stopped (code ${info.code}): ${info.stderr.split("\n")[0]}`
      : `Orchestrator stopped (code ${info.code}).`);
  });
}

async function boot() {
  wire();
  setBusy(false);

  try {
    state.settings = await api.settings();
    const cwd = state.settings.cwd || "";
    $("#cwd-label").textContent = cwd.replace(/^.*\//, "") || "no folder";
    $("#pick-cwd").title = cwd;
  } catch { /* settings are best-effort */ }

  try {
    const health = await api.doctor();
    if (!health.ready) {
      const bad = health.checks.filter((c) => !c.ok).map((c) => c.label).join(", ");
      banner(bad ? `Podium is not ready: ${bad}` : "Podium is not ready. Run podium doctor.", "info");
    }
  } catch (err) {
    banner(`Cannot reach the podium runner: ${err.message || err}`);
  }

  try { state.bots = await api.bots(); } catch { state.bots = []; }
  try { state.jobs = await api.jobs(); } catch { state.jobs = []; }

  renderRail();
  renderTranscript();
  renderJobs();
}

boot();
