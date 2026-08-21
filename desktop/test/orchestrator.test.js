"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const { Orchestrator, reduceEvents, jobIdsFrom } = require("../lib/orchestrator.js");

/** A stand-in for the pi child process. Records what was written to stdin. */
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.written = [];
  child.stdin = {
    write(data, cb) { child.written.push(data); cb && cb(null); return true; },
    end() { child.stdinEnded = true; },
  };
  child.kill = (sig) => { child.killedWith = sig; };
  return child;
}

function makeOrc(opts = {}) {
  const child = fakeChild();
  const orc = new Orchestrator({ spawn: () => child, ...opts });
  orc.start();
  return { orc, child };
}

/** Parse everything the client wrote to stdin. */
function sent(child) {
  return child.written.map((line) => JSON.parse(line.trim()));
}

test("argv includes rpc mode and the model when set", () => {
  const bare = new Orchestrator();
  assert.deepStrictEqual(bare.argv(), ["--mode", "rpc"]);
  const withModel = new Orchestrator({ model: "gpt-5", args: ["--no-session"] });
  assert.deepStrictEqual(withModel.argv(), ["--mode", "rpc", "--model", "gpt-5", "--no-session"]);
});

test("starting twice is refused", () => {
  const { orc } = makeOrc();
  assert.throws(() => orc.start(), /already started/);
});

test("events are parsed from complete lines", () => {
  const { orc, child } = makeOrc();
  const seen = [];
  orc.on("event", (e) => seen.push(e));
  child.stdout.emit("data", '{"type":"agent_start"}\n{"type":"turn_start"}\n');
  assert.deepStrictEqual(seen.map((e) => e.type), ["agent_start", "turn_start"]);
});

test("a line split across chunks is reassembled", () => {
  const { orc, child } = makeOrc();
  const seen = [];
  orc.on("event", (e) => seen.push(e));
  child.stdout.emit("data", '{"type":"message_up');
  assert.strictEqual(seen.length, 0, "nothing is emitted from a partial line");
  child.stdout.emit("data", 'date","assistantMessageEvent":{"type":"text_delta","delta":"hi"}}\n');
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].assistantMessageEvent.delta, "hi");
});

test("U+2028 and U+2029 inside a string do NOT split the record", () => {
  // This is the exact trap pi's RPC docs warn about: Node's readline treats
  // these as line terminators, which would corrupt any message containing them.
  const { orc, child } = makeOrc();
  const seen = [];
  const malformed = [];
  orc.on("event", (e) => seen.push(e));
  orc.on("malformed", (l) => malformed.push(l));

  const text = "line one line two line three";
  child.stdout.emit("data", `${JSON.stringify({ type: "note", text })}\n`);

  assert.strictEqual(malformed.length, 0, "no record was torn");
  assert.strictEqual(seen.length, 1, "exactly one event, not three");
  assert.strictEqual(seen[0].text, text, "the separators survive intact");
});

test("CRLF input is tolerated", () => {
  const { orc, child } = makeOrc();
  const seen = [];
  orc.on("event", (e) => seen.push(e));
  orc.on("malformed", () => assert.fail("CR should be stripped, not treated as content"));
  child.stdout.emit("data", '{"type":"agent_start"}\r\n');
  assert.strictEqual(seen.length, 1);
});

test("a malformed line is reported and does not stop the stream", () => {
  const { orc, child } = makeOrc();
  const seen = [];
  const malformed = [];
  orc.on("event", (e) => seen.push(e));
  orc.on("malformed", (l) => malformed.push(l));
  child.stdout.emit("data", 'not json at all\n{"type":"agent_start"}\n');
  assert.deepStrictEqual(malformed, ["not json at all"]);
  assert.strictEqual(seen.length, 1, "the stream recovers");
});

test("blank lines are ignored", () => {
  const { orc, child } = makeOrc();
  let count = 0;
  orc.on("event", () => count++);
  orc.on("malformed", () => assert.fail("a blank line is not malformed"));
  child.stdout.emit("data", '\n\n{"type":"agent_start"}\n\n');
  assert.strictEqual(count, 1);
});

test("responses resolve the matching command by id", async () => {
  const { orc, child } = makeOrc();
  const p = orc.send("hello");
  const [msg] = sent(child);
  assert.strictEqual(msg.type, "prompt");
  assert.strictEqual(msg.message, "hello");
  child.stdout.emit("data", `${JSON.stringify({ type: "response", id: msg.id, command: "prompt", success: true })}\n`);
  const res = await p;
  assert.strictEqual(res.success, true);
});

test("a rejected command rejects its promise with the reason", async () => {
  const { orc, child } = makeOrc();
  const p = orc.send("hello");
  const [msg] = sent(child);
  child.stdout.emit("data", `${JSON.stringify({ type: "response", id: msg.id, success: false, error: "agent is busy" })}\n`);
  await assert.rejects(() => p, /agent is busy/);
});

test("send picks prompt when idle and steer when streaming", async () => {
  const { orc, child } = makeOrc();
  orc.send("first").catch(() => {});
  assert.strictEqual(sent(child)[0].streamingBehavior, undefined, "idle sends a plain prompt");

  child.stdout.emit("data", '{"type":"agent_start"}\n');
  assert.strictEqual(orc.streaming, true);

  orc.send("second").catch(() => {});
  assert.strictEqual(sent(child)[1].streamingBehavior, "steer", "mid-turn sends steer");

  orc.send("third", { deliver: "followUp" }).catch(() => {});
  assert.strictEqual(sent(child)[2].streamingBehavior, "followUp");

  child.stdout.emit("data", '{"type":"agent_end"}\n');
  assert.strictEqual(orc.streaming, false);
  orc.send("fourth").catch(() => {});
  assert.strictEqual(sent(child)[3].streamingBehavior, undefined, "idle again after agent_end");
});

test("every command is written as exactly one LF-terminated line", () => {
  const { orc, child } = makeOrc();
  orc.send("a").catch(() => {});
  orc.steer("b").catch(() => {});
  orc.followUp("c").catch(() => {});
  for (const raw of child.written) {
    assert.ok(raw.endsWith("\n"), "line is LF terminated");
    assert.strictEqual(raw.trimEnd().includes("\n"), false, "no embedded newline");
  }
  assert.deepStrictEqual(sent(child).map((m) => m.type), ["prompt", "steer", "follow_up"]);
});

test("command ids are unique", () => {
  const { orc, child } = makeOrc();
  for (let i = 0; i < 5; i++) orc.send(`m${i}`).catch(() => {});
  const ids = sent(child).map((m) => m.id);
  assert.strictEqual(new Set(ids).size, 5);
});

test("sending before start throws rather than silently dropping", () => {
  const orc = new Orchestrator({ spawn: () => fakeChild() });
  assert.throws(() => orc.send("hi"), /not running/);
});

test("exit rejects everything still in flight and reports stderr", async () => {
  const { orc, child } = makeOrc();
  const p = orc.send("hello");
  child.stderr.emit("data", "pi: no provider configured\n");

  const exited = new Promise((resolve) => orc.on("exit", resolve));
  child.emit("exit", 1, null);

  await assert.rejects(() => p, /exited \(code 1\)/);
  const info = await exited;
  assert.strictEqual(info.code, 1);
  assert.match(info.stderr, /no provider configured/, "stderr is kept for diagnosis");
  assert.strictEqual(orc.ready, false);
});

test("stop closes stdin and signals the child", () => {
  const { orc, child } = makeOrc();
  orc.stop();
  assert.strictEqual(child.stdinEnded, true);
  assert.strictEqual(child.killedWith, "SIGTERM");
});

test("reduceEvents assembles streamed text into messages", () => {
  const { messages, usage } = reduceEvents([
    { type: "agent_start" },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Dele" } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "gating." }, usage: { input: 10, output: 4 } },
    { type: "message_end" },
    { type: "agent_end" },
  ]);
  assert.deepStrictEqual(messages, [{ role: "assistant", text: "Delegating." }]);
  assert.deepStrictEqual(usage, { input: 10, output: 4 });
});

test("reduceEvents marks an unterminated message as partial", () => {
  const { messages } = reduceEvents([
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "still typ" } },
  ]);
  assert.strictEqual(messages[0].partial, true);
});

test("reduceEvents tracks tool calls through to their outcome", () => {
  const { toolCalls } = reduceEvents([
    { type: "tool_execution_start", toolCallId: "t1", toolName: "delegate", args: { bot: "scout" } },
    { type: "tool_execution_start", toolCallId: "t2", toolName: "check", args: {} },
    { type: "tool_execution_end", toolCallId: "t1", result: "ok", isError: false },
    { type: "tool_execution_end", toolCallId: "t2", result: "boom", isError: true },
  ]);
  assert.deepStrictEqual(toolCalls.map((t) => [t.name, t.state]), [["delegate", "done"], ["check", "error"]]);
});

test("an orphan tool_execution_end does not throw", () => {
  assert.doesNotThrow(() =>
    reduceEvents([{ type: "tool_execution_end", toolCallId: "ghost", result: "x", isError: false }]),
  );
});

test("jobIdsFrom extracts delegated job ids and ignores other tools", () => {
  const ids = jobIdsFrom([
    { name: "delegate", result: "id=20260821-044210-31337 bot=scout status=running" },
    { name: "delegate", result: { content: [{ text: "id=20260821-044999-42 bot=reviewer status=queued" }] } },
    { name: "delegate", result: "id=20260821-044210-31337 again" },
    { name: "check", result: "id=20260821-999999-99 bot=other" },
  ]);
  assert.deepStrictEqual(ids, ["20260821-044210-31337", "20260821-044999-42"]);
});
