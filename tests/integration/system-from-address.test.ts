import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { createElement } from "react";
import { db } from "@/lib/db";
import { domains, messages, users } from "@/lib/db/schema";
import { readSystemMail } from "@/lib/dashboard/admin-general";
import { sendSystemAlert, SystemMailNotConfiguredError, resolveSystemSender, systemMailReady } from "@/lib/mail/system";
import { SystemMail } from "@/lib/mail/template";
import { readServiceSettings, setSystemFromAddress } from "@/lib/settings/service";
import { setSystemFromAddressAction } from "@/app/(app)/admin/settings/general/actions";
import { idle } from "@/lib/dashboard/action-state";
import { addDomainKey, resetDatabase, seedFixture, type Fixture } from "./fixtures";

const alertEmail = (reason: string) => createElement(SystemMail, { heading: "Heading", paragraphs: ["Body."], reason });

const sessionState = vi.hoisted(() => ({ userId: null as string | null }));

vi.mock("@/lib/auth/session", async () => (await import("./fixtures")).adminSessionModule(sessionState));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture();
  // The setting starts parked in every fixture; these tests are about resolving it for real.
  await setSystemFromAddress(null);

  sessionState.userId = crypto.randomUUID();
  await db.insert(users).values({
    id: sessionState.userId,
    organizationId: fixture.organizationId,
    name: "Operator",
    email: `${sessionState.userId}@example.com`,
    admin: true,
  });
});

/** The service's own mail sent from a domain the organization holds. */
async function systemMailFrom(organizationId: string) {
  return db
    .select({ message: messages })
    .from(messages)
    .innerJoin(domains, eq(domains.id, messages.domainId))
    .where(and(isNull(messages.organizationId), eq(domains.organizationId, organizationId)))
    .then((rows) => rows.map((row) => row.message));
}

describe("the system from address", () => {
  it("defaults to support@ on the first verified domain when nothing is set", async () => {
    await addDomainKey(fixture, "second.example.com");

    const sender = await resolveSystemSender();

    expect(sender.domainId).toBe(fixture.domainId);
    expect(sender.organizationId).toBe(fixture.organizationId);
    expect(sender.fromAddress).toBe("support@example.com");
  });

  it("skips a domain that isn't verified when it falls back", async () => {
    const second = await addDomainKey(fixture, "second.example.com");
    await db.update(domains).set({ status: "pending", verifiedAt: null }).where(eq(domains.id, fixture.domainId));

    expect((await resolveSystemSender()).domainId).toBe(second.domainId);
  });

  it("keeps the local part an operator sets", async () => {
    await setSystemFromAddress("hello@example.com");

    const sender = await resolveSystemSender();

    expect(sender.fromAddress).toBe("hello@example.com");
    expect(sender.domainId).toBe(fixture.domainId);
  });

  it("sends from the address it holds, in an ordinary organization", async () => {
    const second = await addDomainKey(fixture, "second.example.com");
    await setSystemFromAddress("alerts@second.example.com");

    await sendSystemAlert({ subject: "Named", email: alertEmail, idempotencyKey: "k-named" });

    const rows = (await systemMailFrom(fixture.organizationId)).filter((row) => row.subject === "Named");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fromAddress).toBe("alerts@second.example.com");
    expect(rows[0]!.domainId).toBe(second.domainId);
  });

  it("needs no API key in the organization it sends from", async () => {
    const other = await seedFixture();
    await db.update(domains).set({ name: "other.example.com" }).where(eq(domains.id, other.domainId));
    await setSystemFromAddress("support@other.example.com");

    await sendSystemAlert({ subject: "Keyless", email: alertEmail, idempotencyKey: "k-keyless" });

    const rows = await systemMailFrom(other.organizationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.apiKeyId).toBeNull();
  });

  it.each([
    [
      "no domain is verified",
      async () => {
        await db.update(domains).set({ status: "pending", verifiedAt: null });
      },
      /system from address/,
    ],
    [
      "no organization holds the domain",
      async () => {
        await setSystemFromAddress("support@gone.example");
      },
      /No organization holds the domain gone.example/,
    ],
    [
      "the domain isn't verified",
      async () => {
        await setSystemFromAddress("support@example.com");
        await db.update(domains).set({ status: "failed", verifiedAt: null }).where(eq(domains.id, fixture.domainId));
      },
      /example.com isn't verified/,
    ],
  ])("isn't ready, and says why, when %s", async (_name, arrange, message) => {
    await arrange();

    expect(await systemMailReady()).toBe(false);
    await expect(resolveSystemSender()).rejects.toThrow(SystemMailNotConfiguredError);
    await expect(resolveSystemSender()).rejects.toThrow(message);
  });

  it("resolves the verified row when two organizations hold the same name", async () => {
    const other = await seedFixture();
    await db.update(domains).set({ status: "pending", verifiedAt: null }).where(eq(domains.id, fixture.domainId));
    await db.update(domains).set({ name: "example.com" }).where(eq(domains.id, other.domainId));
    await setSystemFromAddress("support@example.com");

    expect((await resolveSystemSender()).organizationId).toBe(other.organizationId);
  });

  it("clears back to the default", async () => {
    await addDomainKey(fixture, "second.example.com");
    await setSystemFromAddress("support@second.example.com");
    await setSystemFromAddress(null);

    expect((await resolveSystemSender()).domainId).toBe(fixture.domainId);
  });
});

describe("the admin system mail screen", () => {
  function form(localPart: string, domain: string): FormData {
    const data = new FormData();
    data.set("localPart", localPart);
    data.set("domain", domain);
    return data;
  }

  it("saves a local part on a verified domain and reports where it lands", async () => {
    const state = await setSystemFromAddressAction(idle, form("Support", "example.com"));

    expect(state).toMatchObject({ status: "ok" });
    expect((state as { message: string }).message).toContain("Support@example.com");
    expect((await readServiceSettings()).systemFromAddress).toBe("Support@example.com");
  });

  it("refuses a domain that isn't verified, and stores nothing", async () => {
    await db.update(domains).set({ status: "pending", verifiedAt: null }).where(eq(domains.id, fixture.domainId));

    const state = await setSystemFromAddressAction(idle, form("support", "example.com"));

    expect(state).toMatchObject({ status: "error" });
    expect((state as { message: string }).message).toMatch(/isn't verified/);
    expect((await readServiceSettings()).systemFromAddress).toBeNull();
  });

  it("refuses a domain with no local part", async () => {
    expect(await setSystemFromAddressAction(idle, form("", "example.com"))).toMatchObject({ status: "error", field: "localPart" });
    expect((await readServiceSettings()).systemFromAddress).toBeNull();
  });

  it("refuses a local part with no domain", async () => {
    expect(await setSystemFromAddressAction(idle, form("support", ""))).toMatchObject({ status: "error", field: "domain" });
  });

  it("clears back to the default when both halves are blank", async () => {
    await setSystemFromAddress("alerts@example.com");

    expect(await setSystemFromAddressAction(idle, form("", ""))).toMatchObject({ status: "ok" });
    expect((await readServiceSettings()).systemFromAddress).toBeNull();
  });

  it("offers the verified domains and splits the stored address across the two controls", async () => {
    await addDomainKey(fixture, "second.example.com");
    await setSystemFromAddress("alerts@second.example.com");

    const view = await readSystemMail();

    expect(view.address).toBe("alerts@second.example.com");
    expect(view.localPart).toBe("alerts");
    expect(view.domain).toBe("second.example.com");
    expect(view.verifiedDomains).toEqual(["example.com", "second.example.com"]);
    expect(view.problem).toBeNull();
    expect(view.resolved).toMatchObject({ address: "alerts@second.example.com", domainName: "second.example.com", organizationName: "Test" });
  });

  it("offers no domain, and says why, when none is verified", async () => {
    await db.update(domains).set({ status: "pending", verifiedAt: null });

    const view = await readSystemMail();

    expect(view.verifiedDomains).toEqual([]);
    expect(view.resolved).toBeNull();
    expect(view.problem).toMatch(/system from address/);
  });

  it("reports the problem when the address dangles", async () => {
    await setSystemFromAddress("support@gone.example");

    const view = await readSystemMail();

    expect(view.resolved).toBeNull();
    expect(view.problem).toMatch(/system from address/);
  });
});
