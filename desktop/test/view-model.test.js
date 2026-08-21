"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { verdictBadge, relTime, receiptSummary, filterLedger } = require("../renderer/view-model.js");

test("a job is verified ONLY when a check ran and passed", () => {
  assert.strictEqual(verdictBadge({ status: "done", verified: true }).label, "verified");
  assert.strictEqual(verdictBadge({ status: "done", verified: false }).label, "unverified");
  assert.strictEqual(verdictBadge({ status: "done" }).label, "unverified",
    "absent verification is unverified, never a pass");
});

test("a clean bot exit cannot launder an unchecked job into a pass", () => {
  // The exact failure this whole design exists to prevent.
  const badge = verdictBadge({ status: "done", exit_code: 0, verified: false, check: "" });
  assert.strictEqual(badge.cls, "unverified");
  assert.notStrictEqual(badge.cls, "verified");
});

test("a failed acceptance check reads as rejected, not done", () => {
  const badge = verdictBadge({ status: "rejected", verified: false, check_exit: 7 });
  assert.deepStrictEqual(badge, { cls: "failed", label: "rejected" });
});

test("throttling is visually distinct from a hang", () => {
  assert.strictEqual(verdictBadge({ status: "rate_limited" }).label, "throttled");
  assert.strictEqual(verdictBadge({ status: "timeout" }).label, "timed out");
  assert.notStrictEqual(
    verdictBadge({ status: "rate_limited" }).cls,
    verdictBadge({ status: "timeout" }).cls,
    "a starved job must not look like a broken one",
  );
});

test("in-flight states are labelled as running", () => {
  assert.strictEqual(verdictBadge({ status: "queued" }).cls, "running");
  assert.strictEqual(verdictBadge({ status: "running" }).cls, "running");
});

test("cancelled is neutral, not a failure", () => {
  assert.strictEqual(verdictBadge({ status: "cancelled" }).cls, "neutral");
});

test("a malformed job object does not throw", () => {
  assert.strictEqual(verdictBadge(null).label, "unknown");
  assert.strictEqual(verdictBadge({}).label, "unknown");
  assert.strictEqual(verdictBadge({ status: "" }).label, "unknown");
});

test("an unrecognised status falls through to the verification rule", () => {
  assert.strictEqual(verdictBadge({ status: "weird-new-state", verified: true }).label, "verified");
  assert.strictEqual(verdictBadge({ status: "weird-new-state" }).label, "unverified");
});

test("relTime formats across the ranges and handles junk", () => {
  assert.strictEqual(relTime(0), "0s");
  assert.strictEqual(relTime(45), "45s");
  assert.strictEqual(relTime(60), "1m 0s");
  assert.strictEqual(relTime(3599), "59m 59s");
  assert.strictEqual(relTime(3600), "1h 0m");
  assert.strictEqual(relTime(7325), "2h 2m");
  assert.strictEqual(relTime(null), "—");
  assert.strictEqual(relTime(undefined), "—");
  assert.strictEqual(relTime("nope"), "—");
  assert.strictEqual(relTime(-5), "0s", "a clock skew must not render as negative");
});

test("receiptSummary counts verification honestly", () => {
  const rows = [
    { verified: true,  status: "done",     check: "npm test", duration_secs: 10 },
    { verified: false, status: "done",     check: "",         duration_secs: 5 },
    { verified: false, status: "rejected", check: "npm test", duration_secs: 7 },
    { verified: false, status: "timeout",  check: "npm test", duration_secs: 30 },
  ];
  const s = receiptSummary(rows);
  assert.strictEqual(s.total, 4);
  assert.strictEqual(s.verified, 1);
  assert.strictEqual(s.unverified, 3, "rejected and timed-out jobs are not verified");
  assert.strictEqual(s.rejected, 1);
  assert.strictEqual(s.noCheck, 1);
  assert.strictEqual(s.seconds, 52);
});

test("receiptSummary tolerates an empty or junk ledger", () => {
  assert.strictEqual(receiptSummary([]).total, 0);
  assert.strictEqual(receiptSummary(null).total, 0);
  assert.strictEqual(receiptSummary([null, undefined]).total, 2);
  assert.strictEqual(receiptSummary([{ duration_secs: "abc" }]).seconds, 0);
});

test("the unverified filter never hides a problem", () => {
  const rows = [
    { id: "1", verified: true,  status: "done" },
    { id: "2", verified: false, status: "done" },
    { id: "3", verified: false, status: "rejected" },
    { id: "4", status: "timeout" },
  ];
  const shown = filterLedger(rows, "unverified").map((r) => r.id);
  assert.deepStrictEqual(shown, ["2", "3", "4"]);
  assert.strictEqual(filterLedger(rows, "all").length, 4);
  assert.strictEqual(filterLedger(null, "unverified").length, 0);
});
