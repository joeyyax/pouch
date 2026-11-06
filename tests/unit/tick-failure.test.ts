import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Envelope } from "@sentry/core";
import { reportTickFailure } from "@/lib/worker/tick-failure";
import type { Logger } from "@/lib/logger";

function envelopeText(envelope: Envelope): string {
  return JSON.stringify(envelope);
}

function fakeLogger(): Logger & { errors: string[] } {
  const errors: string[] = [];
  const self = {
    errors,
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (...args: unknown[]) => void errors.push(args.map(String).join(" ")),
    child: () => self,
  };
  return self as Logger & { errors: string[] };
}

describe("reportTickFailure", () => {
  let captured: Envelope[];

  beforeEach(async () => {
    process.env.GLITCHTIP_DSN = "https://test@errors.invalid/1";
    captured = [];
    const { initErrorReporting, resetErrorReportingForTests } = await import("@/lib/errors/report");
    resetErrorReportingForTests();
    initErrorReporting("test-sha", {
      transport: () => ({
        send: async (envelope: Envelope) => {
          captured.push(envelope);
          return {};
        },
        flush: async () => true,
      }),
    });
  });

  afterEach(async () => {
    delete process.env.GLITCHTIP_DSN;
    const { resetErrorReportingForTests } = await import("@/lib/errors/report");
    resetErrorReportingForTests();
    vi.restoreAllMocks();
  });

  it("reports a failing tick, not only logs it", async () => {
    // The worker runs unattended and stays up when a loop throws, so the crash handler never
    // fires. Before this, a loop failing every tick raised nothing at all.
    const log = fakeLogger();

    reportTickFailure(log, "stall-guard", new Error("relation \"domains\" does not exist"));
    await vi.waitFor(() => expect(captured.length).toBeGreaterThan(0));

    expect(log.errors[0]).toContain("tick failed");
    expect(envelopeText(captured[0]!)).toContain("does not exist");
  });

  it("tags the loop so one failing loop doesn't group with every other", async () => {
    const log = fakeLogger();

    reportTickFailure(log, "stall-guard", new Error("boom one"));
    reportTickFailure(log, "verify", new Error("boom two"));
    await vi.waitFor(() => expect(captured.length).toBe(2));

    const wire = captured.map(envelopeText).join("\n");
    expect(wire).toContain("loop:stall-guard");
    expect(wire).toContain("loop:verify");
  });

  it("carries the worker id when the loop has one, and omits it cleanly when it doesn't", async () => {
    const log = fakeLogger();

    reportTickFailure(log, "send", new Error("with worker"), "worker-7");
    await vi.waitFor(() => expect(captured.length).toBe(1));
    expect(envelopeText(captured[0]!)).toContain("worker-7");

    reportTickFailure(log, "retention", new Error("without worker"));
    await vi.waitFor(() => expect(captured.length).toBe(2));
    // An absent workerId must not become the string "undefined" in the report.
    expect(envelopeText(captured[1]!)).not.toContain("undefined");
  });
});
