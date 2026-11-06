import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { digestPreferences, domains, lists, listMemberships, users } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { signSubjectToken } from "@/lib/lists/tokens";
import { isDomainUnsubscribed } from "@/lib/lists/unsubscribe";
import { signUnsubscribeToken } from "@/lib/mail/digest/unsubscribe";
import { GET as unsubscribePage, POST as unsubscribePost } from "@/app/u/[token]/route";
import { GET as confirmPage, POST as confirmPost } from "@/app/confirm/[token]/route";
import { GET as digestPage, POST as digestPost } from "@/app/unsubscribe/digest/[token]/route";
import { resetDatabase, seedFixture, type Fixture } from "./fixtures";

const SCRIPT = `<script>fetch("/x")</script>`;
const ESCAPED_SCRIPT = "&lt;script&gt;fetch(&quot;/x&quot;)&lt;/script&gt;";

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture({ domainStatus: "verified" });
});

async function member(listName: string, address = "ada@example.net", status: "pending" | "subscribed" = "subscribed"): Promise<string> {
  const listId = newId("list");
  await db.insert(lists).values({ id: listId, organizationId: fixture.organizationId, domainId: fixture.domainId, name: listName, doubleOptIn: false });
  const id = newId("listMembership");
  await db.insert(listMemberships).values({ id, organizationId: fixture.organizationId, listId, address, status, source: "manual", doubleOptIn: false });
  return id;
}

async function membershipStatus(id: string): Promise<string | undefined> {
  const [row] = await db.select({ status: listMemberships.status }).from(listMemberships).where(eq(listMemberships.id, id));
  return row?.status;
}

type Route = (request: Request, context: { params: Promise<{ token: string }> }) => Promise<Response>;

function get(route: Route, token: string): Promise<Response> {
  return route(new Request(`http://localhost/x/${token}`), { params: Promise.resolve({ token }) });
}

function post(route: Route, token: string, body = ""): Promise<Response> {
  return route(
    new Request(`http://localhost/x/${token}`, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } }),
    { params: Promise.resolve({ token }) },
  );
}

/** The page as a reader sees it: apostrophes and ampersands unescaped. */
async function read(response: Response): Promise<string> {
  return (await response.text()).replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

function expectStrictCsp(response: Response): void {
  const csp = response.headers.get("content-security-policy") ?? "";
  expect(csp).toMatch(/default-src 'none'/);
  expect(csp).not.toMatch(/script-src/);
  expect(csp).toMatch(/frame-ancestors 'none'/);
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
}

describe("hosted pages", () => {
  it("shows a list name as text on the unsubscribe page, under a CSP that runs no script", async () => {
    const token = signSubjectToken(await member(SCRIPT), "unsubscribe");

    const response = await get(unsubscribePage, token);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).not.toContain("<script>");
    expect(body).toContain(ESCAPED_SCRIPT);
    expectStrictCsp(response);
    expect(response.headers.get("content-security-policy")).toContain("form-action 'self'");
  });

  it("escapes what the confirm page echoes back", async () => {
    const token = signSubjectToken(await member("News", `"><img src=x onerror=alert(1)>@example.net`, "pending"), "confirm");

    const response = await get(confirmPage, token);
    const body = await response.text();

    expect(body).not.toContain("<img");
    expectStrictCsp(response);
  });

  it("escapes a domain layout's name and footer, and drops an accent that isn't a hex color", async () => {
    await db
      .update(domains)
      .set({ layout: { brandName: SCRIPT, logoUrl: null, accent: "red;}body{display:none", footer: `</footer>${SCRIPT}` } })
      .where(eq(domains.id, fixture.domainId));
    const token = signSubjectToken(await member("News"), "unsubscribe");

    const body = await (await get(unsubscribePage, token)).text();

    expect(body).not.toContain("<script>");
    expect(body).toContain(ESCAPED_SCRIPT);
    expect(body).not.toContain("display:none");
  });

  it("asks before confirming a subscription, so a link scanner confirms nothing", async () => {
    const id = await member("News", "ada@example.net", "pending");
    const token = signSubjectToken(id, "confirm");

    const asked = await get(confirmPage, token);
    expect(asked.status).toBe(200);
    expect(await asked.text()).toContain("Confirm subscription");
    expect(await membershipStatus(id)).toBe("pending");

    const confirmed = await post(confirmPost, token);
    expect(await read(confirmed)).toContain("You're subscribed");
    expect(await membershipStatus(id)).toBe("subscribed");

    const again = await get(confirmPage, token);
    expect(await read(again)).toContain("You're already subscribed");
    expectStrictCsp(again);
  });

  it("says a forged confirm link isn't valid, with no domain's branding", async () => {
    const response = await get(confirmPage, signSubjectToken("lmb_missing", "confirm"));
    expect(response.status).toBe(404);
    expect(await read(response)).toContain("This link isn't valid");
    expectStrictCsp(response);
  });

  it("asks before unsubscribing, then unsubscribes from the list or the whole domain", async () => {
    const id = await member("News");
    const token = signSubjectToken(id, "unsubscribe");

    await get(unsubscribePage, token);
    expect(await membershipStatus(id)).toBe("subscribed");

    const listDone = await post(unsubscribePost, token, "scope=list");
    expect(await read(listDone)).toContain("You're unsubscribed");
    expect(await membershipStatus(id)).toBe("unsubscribed");
    expect(await isDomainUnsubscribed(fixture.domainId, "ada@example.net")).toBe(false);

    const domainDone = await post(unsubscribePost, token, "scope=domain");
    expect(await read(domainDone)).toContain("You won't get bulk mail from");
    expect(await isDomainUnsubscribed(fixture.domainId, "ada@example.net")).toBe(true);
  });

  it("answers a mail client's one-click POST with no body", async () => {
    const id = await member("News");
    const response = await post(unsubscribePost, signSubjectToken(id, "unsubscribe"), "List-Unsubscribe=One-Click");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(await membershipStatus(id)).toBe("unsubscribed");
  });

  it("asks before turning a digest off, and one-click turns it off with no page", async () => {
    const userId = crypto.randomUUID();
    await db.insert(users).values({ id: userId, organizationId: fixture.organizationId, name: "Ada", email: "ada@example.com", admin: true });
    const token = signUnsubscribeToken(userId, "weekly");

    const asked = await get(digestPage, token);
    expect(await asked.text()).toContain("Turn off the weekly digest?");
    expect(await db.select().from(digestPreferences).where(eq(digestPreferences.userId, userId))).toHaveLength(0);
    expectStrictCsp(asked);

    const done = await post(digestPost, token);
    expect(await read(done)).toContain("The weekly digest is off");
    expect((await get(digestPage, token)).status).toBe(200);
    expect(await read(await get(digestPage, token))).toContain("already off");

    const oneClick = await post(digestPost, token, "List-Unsubscribe=One-Click");
    expect(oneClick.status).toBe(200);
    expect(await oneClick.text()).toBe("");
  });
});
