import { describe, expect, it } from "vitest";
import { setupSteps, type SetupState } from "@/lib/dashboard/views/setup";

const EMPTY: SetupState = { assigned: true, domainCount: 0, unverified: null, verified: null, keyCount: 0, liveKeyCount: 0, sent: null };
const PENDING = { id: "dom_1", name: "example.com", status: "pending" as const };
const VERIFIED = { ...PENDING, status: "verified" as const };

const byKey = (state: SetupState) => Object.fromEntries(setupSteps(state).map((step) => [step.key, step]));

describe("setupSteps", () => {
  it("starts with adding a domain and nothing done", () => {
    const steps = setupSteps(EMPTY);
    expect(steps.map((step) => step.key)).toEqual(["domain", "verify", "key", "send"]);
    expect(steps.every((step) => !step.done)).toBe(true);
    expect(steps[0]?.href).toBe("/domains?state=add");
  });

  it("offers no way to add a domain without a provider", () => {
    const { domain } = byKey({ ...EMPTY, assigned: false });
    expect(domain?.href).toBeNull();
    expect(domain?.detail).toMatch(/provider/);
  });

  it("sends verification to the pending domain's setup", () => {
    const { domain, verify, send } = byKey({ ...EMPTY, domainCount: 1, unverified: PENDING });
    expect(domain?.done).toBe(true);
    expect(verify?.done).toBe(false);
    expect(verify?.href).toBe("/domains/dom_1/setup");
    expect(send?.href).toBeNull();
  });

  it("says when verification failed", () => {
    const { verify } = byKey({ ...EMPTY, domainCount: 1, unverified: { ...PENDING, status: "failed" } });
    expect(verify?.detail).toMatch(/failed verification/);
  });

  it("opens the test send once a domain verifies", () => {
    const { verify, send } = byKey({ ...EMPTY, domainCount: 1, verified: VERIFIED, keyCount: 1 });
    expect(verify?.done).toBe(true);
    expect(send?.done).toBe(false);
    expect(send?.href).toBe("/domains/dom_1/sending");
  });

  it("keeps the send open after test mode, pointing at a live key", () => {
    const steps = setupSteps({ ...EMPTY, domainCount: 1, verified: VERIFIED, keyCount: 1, sent: "test" });
    const send = steps.find((step) => step.key === "send");
    expect(steps.filter((step) => step.done)).toHaveLength(3);
    expect(send?.done).toBe(false);
    expect(send?.detail).toBe("Sent in test mode. Send one with a live key.");
    expect(send?.href).toBe("/keys?state=create");
    expect(send?.action).toBe("Create a live key");
    expect(send?.example).toBe(false);
  });

  it("sends test mode on to the domain once a live key exists", () => {
    const { send } = byKey({ ...EMPTY, domainCount: 1, verified: VERIFIED, keyCount: 2, liveKeyCount: 1, sent: "test" });
    expect(send?.done).toBe(false);
    expect(send?.href).toBe("/domains/dom_1/sending");
    expect(send?.example).toBe(true);
  });

  it("is done after a live send", () => {
    const { send } = byKey({ ...EMPTY, domainCount: 1, verified: VERIFIED, keyCount: 1, liveKeyCount: 1, sent: "live" });
    expect(send?.done).toBe(true);
    expect(send?.href).toBeNull();
  });

  it("lets a key come before verification", () => {
    const { key, verify } = byKey({ ...EMPTY, domainCount: 1, unverified: PENDING, keyCount: 2 });
    expect(key?.done).toBe(true);
    expect(key?.detail).toBe("2 keys active.");
    expect(verify?.done).toBe(false);
  });
});
