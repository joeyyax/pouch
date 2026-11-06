import { describe, expect, it, vi } from "vitest";
import { LATE, registerHealthCheck, runHealthChecks } from "@/lib/health/registry";

const pass = async () => ({ ok: true, detail: null });

describe("runHealthChecks", () => {
  it("is error when a critical check fails, degraded when only a non-critical one does", async () => {
    registerHealthCheck({ name: "core", critical: true, run: pass });
    registerHealthCheck({ name: "extra", critical: false, run: async () => ({ ok: false, detail: "Bucket not found." }) });

    const degraded = await runHealthChecks(1000);
    expect(degraded).toMatchObject({ ok: true, status: "degraded", degraded: ["extra"] });
    expect(degraded.checks.extra).toEqual({ ok: false, critical: false, detail: "Bucket not found." });

    registerHealthCheck({ name: "core", critical: true, run: async () => ({ ok: false, detail: "Postgres didn't respond in time." }) });
    expect(await runHealthChecks(1000)).toMatchObject({ ok: false, status: "error" });
    registerHealthCheck({ name: "core", critical: true, run: pass });
    registerHealthCheck({ name: "extra", critical: false, run: pass });
  });

  it("never puts a thrown error's message in the unauthenticated body", async () => {
    registerHealthCheck({ name: "throws", critical: false, run: async () => Promise.reject(new Error("connect ECONNREFUSED 10.0.0.5:5432")) });
    const body = JSON.stringify(await runHealthChecks(1000));
    expect(body).not.toContain("10.0.0.5");
    expect(body).toContain("Check failed.");
    registerHealthCheck({ name: "throws", critical: false, run: pass });
  });

  it("reports a check that doesn't answer as failed", async () => {
    registerHealthCheck({ name: "hangs", critical: true, run: () => new Promise(() => {}) });
    vi.useFakeTimers();
    try {
      const pending = runHealthChecks(500);
      await vi.advanceTimersByTimeAsync(500);
      const report = await pending;
      expect(report.ok).toBe(false);
      expect(report.checks.hangs).toEqual({ ok: false, critical: true, detail: LATE });
    } finally {
      vi.useRealTimers();
      registerHealthCheck({ name: "hangs", critical: true, run: pass });
    }
  });

  it("skips a check that isn't enabled, and lists counts beside the verdict", async () => {
    registerHealthCheck({ name: "off", critical: true, enabled: () => false, run: async () => ({ ok: false, detail: "x" }) });
    registerHealthCheck({ name: "counted", critical: true, run: async () => ({ ok: true, detail: null, counts: { count: 2 } }) });
    const report = await runHealthChecks(1000);
    expect(report.checks.off).toBeUndefined();
    expect(report.checks.counted).toEqual({ ok: true, critical: true, detail: null, count: 2 });
  });
});
