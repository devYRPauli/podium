"use strict";
/**
 * The only bridge between the renderer and Node. Every call is an explicit
 * method; the renderer never sees ipcRenderer, require, or a filesystem path it
 * did not receive from main.
 */
const { contextBridge, ipcRenderer } = require("electron");

/** Unwrap the {ok, value|error} envelope so the renderer can just await. */
async function call(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res || res.ok !== true) throw new Error((res && res.error) || "call failed");
  return res.value;
}

const on = (channel) => (handler) => {
  const wrapped = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

contextBridge.exposeInMainWorld("podium", {
  settings: () => call("podium:settings"),
  saveSettings: (next) => call("podium:saveSettings", next),
  doctor: () => call("podium:doctor"),
  version: () => call("podium:version"),
  bots: () => call("podium:bots"),
  jobs: (filter) => call("podium:jobs", filter),
  job: (id) => call("podium:job", id),
  result: (id) => call("podium:result", id),
  cancel: (id) => call("podium:cancel", id),
  ledger: (opts) => call("podium:ledger", opts),
  stats: () => call("podium:stats"),
  audit: () => call("podium:audit"),
  run: (spec) => call("podium:run", spec),
  reveal: (id) => call("podium:reveal", id),
  pickCwd: () => call("podium:pickCwd"),

  orchestrator: {
    start: () => call("orc:start"),
    send: (message, deliver) => call("orc:send", { message, deliver }),
    abort: () => call("orc:abort"),
    stop: () => call("orc:stop"),
    status: () => call("orc:status"),
  },

  onJobs: on("jobs:update"),
  onJobsError: on("jobs:error"),
  onView: on("orc:view"),
  onMalformed: on("orc:malformed"),
  onOrcError: on("orc:error"),
  onOrcExit: on("orc:exit"),
});
