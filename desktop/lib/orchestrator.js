"use strict";
/**
 * Drives the orchestrator: a `pi --mode rpc` child process speaking JSONL over
 * stdin/stdout.
 *
 * No Electron import, so it is testable under `node --test` with a fake child.
 *
 * Framing note: pi's RPC mode is strict JSONL with LF as the ONLY record
 * delimiter. Node's `readline` also splits on U+2028 and U+2029, which are legal
 * inside JSON strings - using it would corrupt any message containing them. So
 * this splits on "\n" by hand.
 */

const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");

class Orchestrator extends EventEmitter {
  /**
   * @param {{bin?, args?, cwd?, model?, spawn?: Function, env?: object}} [opts]
   */
  constructor(opts = {}) {
    super();
    this.bin = opts.bin || "pi";
    this.cwd = opts.cwd || process.cwd();
    this.model = opts.model || "";
    this.extraArgs = opts.args || [];
    this._spawn = opts.spawn || spawn;
    this._env = opts.env || process.env;

    this.child = null;
    this.streaming = false;
    this.ready = false;
    this._buf = "";
    this._stderr = "";
    this._seq = 0;
    this._pending = new Map();
  }

  argv() {
    const args = ["--mode", "rpc"];
    if (this.model) args.push("--model", this.model);
    return args.concat(this.extraArgs);
  }

  start() {
    if (this.child) throw new Error("orchestrator already started");
    this.child = this._spawn(this.bin, this.argv(), {
      cwd: this.cwd,
      env: this._env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout.setEncoding?.("utf8");
    this.child.stdout.on("data", (chunk) => this._ingest(String(chunk)));
    this.child.stderr?.setEncoding?.("utf8");
    this.child.stderr?.on("data", (chunk) => {
      this._stderr += String(chunk);
      if (this._stderr.length > 64 * 1024) this._stderr = this._stderr.slice(-64 * 1024);
    });
    this.child.on("error", (err) => this.emit("error", err));
    this.child.on("exit", (code, signal) => {
      this.child = null;
      this.ready = false;
      this.streaming = false;
      // Anything still awaiting a response will never get one.
      for (const [, p] of this._pending) {
        p.reject(new Error(`orchestrator exited (code ${code})`));
      }
      this._pending.clear();
      this.emit("exit", { code, signal, stderr: this._stderr.trim() });
    });

    this.ready = true;
    return this;
  }

  /** Split on LF only. A trailing partial line is held until the rest arrives. */
  _ingest(chunk) {
    this._buf += chunk;
    let nl;
    while ((nl = this._buf.indexOf("\n")) !== -1) {
      let line = this._buf.slice(0, nl);
      this._buf = this._buf.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.emit("malformed", line);
        continue;
      }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    if (msg.type === "response") {
      const pending = msg.id && this._pending.get(msg.id);
      if (pending) {
        this._pending.delete(msg.id);
        msg.success ? pending.resolve(msg) : pending.reject(new Error(msg.error || "command rejected"));
      }
      this.emit("response", msg);
      return;
    }

    // Track streaming so callers never have to decide between prompt and steer.
    if (msg.type === "agent_start") this.streaming = true;
    if (msg.type === "agent_end") this.streaming = false;

    this.emit("event", msg);
    if (msg.type) this.emit(msg.type, msg);
  }

  _send(command) {
    if (!this.child) throw new Error("orchestrator is not running");
    const id = `req-${++this._seq}`;
    const payload = JSON.stringify({ ...command, id });
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this.child.stdin.write(`${payload}\n`, (err) => {
        if (err) {
          this._pending.delete(id);
          reject(err);
        }
      });
    });
  }

  /**
   * Send a message. Picks the right delivery automatically: a plain prompt when
   * idle, a steer when the agent is mid-turn.
   */
  send(message, { deliver } = {}) {
    if (!this.streaming) return this._send({ type: "prompt", message });
    const mode = deliver || "steer";
    return this._send({ type: "prompt", message, streamingBehavior: mode });
  }

  steer(message) {
    return this._send({ type: "steer", message });
  }

  followUp(message) {
    return this._send({ type: "follow_up", message });
  }

  abort() {
    return this._send({ type: "abort" });
  }

  stop() {
    if (!this.child) return;
    const child = this.child;
    try {
      child.stdin.end();
    } catch { /* already closed */ }
    child.kill("SIGTERM");
  }
}

/**
 * Reduce pi's event stream into the small set of things the UI renders.
 * Kept separate from transport so it can be tested on recorded event arrays.
 */
function reduceEvents(events) {
  const messages = [];
  const toolCalls = [];
  let text = "";
  let usage = null;

  for (const e of events) {
    switch (e.type) {
      case "message_update": {
        const ev = e.assistantMessageEvent || {};
        if (ev.type === "text_delta" && typeof ev.delta === "string") text += ev.delta;
        if (e.usage) usage = e.usage;
        break;
      }
      case "message_end":
        if (text.trim()) messages.push({ role: "assistant", text: text.trim() });
        text = "";
        break;
      case "tool_execution_start":
        toolCalls.push({
          id: e.toolCallId,
          name: e.toolName,
          args: e.args,
          state: "running",
        });
        break;
      case "tool_execution_end": {
        const call = toolCalls.find((t) => t.id === e.toolCallId);
        if (call) {
          call.state = e.isError ? "error" : "done";
          call.result = e.result;
        }
        break;
      }
      default:
        break;
    }
  }
  if (text.trim()) messages.push({ role: "assistant", text: text.trim(), partial: true });
  return { messages, toolCalls, usage };
}

/** Pull job ids out of a delegate tool result so the UI can start tracking them. */
function jobIdsFrom(toolCalls) {
  const ids = new Set();
  for (const call of toolCalls) {
    if (call.name !== "delegate") continue;
    const blob = JSON.stringify(call.result || "");
    for (const m of blob.matchAll(/\bid=(\d{8}-\d{6}-\d+)/g)) ids.add(m[1]);
  }
  return [...ids];
}

module.exports = { Orchestrator, reduceEvents, jobIdsFrom };
