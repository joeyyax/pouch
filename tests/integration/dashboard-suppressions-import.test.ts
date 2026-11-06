import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { activity, suppressions } from "@/lib/db/schema";
import { suppress } from "@/lib/messages/suppression";
import { addDomainKey, addSuppression, resetDatabase, seedFixture, seedMessage, type Fixture } from "./fixtures";

const sessionState = vi.hoisted(() => ({ organizationId: "" }));

vi.mock("@/lib/dashboard/session", async (importOriginal) =>
  (await import("./fixtures")).dashboardSessionModule(await importOriginal<typeof import("@/lib/dashboard/session")>(), sessionState),
);

const { POST } = await import("@/app/api/dashboard/suppressions/import/route");
const { GET } = await import("@/app/api/dashboard/suppressions/export/route");

function upload(csv: string, query = "?reason=hard_bounce", headers: Record<string, string> = { "sec-fetch-site": "same-origin" }) {
  return POST(
    new Request(`http://localhost:3100/api/dashboard/suppressions/import${query}`, {
      method: "POST",
      headers: { "content-type": "text/csv", ...headers },
      body: csv,
    }),
  );
}

async function exported(query = ""): Promise<string> {
  const response = await GET(new Request(`http://localhost:3100/api/dashboard/suppressions/export${query}`));
  expect(response.headers.get("content-type")).toContain("text/csv");
  return response.text();
}

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture();
  sessionState.organizationId = fixture.organizationId;
});

describe("dashboard suppression import", () => {
  it("summarizes added, already present and invalid rows", async () => {
    await addSuppression(fixture.organizationId, "old@example.com");
    const csv = "email,reason\nada@example.com,\nold@example.com,complaint\n\nnope,\n,complaint\n";

    const response = await upload(csv, "?reason=hard_bounce&source=SendGrid");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      added: 1,
      already_present: 1,
      invalid: 2,
      errors: [
        { line: 5, address: "nope", message: '"nope" isn\'t a valid address.' },
        { line: 6, address: "", message: "Address is required." },
      ],
    });
    const [ada] = await db.select().from(suppressions).where(eq(suppressions.address, "ada@example.com"));
    expect(ada).toMatchObject({ reason: "hard_bounce", source: "SendGrid" });
  });

  it("takes more rows than one API call, in one activity row", async () => {
    const csv = ["address", ...Array.from({ length: 12_000 }, (_, i) => `user${i}@example.com`)].join("\n");
    const body = await (await upload(csv)).json();

    expect(body).toMatchObject({ added: 12_000, invalid: 0 });
    const rows = await db.select().from(activity).where(eq(activity.action, "suppression.imported"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorType: "user", metadata: { added: 12_000, source: "CSV import" } });
  });

  it("refuses a request from another site", async () => {
    const crossSite = await upload("address\nada@example.com\n", "?reason=manual", { "sec-fetch-site": "cross-site" });
    expect(crossSite.status).toBe(401);

    const foreignOrigin = await upload("address\nada@example.com\n", "?reason=manual", { origin: "https://evil.example" });
    expect(foreignOrigin.status).toBe(401);

    expect(await db.select().from(suppressions)).toHaveLength(0);
  });

  it("refuses an unknown reason", async () => {
    const response = await upload("address\nada@example.com\n", "?reason=bounce");
    expect(response.status).toBe(422);
  });

  it("writes only to the session's organization", async () => {
    const other = await seedFixture();
    await upload("address\nada@example.com\n");

    expect(await db.select().from(suppressions).where(eq(suppressions.organizationId, other.organizationId))).toHaveLength(0);
    expect(await db.select().from(suppressions).where(eq(suppressions.organizationId, fixture.organizationId))).toHaveLength(1);
  });
});

describe("dashboard suppression export", () => {
  it("exports only the session's organization, and the file imports back unchanged", async () => {
    const other = await seedFixture();
    await addSuppression(other.organizationId, "theirs@example.com");
    await upload('address,reason,detail\nada@example.com,complaint,"Marked as spam, twice"\nbob@example.com,,\n', "?reason=manual&source=postmark");

    const csv = await exported();
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe("address,reason,detail,source,created_at");
    expect(lines.slice(1).map((line) => line.split(",").slice(0, 2).join(",")).sort()).toEqual(["ada@example.com,complaint", "bob@example.com,manual"]);
    expect(csv).toContain('"Marked as spam, twice",postmark,');
    expect(csv).not.toContain("theirs@example.com");

    sessionState.organizationId = other.organizationId;
    await db.delete(suppressions).where(eq(suppressions.organizationId, other.organizationId));
    const body = await (await upload(csv, "?reason=hard_bounce")).json();
    expect(body).toMatchObject({ added: 2, invalid: 0 });
    const copied = await db.select().from(suppressions).where(eq(suppressions.organizationId, other.organizationId));
    expect(copied.map((r) => [r.address, r.reason, r.detail, r.source]).sort()).toEqual([
      ["ada@example.com", "complaint", "Marked as spam, twice", "postmark"],
      ["bob@example.com", "manual", null, "postmark"],
    ]);
  });

  it("narrows to the screen's search and pages past one batch", async () => {
    const csv = ["address", ...Array.from({ length: 2_500 }, (_, i) => `user${i}@example.com`), "zed@example.net"].join("\n");
    await upload(csv);

    const all = (await exported()).trim().split("\r\n");
    expect(all).toHaveLength(2_502);
    expect(new Set(all).size).toBe(2_502);

    const narrowed = (await exported("?address=example.net")).trim().split("\r\n");
    expect(narrowed).toHaveLength(2);
    expect(narrowed[1]).toMatch(/^zed@example\.net,hard_bounce,/);
  });

  it("narrows to the screen's reason, domain and dates, not only its search", async () => {
    const second = await addDomainKey(fixture, "second.example.com");
    const onSecond = await seedMessage({ ...fixture, domainId: second.domainId }, { to: "b@example.net", status: "complained" });
    await suppress({ organizationId: fixture.organizationId, address: "b@example.net", reason: "complaint", sourceMessageId: onSecond });
    await upload("address\na@example.net\n", "?reason=manual");
    await db.update(suppressions).set({ createdAt: new Date("2026-03-04T12:00:00Z") }).where(eq(suppressions.address, "a@example.net"));

    const addresses = async (query: string) =>
      (await exported(query)).trim().split("\r\n").slice(1).map((line) => line.split(",")[0]);

    expect(await addresses("?reason=complaint")).toEqual(["b@example.net"]);
    expect(await addresses("?domain=second.example.com")).toEqual(["b@example.net"]);
    expect(await addresses("?domain=nowhere.example")).toEqual([]);
    expect(await addresses("?from=2026-03-04&to=2026-03-04")).toEqual(["a@example.net"]);
    expect(await addresses("?address=a_")).toEqual([]);
  });

  it("guards formula cells and reads them back unchanged", async () => {
    await upload(
      'address,reason,detail\n-ada@example.com,complaint,"=HYPERLINK(""http://x.example"",""y"")"\n+grace@example.com,,@risk\n',
      "?reason=manual",
    );

    const csv = await exported();
    expect(csv).toContain("'-ada@example.com,");
    expect(csv).toContain("'+grace@example.com,");
    expect(csv).toContain(`"'=HYPERLINK(""http://x.example"",""y"")"`);
    expect(csv).toContain(",'@risk,");

    const other = await seedFixture();
    sessionState.organizationId = other.organizationId;
    expect(await (await upload(csv)).json()).toMatchObject({ added: 2, invalid: 0 });
    const copied = await db.select().from(suppressions).where(eq(suppressions.organizationId, other.organizationId));
    expect(copied.map((r) => [r.address, r.detail]).sort()).toEqual([
      ["+grace@example.com", "@risk"],
      ["-ada@example.com", '=HYPERLINK("http://x.example","y")'],
    ]);
  });
});
