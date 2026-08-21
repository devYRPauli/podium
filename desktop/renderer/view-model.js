"use strict";
/**
 * Pure view logic, shared by the renderer and the test suite.
 *
 * Loaded as a plain script in the browser (defines window.PodiumView) and
 * required directly under node --test. It holds the decisions that must not
 * drift: what counts as verified, and how a job is labelled.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PodiumView = api;
})(typeof self !== "undefined" ? self : this, function () {

  /**
   * The single place that decides what a job's verdict looks like.
   *
   * The rule that matters: a job is only "verified" when the runner ran an
   * acceptance check and that check passed. Finishing without a check is
   * "unverified" - never a pass. Nothing about the bot's own exit code can
   * upgrade a job to verified.
   */
  function verdictBadge(job) {
    if (!job || !job.status) return { cls: "neutral", label: "unknown" };
    switch (job.status) {
      case "queued":
      case "running":       return { cls: "running", label: job.status };
      case "rejected":      return { cls: "failed", label: "rejected" };
      case "failed":        return { cls: "failed", label: "failed" };
      case "timeout":       return { cls: "failed", label: "timed out" };
      case "rate_limited":  return { cls: "unverified", label: "throttled" };
      case "cancelled":     return { cls: "neutral", label: "cancelled" };
      default:
        return job.verified === true
          ? { cls: "verified", label: "verified" }
          : { cls: "unverified", label: "unverified" };
    }
  }

  function relTime(seconds) {
    if (seconds === null || seconds === undefined || Number.isNaN(Number(seconds))) return "—";
    const s = Math.max(0, Math.floor(Number(seconds)));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  }

  /** Split a ledger into the counts the Receipts header shows. */
  function receiptSummary(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const verified = list.filter((r) => r && r.verified === true).length;
    const rejected = list.filter((r) => r && r.status === "rejected").length;
    const noCheck = list.filter((r) => r && !r.check).length;
    return {
      total: list.length,
      verified,
      unverified: list.length - verified,
      rejected,
      noCheck,
      seconds: list.reduce((sum, r) => sum + (Number(r && r.duration_secs) || 0), 0),
    };
  }

  function filterLedger(rows, filter) {
    const list = Array.isArray(rows) ? rows : [];
    return filter === "unverified" ? list.filter((r) => r && r.verified !== true) : list;
  }

  return { verdictBadge, relTime, receiptSummary, filterLedger };
});
