import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GetBucketLifecycleConfigurationCommand, S3Client, type LifecycleRule } from "@aws-sdk/client-s3";
import { adminActor } from "@/lib/activity/record";
import { readiness } from "@/lib/health/readyz";
import { watchChecks, type CheckState, type HealthTransition } from "@/lib/health/watch";
import { readSetting, setSetting } from "@/lib/settings/values";
import { bodiesRoot } from "@/lib/storage/bodies";
import { inboundRoot } from "@/lib/inbound/attachments";
import { describeBodyLifecycle, readBodyLifecycle, resetBodyLifecycleCache } from "@/lib/storage/lifecycle";
import { readBodyLifecycleView, readInboundLifecycleView } from "@/lib/system/read";
import { resetDatabase } from "./fixtures";

const ADMIN = adminActor("usr_admin", "Admin");

/** What the bucket answers: its rules, or an error to throw. */
let bucket: { rules: LifecycleRule[] } | { error: string } = { rules: [] };

function expiring(days: number): LifecycleRule {
  return { ID: "bodies", Status: "Enabled", Filter: { Prefix: `${bodiesRoot()}/` }, Expiration: { Days: days } };
}

function expiringInbound(days: number): LifecycleRule {
  return { ID: "inbound", Status: "Enabled", Filter: { Prefix: `${inboundRoot()}/` }, Expiration: { Days: days } };
}

const send = S3Client.prototype.send;
vi.spyOn(S3Client.prototype, "send").mockImplementation(function (this: S3Client, command: unknown, ...rest: unknown[]) {
  if (!(command instanceof GetBucketLifecycleConfigurationCommand)) return (send as (...args: unknown[]) => unknown).call(this, command, ...rest);
  if ("error" in bucket) return Promise.reject(Object.assign(new Error(bucket.error), { name: bucket.error }));
  return Promise.resolve({ Rules: bucket.rules });
} as never);

beforeEach(async () => {
  await resetDatabase();
  resetBodyLifecycleCache();
  bucket = { rules: [] };
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("setting the retention ceiling", () => {
  it("is refused at or past the bucket's rule for bodies, saying why", async () => {
    bucket = { rules: [expiring(400)] };

    await expect(setSetting("body_retention_max_days", 400, ADMIN)).rejects.toMatchObject({
      code: "validation_failed",
      message: expect.stringContaining("expires bodies after 400 days"),
    });
    await setSetting("body_retention_max_days", 399, ADMIN);
    expect(await readSetting("body_retention_max_days")).toBe(399);
  });

  it("is allowed with a warning when the rule can't be read", async () => {
    bucket = { error: "AccessDenied" };
    await setSetting("body_retention_max_days", 600, ADMIN);
    expect(describeBodyLifecycle(await readBodyLifecycle(), 600)).toEqual({
      text: "Pouch can't read the bucket's lifecycle rule. Make sure it expires bodies after more than 600 days.",
      warning: true,
    });
  });
});

describe("setting the inbound ceiling", () => {
  it("is refused at or past a bucket rule on inbound mail, and allowed with no rule", async () => {
    bucket = { rules: [expiringInbound(60), expiring(400)] };
    await expect(setSetting("inbound_retention_max_days", 60, ADMIN)).rejects.toMatchObject({
      code: "validation_failed",
      message: expect.stringContaining("expires inbound mail after 60 days"),
    });
    await setSetting("inbound_retention_max_days", 59, ADMIN);
    expect(await readSetting("inbound_retention_max_days")).toBe(59);

    bucket = { rules: [expiring(400)] };
    resetBodyLifecycleCache();
    await setSetting("inbound_retention_max_days", 365, ADMIN);
    expect(await readSetting("inbound_retention_max_days")).toBe(365);
  });

  it("counts a bucket-wide rule", async () => {
    bucket = { rules: [{ ID: "all", Status: "Enabled", Filter: { Prefix: "" }, Expiration: { Days: 100 } }] };
    await expect(setSetting("inbound_retention_max_days", 100, ADMIN)).rejects.toMatchObject({ code: "validation_failed" });
  });
});

describe("the inbound-lifecycle health check", () => {
  it("passes with no rule on inbound mail and degrades when one drops to the ceiling", async () => {
    bucket = { rules: [expiring(400)] };
    expect((await readiness()).checks["inbound-lifecycle"]).toMatchObject({ ok: true });

    bucket = { rules: [expiring(400), expiringInbound(30)] };
    resetBodyLifecycleCache();
    expect((await readiness()).checks["inbound-lifecycle"]).toMatchObject({ ok: false });

    bucket = { rules: [expiring(400), expiringInbound(31)] };
    resetBodyLifecycleCache();
    expect((await readiness()).checks["inbound-lifecycle"]).toMatchObject({ ok: true });
  });
});

describe("the status views", () => {
  it("read the inbound rule against the inbound ceiling, and none is fine there", async () => {
    const ceiling = await readSetting("inbound_retention_max_days");
    expect(await readInboundLifecycleView()).toEqual({ ceiling, expiryDays: null, status: "ok" });

    bucket = { rules: [expiring(400), expiringInbound(ceiling)] };
    resetBodyLifecycleCache();
    expect(await readInboundLifecycleView()).toEqual({ ceiling, expiryDays: ceiling, status: "degraded" });
    expect((await readBodyLifecycleView()).status).toBe("ok");

    bucket = { rules: [expiringInbound(ceiling + 1)] };
    resetBodyLifecycleCache();
    expect(await readInboundLifecycleView()).toMatchObject({ expiryDays: ceiling + 1, status: "ok" });
    expect((await readBodyLifecycleView()).status).toBe("degraded");
  });
});

describe("the body-lifecycle health check", () => {
  function memoryStore() {
    let state: Record<string, CheckState> = {};
    return { read: async () => state, write: async (next: Record<string, CheckState>) => void (state = next) };
  }

  it("degrades once when the rule drops to the ceiling after it was set, and reads unknown as passing", async () => {
    const store = memoryStore();
    const pushed: HealthTransition[] = [];
    const watch = async () => {
      const report = await readiness();
      await watchChecks(store, report.checks, async (transition) => void pushed.push(transition));
      return report.checks["body-lifecycle"];
    };

    bucket = { rules: [expiring(400)] };
    expect(await watch()).toMatchObject({ ok: true });

    bucket = { rules: [expiring(365)] };
    resetBodyLifecycleCache();
    expect(await watch()).toMatchObject({ ok: false });
    expect(await watch()).toMatchObject({ ok: false });
    expect(pushed.filter((transition) => transition.check === "body-lifecycle").map((transition) => transition.to)).toEqual(["failing"]);

    bucket = { error: "AccessDenied" };
    resetBodyLifecycleCache();
    expect(await watch()).toMatchObject({ ok: true });
  });

  it("degrades with no rule for bodies", async () => {
    bucket = { error: "NoSuchLifecycleConfiguration" };
    expect((await readiness()).checks["body-lifecycle"]).toMatchObject({ ok: false });
  });
});
