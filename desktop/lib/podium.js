"use strict";
/**
 * A typed-ish wrapper around the `podium` CLI.
 *
 * Deliberately has no Electron import, so it runs under `node --test`. The
 * desktop app is a view over the same files the CLI writes; this module is the
 * only place that knows how to read them.
 */

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_HOME = path.join(
  process.env.HOME || process.env.USERPROFILE || ".",
  ".podium",
);

class PodiumError extends Error {}

class Podium {
  /**
   * @param {{bin?: string, home?: string, exec?: Function}} [opts]
   *   `exec` is injectable so tests can drive this without a real binary.
   */
  constructor(opts = {}) {
    this.home = opts.home || process.env.PODIUM_HOME || DEFAULT_HOME;
    this.bin = opts.bin || path.join(this.home, "bin", "podium");
    this._exec = opts.exec || execFile;
  }

  _run(args, { timeout = 30000 } = {}) {
    return new Promise((resolve, reject) => {
      this._exec(
        this.bin,
        args,
        {
          timeout,
          maxBuffer: 32 * 1024 * 1024,
          env: { ...process.env, PODIUM_HOME: this.home },
        },
        (err, stdout, stderr) => {
          if (err) {
            const detail = (stderr || err.message || "").toString().trim();
            return reject(new PodiumError(detail || `podium ${args[0]} failed`));
          }
          resolve(stdout.toString());
        },
      );
    });
  }

  /** Parse JSON, but fail with the offending output rather than a bare SyntaxError. */
  static _json(raw, what) {
    try {
      return JSON.parse(raw);
    } catch (e) {
      throw new PodiumError(
        `podium ${what} did not return JSON: ${String(raw).slice(0, 200)}`,
      );
    }
  }

  async version() {
    return (await this._run(["version"])).trim();
  }

  /** Preflight. Returns {ready, checks:[{ok,label}], raw}. Never throws on "not ready". */
  async doctor() {
    let raw;
    try {
      raw = await this._run(["doctor"]);
    } catch (e) {
      raw = e.message;
    }
    const checks = [];
    for (const line of raw.split("\n")) {
      const m = /^(ok|FAIL)\s+(.*)$/.exec(line.trim());
      if (m) checks.push({ ok: m[1] === "ok", label: m[2] });
    }
    return { ready: checks.length > 0 && checks.every((c) => c.ok), checks, raw };
  }

  /** The roster, read from disk rather than parsed out of column-formatted text. */
  async bots() {
    const dir = path.join(this.home, "bots");
    let names;
    try {
      names = fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    } catch {
      return [];
    }
    return names
      .map((name) => {
        const file = path.join(dir, name, "bot.md");
        if (!fs.existsSync(file)) return null;
        const src = fs.readFileSync(file, "utf8");
        const meta = parseFrontmatter(src);
        let memory = "";
        try {
          memory = fs.readFileSync(path.join(dir, name, "memory.md"), "utf8");
        } catch { /* no memory yet */ }
        return {
          name,
          description: meta.description || "",
          model: meta.model || "",
          tools: meta.tools ? meta.tools.split(",").map((t) => t.trim()).filter(Boolean) : [],
          prompt: stripFrontmatter(src),
          memory,
          memoryLines: memory.split("\n").filter((l) => l.trim()).length,
        };
      })
      .filter(Boolean);
  }

  async jobs({ bot, status } = {}) {
    const args = ["list", "--json"];
    if (bot) args.push("--bot", bot);
    if (status) args.push("--status", status);
    const raw = await this._run(args);
    return Podium._json(raw, "list");
  }

  async job(id) {
    return Podium._json(await this._run(["show", id]), "show");
  }

  async status(id) {
    return Podium._json(await this._run(["status", "--json", id]), "status");
  }

  async result(id) {
    return this._run(["result", id]);
  }

  async run(bot, brief, { cwd, model, timeout } = {}) {
    const args = ["run", bot, brief];
    if (cwd) args.push("--cwd", cwd);
    if (model) args.push("--model", model);
    if (timeout) args.push("--timeout", String(timeout));
    return (await this._run(args)).trim();
  }

  async cancel(id) {
    return (await this._run(["cancel", id])).trim();
  }

  /** The audit ledger, newest first. Skips malformed lines rather than throwing. */
  ledger({ limit = 200 } = {}) {
    const file = path.join(this.home, "log.jsonl");
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      return [];
    }
    const out = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch { /* a partially written line; skip it */ }
    }
    return out.reverse().slice(0, limit);
  }

  /** Aggregate the ledger into the numbers the console header shows. */
  stats() {
    const rows = this.ledger({ limit: Infinity });
    const byBot = {};
    let failed = 0;
    let seconds = 0;
    for (const r of rows) {
      byBot[r.bot] = (byBot[r.bot] || 0) + 1;
      if (r.status !== "done") failed += 1;
      seconds += Number(r.duration_secs) || 0;
    }
    return {
      total: rows.length,
      failed,
      succeeded: rows.length - failed,
      seconds,
      byBot,
    };
  }

  /**
   * Walk the receipt chain. Returns {intact, receipts, head, detail}.
   * A broken chain is a finding, not an error, so this never throws on tamper.
   */
  async audit() {
    let raw;
    try {
      raw = await this._run(["audit"]);
    } catch (err) {
      raw = err.message || "";
    }
    const intact = /chain intact/.test(raw);
    const receipts = Number((/(\d+) receipt/.exec(raw) || [])[1] ?? 0);
    const head = (/head: ([0-9a-f]+)/.exec(raw) || [])[1] || "";
    return { intact, receipts, head, detail: raw.trim() };
  }

  /** Where a job's growing output lives, so the UI can tail it. */
  outputPath(id) {
    return path.join(this.home, "jobs", id, "out.txt");
  }
}

function parseFrontmatter(src) {
  const meta = {};
  const lines = src.split("\n");
  if (lines[0] !== "---") return meta;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") break;
    const idx = lines[i].indexOf(":");
    if (idx === -1) continue;
    meta[lines[i].slice(0, idx).trim()] = lines[i].slice(idx + 1).trim();
  }
  return meta;
}

function stripFrontmatter(src) {
  const lines = src.split("\n");
  if (lines[0] !== "---") return src;
  const end = lines.indexOf("---", 1);
  return end === -1 ? src : lines.slice(end + 1).join("\n").trim();
}

module.exports = { Podium, PodiumError, parseFrontmatter, stripFrontmatter };
