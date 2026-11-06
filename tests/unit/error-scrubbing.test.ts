import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Envelope } from "@sentry/core";
import { allowlistContext, redactText, safeErrorMessage } from "@/lib/errors/scrub";

const RECIPIENT = "victim@example.com";
const SUBJECT = "Your invoice #4471 is overdue";
const API_KEY = ["sk", "live", "9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c"].join("_");
const PROVIDER_CREDENTIAL = "AKIAABCDEFGHIJKLMNOP";

/** Everything an envelope's JSON must never contain, whatever shape the event takes. */
const FORBIDDEN = [RECIPIENT, SUBJECT, API_KEY, PROVIDER_CREDENTIAL];

function envelopeText(envelope: Envelope): string {
  // An envelope is [header, items[]]; each item is [itemHeader, payload]. Stringify everything —
  // the point is what the wire format holds, not which field a particular SDK version puts it in.
  return JSON.stringify(envelope);
}

describe("redactText", () => {
  it("removes email addresses", () => {
    expect(redactText(`send to ${RECIPIENT} failed`)).not.toContain(RECIPIENT);
    expect(redactText(`send to ${RECIPIENT} failed`)).toContain("[redacted-address]");
  });

  it("removes bearer tokens and key= style credentials", () => {
    expect(redactText(`Authorization: Bearer ${API_KEY}`)).not.toContain(API_KEY);
    expect(redactText(`apiKey=${API_KEY}`)).not.toContain(API_KEY);
  });

  it("removes AWS-style access keys", () => {
    expect(redactText(`credentials ${PROVIDER_CREDENTIAL} rejected`)).not.toContain(PROVIDER_CREDENTIAL);
  });

  it("leaves ordinary text alone", () => {
    expect(redactText("message msg_123 has no stored body")).toBe("message msg_123 has no stored body");
  });
});

describe("allowlistContext", () => {
  it("keeps only known fields, dropping anything else the caller passes", () => {
    const out = allowlistContext({
      messageId: "msg_1",
      organizationId: "org_1",
      // @ts-expect-error - proving an unreviewed field is dropped, not forwarded.
      recipient: RECIPIENT,
    });

    expect(out).toEqual({ messageId: "msg_1", organizationId: "org_1" });
  });

  it("returns an empty object for no context", () => {
    expect(allowlistContext(undefined)).toEqual({});
  });
});

describe("reportError, capturing the envelope the SDK would actually send", () => {
  let capturedEnvelopes: Envelope[];

  beforeEach(async () => {
    process.env.GLITCHTIP_DSN = "https://test@errors.invalid/1";
    capturedEnvelopes = [];
    const { initErrorReporting, resetErrorReportingForTests } = await import("@/lib/errors/report");
    resetErrorReportingForTests();
    initErrorReporting("test-sha", {
      // A fake transport standing in for the real HTTP one. What lands here is exactly what
      // would go over the wire to GlitchTip, after beforeSend has run.
      transport: () => ({
        send: async (envelope: Envelope) => {
          capturedEnvelopes.push(envelope);
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
  });

  it("never puts a recipient, subject, api key or provider credential on the wire", async () => {
    const { reportError, flushErrorReporting } = await import("@/lib/errors/report");

    const error = new Error(
      `send to ${RECIPIENT} ("${SUBJECT}") failed: Authorization: Bearer ${API_KEY}, provider credential ${PROVIDER_CREDENTIAL} rejected`,
    );

    reportError(error, {
      messageId: "msg_123",
      organizationId: "org_456",
      providerId: "acct_789",
      // @ts-expect-error - not an allowlisted field; must never reach the envelope either.
      recipient: RECIPIENT,
    });

    await flushErrorReporting();

    expect(capturedEnvelopes.length).toBeGreaterThan(0);
    const wire = capturedEnvelopes.map(envelopeText).join("\n");

    for (const secret of FORBIDDEN) {
      expect(wire).not.toContain(secret);
    }

    // The join key and allowlisted fields do go through — that's the point of the allowlist.
    expect(wire).toContain("msg_123");
    expect(wire).toContain("org_456");
  });

  it("drops breadcrumbs, request and user data entirely", async () => {
    const { reportError, flushErrorReporting } = await import("@/lib/errors/report");

    reportError(new Error(`failed for ${RECIPIENT}`), { messageId: "msg_1" });
    await flushErrorReporting();

    const wire = capturedEnvelopes.map(envelopeText).join("\n");
    expect(wire).not.toContain('"breadcrumbs"');
    expect(wire).not.toContain('"request"');
    expect(wire).not.toContain('"user"');
  });
});

describe("reportError with no DSN configured", () => {
  it("sends nothing", async () => {
    delete process.env.GLITCHTIP_DSN;
    const { initErrorReporting, reportError, isErrorReportingArmed, resetErrorReportingForTests } = await import(
      "@/lib/errors/report"
    );
    resetErrorReportingForTests();

    let calls = 0;
    initErrorReporting(undefined, {
      transport: () => ({
        send: async () => {
          calls += 1;
          return {};
        },
        flush: async () => true,
      }),
    });

    expect(isErrorReportingArmed()).toBe(false);
    reportError(new Error(`failed for ${RECIPIENT}`), { messageId: "msg_1" });
    expect(calls).toBe(0);
  });
});

describe("safeErrorMessage", () => {
  it("drops a postgres error's detail, which carries column values", () => {
    const error = Object.assign(new Error("duplicate key value violates unique constraint"), {
      name: "PostgresError",
      code: "23505",
      constraint_name: "messages_idempotency_idx",
      detail: `Key (recipients)=(${RECIPIENT}) already exists.`,
    });

    const message = safeErrorMessage(error);

    expect(message).toBe("database error 23505 on messages_idempotency_idx");
    expect(message).not.toContain(RECIPIENT);
  });

  it("finds the driver error through drizzle's wrapper", () => {
    const driver = Object.assign(new Error("boom"), { name: "PostgresError", code: "23503", table_name: "messages" });
    const wrapped = Object.assign(new Error(`Failed query: insert into messages\nparams: ${RECIPIENT}`), {
      name: "DrizzleQueryError",
      cause: driver,
    });

    expect(safeErrorMessage(wrapped)).toBe("database error 23503 on messages");
  });

  it("drops a drizzle wrapper's query and parameters even with no driver error under it", () => {
    const wrapped = Object.assign(new Error(`Failed query: insert into messages\nparams: ${RECIPIENT}`), {
      name: "DrizzleQueryError",
    });

    expect(safeErrorMessage(wrapped)).toBe("database error");
  });

  it("passes an ordinary error through untouched", () => {
    expect(safeErrorMessage(new Error("the provider timed out"))).toBe("the provider timed out");
    expect(safeErrorMessage("plain string")).toBe("plain string");
  });
});
