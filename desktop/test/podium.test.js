"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { Podium, PodiumError, parseFrontmatter, stripFrontmatter } = require("../lib/podium.js");

function tmpHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "podium-test-"));
  fs.mkdirSync(path.join(dir, "bots", "scout"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "bots", "scout", "bot.md"),
    `---\nname: scout\ndescription: Fast recon\ntools: read, grep, bash\nmodel: haiku\n---\nYou are the scout.\n`,
  );
  fs.writeFileSync(path.join(dir, "bots", "scout", "memory.md"), "- (2026-08-20) Prefers tabs.\n\n- (2026-08-21) Repo uses pnpm.\n");
  fs.mkdirSync(path.join(dir, "bots", "orphan"), { recursive: true }); // no bot.md
  return dir;
}

/** Build a Podium whose exec returns canned stdout per subcommand. */
function fakePodium(home, responses) {
  return new Podium({
    home,
    bin: "/fake/podium",
    exec: (bin, args, opts, cb) => {
      const key = args[0];
      const value = responses[key];
      if (value === undefined) return cb(new Error(`no fake for ${key}`), "", `unknown command ${key}`);
      if (value instanceof Error) return cb(value, "", value.message);
      process.nextTick(() => cb(null, value, ""));
    },
  });
}

test("frontmatter parsing", () => {
  const meta = parseFrontmatter("---\nname: a\ndescription: has: a colon\n---\nbody");
  assert.strictEqual(meta.name, "a");
  assert.strictEqual(meta.description, "has: a colon", "value keeps colons after the first");
  assert.strictEqual(stripFrontmatter("---\nname: a\n---\nbody text"), "body text");
  assert.strictEqual(stripFrontmatter("no frontmatter"), "no frontmatter");
  assert.deepStrictEqual(parseFrontmatter("no frontmatter"), {});
});

test("bots() reads the roster from disk", () => {
  const home = tmpHome();
  const p = new Podium({ home, bin: "/fake" });
  const bots = p.bots();
  return bots.then((list) => {
    assert.strictEqual(list.length, 1, "a directory with no bot.md is not a bot");
    const [scout] = list;
    assert.strictEqual(scout.name, "scout");
    assert.strictEqual(scout.description, "Fast recon");
    assert.strictEqual(scout.model, "haiku");
    assert.deepStrictEqual(scout.tools, ["read", "grep", "bash"]);
    assert.match(scout.prompt, /You are the scout/);
    assert.strictEqual(scout.memoryLines, 2, "blank lines do not count as memory");
  });
});

test("bots() returns empty rather than throwing when there is no roster", async () => {
  const p = new Podium({ home: "/definitely/not/here", bin: "/fake" });
  assert.deepStrictEqual(await p.bots(), []);
});

test("ledger() reverses, limits, and survives a torn line", () => {
  const home = tmpHome();
  fs.writeFileSync(
    path.join(home, "log.jsonl"),
    [
      '{"id":"a","bot":"scout","status":"done","duration_secs":3}',
      '{"id":"b","bot":"implementer","status":"failed","duration_secs":9}',
      '{"id":"c","bot":"scout","status":"done"', // torn: the runner was mid-write
      '{"id":"d","bot":"scout","status":"timeout","duration_secs":30}',
      "",
    ].join("\n"),
  );
  const p = new Podium({ home, bin: "/fake" });
  const rows = p.ledger();
  assert.strictEqual(rows.length, 3, "the torn line is skipped, not fatal");
  assert.strictEqual(rows[0].id, "d", "newest first");
  assert.strictEqual(p.ledger({ limit: 1 }).length, 1);
});

test("ledger() is empty when nothing has run", () => {
  const p = new Podium({ home: tmpHome(), bin: "/fake" });
  assert.deepStrictEqual(p.ledger(), []);
});

test("stats() aggregates the ledger", () => {
  const home = tmpHome();
  fs.writeFileSync(
    path.join(home, "log.jsonl"),
    [
      '{"id":"a","bot":"scout","status":"done","duration_secs":3}',
      '{"id":"b","bot":"scout","status":"done","duration_secs":5}',
      '{"id":"c","bot":"implementer","status":"failed","duration_secs":2}',
      '{"id":"d","bot":"implementer","status":"timeout","duration_secs":30}',
    ].join("\n"),
  );
  const s = new Podium({ home, bin: "/fake" }).stats();
  assert.strictEqual(s.total, 4);
  assert.strictEqual(s.succeeded, 2);
  assert.strictEqual(s.failed, 2, "timeout counts as a failure, not a success");
  assert.strictEqual(s.seconds, 40);
  assert.deepStrictEqual(s.byBot, { scout: 2, implementer: 2 });
});

test("doctor() parses checks and reports readiness", async () => {
  const home = tmpHome();
  const ready = fakePodium(home, {
    doctor: "podium 0.1.0\n\nok    config exists\nok    nohup available\n\nready.\n",
  });
  const good = await ready.doctor();
  assert.strictEqual(good.ready, true);
  assert.strictEqual(good.checks.length, 2);

  const broken = fakePodium(home, {
    doctor: "podium 0.1.0\n\nok    config exists\nFAIL  executor function defined\n\nnot ready.\n",
  });
  const bad = await broken.doctor();
  assert.strictEqual(bad.ready, false);
  assert.strictEqual(bad.checks.find((c) => !c.ok).label, "executor function defined");
});

test("doctor() does not throw when the binary exits non-zero", async () => {
  const home = tmpHome();
  const p = new Podium({
    home,
    bin: "/fake",
    exec: (b, a, o, cb) => cb(new Error("exit 1"), "", "FAIL  config exists\nnot ready."),
  });
  const res = await p.doctor();
  assert.strictEqual(res.ready, false);
  assert.ok(res.checks.length >= 1, "checks are still recovered from stderr");
});

test("jobs() and job() parse JSON", async () => {
  const home = tmpHome();
  const p = fakePodium(home, {
    list: '[{"id":"1","bot":"scout","status":"done","exit_code":0},{"id":"2","bot":"scout","status":"running","exit_code":null}]',
    show: '{"id":"1","bot":"scout","status":"done","brief":"find the thing","result":"found it"}',
  });
  const jobs = await p.jobs();
  assert.strictEqual(jobs.length, 2);
  assert.strictEqual(jobs[1].exit_code, null);
  const job = await p.job("1");
  assert.strictEqual(job.brief, "find the thing");
});

test("non-JSON output fails with the offending text, not a bare SyntaxError", async () => {
  const p = fakePodium(tmpHome(), { list: "podium: unknown flag --json" });
  await assert.rejects(() => p.jobs(), (err) => {
    assert.ok(err instanceof PodiumError);
    assert.match(err.message, /did not return JSON/);
    assert.match(err.message, /unknown flag/, "the actual output is in the message");
    return true;
  });
});

test("a failing command surfaces stderr", async () => {
  const p = new Podium({
    home: tmpHome(),
    bin: "/fake",
    exec: (b, a, o, cb) => cb(new Error("Command failed"), "", "podium: unknown bot 'nope'"),
  });
  await assert.rejects(() => p.run("nope", "hi"), /unknown bot 'nope'/);
});

test("run() passes options through as flags", async () => {
  let seen = null;
  const p = new Podium({
    home: tmpHome(),
    bin: "/fake",
    exec: (b, a, o, cb) => { seen = a; cb(null, "20260821-000000-1\n", ""); },
  });
  const id = await p.run("scout", "look", { cwd: "/repo", model: "m", timeout: 60 });
  assert.strictEqual(id, "20260821-000000-1", "the id is trimmed");
  assert.deepStrictEqual(seen, ["run", "scout", "look", "--cwd", "/repo", "--model", "m", "--timeout", "60"]);
});

test("PODIUM_HOME is forced into the child environment", async () => {
  let env = null;
  const home = tmpHome();
  const p = new Podium({
    home,
    bin: "/fake",
    exec: (b, a, o, cb) => { env = o.env; cb(null, "0.1.0\n", ""); },
  });
  await p.version();
  assert.strictEqual(env.PODIUM_HOME, home, "the app never reads a different roster than it shows");
});

test("audit() parses an intact chain", async () => {
  const p = fakePodium(tmpHome(), {
    audit: "4 receipt(s), chain intact.\nhead: abc123def456\n",
  });
  const res = await p.audit();
  assert.strictEqual(res.intact, true);
  assert.strictEqual(res.receipts, 4);
  assert.strictEqual(res.head, "abc123def456");
});

test("audit() reports tampering as a finding, not an exception", async () => {
  // The binary exits non-zero on a broken chain. That must surface as
  // intact:false, never as a thrown error the UI swallows into a blank panel.
  const p = new Podium({
    home: tmpHome(),
    bin: "/fake",
    exec: (b, a, o, cb) =>
      cb(new Error("exit 1"), "", "line 3: CHAIN BROKEN\n\n3 receipt(s) checked. The ledger has been edited or truncated."),
  });
  const res = await p.audit();
  assert.strictEqual(res.intact, false);
  assert.strictEqual(res.receipts, 3);
  assert.match(res.detail, /CHAIN BROKEN/);
});

test("audit() handles a head mismatch on the newest receipt", async () => {
  const p = new Podium({
    home: tmpHome(),
    bin: "/fake",
    exec: (b, a, o, cb) =>
      cb(new Error("exit 1"), "", "HEAD MISMATCH on the newest receipt (line 4)\n\n4 receipt(s) checked. The last receipt has been edited."),
  });
  const res = await p.audit();
  assert.strictEqual(res.intact, false);
  assert.match(res.detail, /HEAD MISMATCH/);
});

test("audit() on an empty ledger is intact-but-empty, not a crash", async () => {
  const p = fakePodium(tmpHome(), { audit: "no ledger at /tmp/x/log.jsonl\n" });
  const res = await p.audit();
  assert.strictEqual(res.intact, false, "no ledger is not a verified chain");
  assert.strictEqual(res.receipts, 0);
});

test("outputPath points at the job's growing output", () => {
  const p = new Podium({ home: "/h", bin: "/fake" });
  assert.strictEqual(p.outputPath("abc"), path.join("/h", "jobs", "abc", "out.txt"));
});
