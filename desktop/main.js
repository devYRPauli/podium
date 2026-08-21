"use strict";
/**
 * Podium Console - Electron main process.
 *
 * Owns the two things the renderer must never touch directly: the podium CLI
 * and the orchestrator child process. The renderer gets a narrow, typed IPC
 * surface through preload.js and no Node access at all.
 */

const { app, BrowserWindow, ipcMain, shell, dialog } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { Podium } = require("./lib/podium.js");
const { Orchestrator, reduceEvents, jobIdsFrom } = require("./lib/orchestrator.js");

const SETTINGS_FILE = path.join(app.getPath("userData"), "settings.json");
const POLL_MS = 2000;

let win = null;
let orc = null;
let pollTimer = null;
let settings = loadSettings();
let podium = new Podium({ home: settings.home, bin: settings.bin });

function loadSettings() {
  const home = process.env.PODIUM_HOME
    || path.join(app.getPath("home"), ".podium");
  const defaults = {
    home,
    bin: path.join(home, "bin", "podium"),
    piBin: "pi",
    model: "",
    cwd: app.getPath("home"),
  };
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) };
  } catch {
    return defaults;
  }
}

function saveSettings(next) {
  settings = { ...settings, ...next };
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  podium = new Podium({ home: settings.home, bin: settings.bin });
  return settings;
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    backgroundColor: "#0d1118",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once("ready-to-show", () => {
    win.show();
    // Smoke mode: drive each view, capture it, and report what rendered. This
    // is how the UI gets tested without a human looking at it.
    if (process.env.PODIUM_SMOKE) {
      const shot = async (name) => {
        const image = await win.webContents.capturePage();
        fs.writeFileSync(`${process.env.PODIUM_SMOKE}-${name}.png`, image.toPNG());
      };
      const js = (code) => win.webContents.executeJavaScript(code);
      const settle = (ms) => new Promise((r) => setTimeout(r, ms));

      setTimeout(async () => {
        const report = {};
        try {
          report.talk = JSON.parse(await js(
            "JSON.stringify({" +
            "bots: document.querySelectorAll('#rail-body .bot').length," +
            "jobs: document.querySelectorAll('#jobs-list .job').length," +
            "badges: [...document.querySelectorAll('#jobs-list .badge')].map(b=>b.textContent)," +
            "sheetVisible: getComputedStyle(document.getElementById('sheet')).display !== 'none'," +
            "bannerVisible: getComputedStyle(document.getElementById('banner')).display !== 'none'" +
            "})"));
          await shot("talk");

          await js("document.querySelector('[data-view=roster]').click()");
          await settle(400);
          report.roster = JSON.parse(await js(
            "JSON.stringify({visible: document.getElementById('view-roster').classList.contains('is-on')," +
            "prompts: document.querySelectorAll('#view-roster pre').length})"));
          await shot("roster");

          await js("document.querySelector('[data-view=receipts]').click()");
          await settle(800);
          report.receipts = JSON.parse(await js(
            "JSON.stringify({visible: document.getElementById('view-receipts').classList.contains('is-on')," +
            "rows: document.querySelectorAll('#view-receipts tbody tr').length," +
            "stats: [...document.querySelectorAll('#view-receipts .stat')].map(s=>s.textContent)," +
            "chain: (document.querySelector('#view-receipts .chainbar')||{}).textContent||''," +
            "noneGiven: document.querySelectorAll('#view-receipts .check.none').length})"));
          await shot("receipts");

          await js("document.querySelectorAll('.filters button')[1].click()");
          await settle(800);
          report.unverifiedFilter = JSON.parse(await js(
            "JSON.stringify({rows: document.querySelectorAll('#view-receipts tbody tr').length})"));
          await shot("receipts-unverified");

          await js("document.querySelector('[data-view=talk]').click()");
          await settle(250);
          await js("document.querySelector('#jobs-list .job').click()");
          await settle(1000);
          report.sheet = JSON.parse(await js(
            "JSON.stringify({visible: getComputedStyle(document.getElementById('sheet')).display !== 'none'," +
            "title: document.getElementById('sheet-title').textContent," +
            "fields: [...document.querySelectorAll('#sheet-body .field .k')].map(k=>k.textContent)})"));
          await shot("job-detail");

          process.stdout.write(`SMOKE ${JSON.stringify(report)}\n`);
        } catch (err) {
          process.stdout.write(`SMOKE_ERROR ${String(err && err.message)}\n`);
          process.stdout.write(`SMOKE_PARTIAL ${JSON.stringify(report)}\n`);
        } finally {
          app.exit(0);
        }
      }, Number(process.env.PODIUM_SMOKE_DELAY || 2200));
    }
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));

  // External links open in the real browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  startPolling();
}

/**
 * The job list is polled rather than pushed: the runner is a detached process
 * that may have been started by something other than this app, and the files on
 * disk are the source of truth.
 */
function startPolling() {
  stopPolling();
  pollTimer = setInterval(async () => {
    try {
      const jobs = await podium.jobs();
      send("jobs:update", jobs);
    } catch (err) {
      send("jobs:error", String(err.message || err));
    }
  }, POLL_MS);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

// ---- IPC: podium ----------------------------------------------------------

const handlers = {
  "podium:settings": async () => settings,
  "podium:saveSettings": async (_e, next) => saveSettings(next),
  "podium:doctor": async () => podium.doctor(),
  "podium:version": async () => podium.version(),
  "podium:bots": async () => podium.bots(),
  "podium:jobs": async (_e, filter) => podium.jobs(filter || {}),
  "podium:job": async (_e, id) => podium.job(id),
  "podium:result": async (_e, id) => podium.result(id),
  "podium:cancel": async (_e, id) => podium.cancel(id),
  "podium:ledger": async (_e, opts) => podium.ledger(opts || {}),
  "podium:stats": async () => podium.stats(),
  "podium:audit": async () => podium.audit(),
  "podium:run": async (_e, { bot, brief, check, cwd }) =>
    podium.run(bot, brief, { cwd: cwd || settings.cwd, check }),
  "podium:reveal": async (_e, id) => {
    shell.showItemInFolder(podium.outputPath(id));
    return true;
  },
  "podium:pickCwd": async () => {
    const res = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
    if (res.canceled || !res.filePaths.length) return null;
    saveSettings({ cwd: res.filePaths[0] });
    return res.filePaths[0];
  },
};

// ---- IPC: orchestrator ----------------------------------------------------

handlers["orc:start"] = async () => {
  if (orc) return { running: true };
  orc = new Orchestrator({
    bin: settings.piBin,
    cwd: settings.cwd,
    model: settings.model,
    env: { ...process.env, PODIUM_HOME: settings.home },
  });

  const batch = [];
  orc.on("event", (event) => {
    batch.push(event);
    // Reduce on the main side so the renderer stays a pure view.
    const view = reduceEvents(batch);
    send("orc:view", {
      ...view,
      streaming: orc ? orc.streaming : false,
      jobIds: jobIdsFrom(view.toolCalls),
    });
  });
  orc.on("malformed", (line) => send("orc:malformed", line));
  orc.on("error", (err) => send("orc:error", String(err.message || err)));
  orc.on("exit", (info) => {
    orc = null;
    send("orc:exit", info);
  });

  try {
    orc.start();
  } catch (err) {
    orc = null;
    throw err;
  }
  return { running: true };
};

handlers["orc:send"] = async (_e, { message, deliver }) => {
  if (!orc) throw new Error("orchestrator is not running");
  await orc.send(message, { deliver });
  return true;
};

handlers["orc:abort"] = async () => {
  if (!orc) return false;
  await orc.abort().catch(() => {});
  return true;
};

handlers["orc:stop"] = async () => {
  if (orc) orc.stop();
  orc = null;
  return true;
};

handlers["orc:status"] = async () => ({
  running: Boolean(orc),
  streaming: Boolean(orc && orc.streaming),
});

for (const [channel, fn] of Object.entries(handlers)) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return { ok: true, value: await fn(event, ...args) };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });
}

// ---- lifecycle ------------------------------------------------------------

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("before-quit", () => {
  stopPolling();
  // Deliberately only stops the orchestrator conversation. Delegated jobs are
  // detached by design and keep running after the app closes - that is the
  // whole point of the runner.
  if (orc) orc.stop();
});

module.exports = { handlers, loadSettings };
