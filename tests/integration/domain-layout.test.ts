import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { domains, messages } from "@/lib/db/schema";
import type { DomainLayout, LayoutOverrides } from "@/lib/domains/layout";
import { acceptMessage } from "@/lib/messages/create";
import { claimMessages, dueProviders } from "@/lib/messages/queue";
import { mockSends, resetMockSends } from "@/lib/providers/adapters/mock";
import { deliver } from "@/worker/send";
import { addDomainKey, resetDatabase, seedFixture, type Fixture } from "./fixtures";

const layout: DomainLayout = {
  brandName: "Scope",
  logoUrl: "https://scope.example/mark.png",
  accent: "#1d46f5",
  footer: "Scope · Portland, OR",
};

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  resetMockSends();
  fixture = await seedFixture();
});

async function setLayout(domainId: string, value: DomainLayout | null) {
  await db.update(domains).set({ layout: value }).where(eq(domains.id, domainId));
}

function send(overrides: { layout?: boolean | LayoutOverrides; html?: string; text?: string } = {}) {
  return acceptMessage(
    fixture.key,
    {
      from: "Ada <ada@example.com>",
      to: ["sam@example.com"],
      subject: "Your invite",
      html: overrides.html ?? "<p>Your invite is ready.</p>",
      ...(overrides.text === undefined ? {} : { text: overrides.text }),
      ...(overrides.layout === undefined ? {} : { layout: overrides.layout }),
    },
    null,
  );
}

async function deliverAll(): Promise<void> {
  for (const provider of await dueProviders()) {
    for (const claimed of await claimMessages({ workerId: "worker-test", providerId: provider.id, limit: 10 })) {
      await deliver(claimed);
    }
  }
}

describe("accepting a layout send", () => {
  it.each([
    { what: "layout: true", value: true },
    { what: "an override object", value: { footer: "Acme · Portland, OR" } },
  ])("refuses $what on a domain with no frame", async ({ value }) => {
    await expect(send({ layout: value })).rejects.toMatchObject({
      code: "validation_failed",
      field: "layout",
    });
  });

  it("stores the flag with no overrides for a plain layout: true, and defaults to off", async () => {
    await setLayout(fixture.domainId, layout);
    const { message } = await send({ layout: true });

    const [row] = await db.select().from(messages).where(eq(messages.id, message.id)).limit(1);
    expect(row?.layout).toBe(true);
    expect(row?.layoutOverrides).toBeNull();

    expect((await send()).message.layout).toBe(false);
  });

  it("stores the overrides on the message, alongside the flag", async () => {
    await setLayout(fixture.domainId, layout);
    const { message } = await send({ layout: { name: "Acme", footer: "Acme · Portland, OR" } });

    const [row] = await db.select().from(messages).where(eq(messages.id, message.id)).limit(1);
    expect(row?.layout).toBe(true);
    expect(row?.layoutOverrides).toEqual({ name: "Acme", footer: "Acme · Portland, OR" });
  });
});

describe("sending a layout message", () => {
  it("wraps the html in the domain's frame", async () => {
    await setLayout(fixture.domainId, layout);
    await send({ layout: true });
    await deliverAll();

    const sent = mockSends().at(-1);
    expect(sent?.message.html).toContain("<p>Your invite is ready.</p>");
    expect(sent?.message.html).toContain("https://scope.example/mark.png");
    expect(sent?.message.html).toContain("Scope · Portland, OR");
  });

  it("leaves the text part alone", async () => {
    await setLayout(fixture.domainId, layout);
    await send({ layout: true, text: "Your invite is ready." });
    await deliverAll();

    expect(mockSends().at(-1)?.message.text).toBe("Your invite is ready.");
  });

  it("sends unframed when the send didn't ask", async () => {
    await setLayout(fixture.domainId, layout);
    await send();
    await deliverAll();

    expect(mockSends().at(-1)?.message.html).toBe("<p>Your invite is ready.</p>");
  });

  it("frames each message with its own domain's layout", async () => {
    const second = await addDomainKey(fixture, "second.example.com");
    await setLayout(fixture.domainId, layout);
    await setLayout(second.domainId, { brandName: "Second", logoUrl: null, accent: "#c2410c", footer: "Second" });

    await send({ layout: true });
    await acceptMessage(
      second.key,
      {
        from: "hi@second.example.com",
        to: ["sam@example.com"],
        subject: "Other",
        html: "<p>Other body.</p>",
        layout: true,
      },
      null,
    );
    await deliverAll();

    const bySubject = new Map(mockSends().map((sent) => [sent.message.subject, sent.message.html]));
    expect(bySubject.get("Your invite")).toContain("Scope · Portland, OR");
    expect(bySubject.get("Other")).toContain("Second");
    expect(bySubject.get("Other")).not.toContain("Scope · Portland, OR");
  });

  it("changes nothing about the frame after a domain drops its layout", async () => {
    await setLayout(fixture.domainId, layout);
    await send({ layout: true });
    // The frame is read at send time, not at accept time.
    await setLayout(fixture.domainId, null);
    await deliverAll();

    expect(mockSends().at(-1)?.message.html).toBe("<p>Your invite is ready.</p>");
  });

  it("falls back to the domain name for the logo's alt text on a legacy row too", async () => {
    const legacy = { logoUrl: "https://scope.example/mark.png", accent: "#1d46f5", footer: "x" } as DomainLayout;
    await setLayout(fixture.domainId, legacy);
    await send({ layout: true });
    await deliverAll();

    expect(mockSends().at(-1)?.message.html ?? "").toContain('alt="example.com"');
  });
});
