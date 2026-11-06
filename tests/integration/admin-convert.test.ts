import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const { control } = vi.hoisted(() => ({
  control: {
    runs: 0,
    release: null as null | ((outcome: Error | null) => void),
  },
}));

// The provider side of a conversion is covered in ses-convert.test.ts; this file covers the job around it.
vi.mock("@/lib/providers/convert", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/providers/convert")>();
  const plan = (providerId: string, converted = false) => ({
    providerId,
    organizationId: "org_x",
    tenantName: "org_x",
    parentId: null,
    parentName: "Hosted",
    resources: { configurationSetName: "set", identities: ["example.com"] },
    permissions: ["ses:CreateTenant"],
    stages: actual.CONVERSION_STAGES.map((stage) => ({ stage, done: converted, calls: [] })),
    converted,
  });
  return {
    ...actual,
    planConversion: vi.fn(async (providerId: string) => plan(providerId)),
    convertToTenant: vi.fn(async (providerId: string, options: { log?: (line: string) => void }) => {
      control.runs += 1;
      options.log?.("parent: done");
      const outcome = await new Promise<Error | null>((resolve) => {
        control.release = resolve;
      });
      if (outcome) throw outcome;
      return { plan: plan(providerId, true), reached: "flip", converted: true, suppressionsCopied: 0 };
    }),
  };
});

import { db } from "@/lib/db";
import { providers } from "@/lib/db/schema";
import { encryptCredentials } from "@/lib/providers";
import { ConversionStoppedError } from "@/lib/providers/convert";
import { newId } from "@/lib/ids";
import { MCP_TOOLS } from "@/lib/mcp/registry";
import { callRoute, seedAdmin, SES_CREDENTIALS, type AdminFixture } from "./admin-fixtures";
import { resetDatabase, seedFixture } from "./fixtures";

const start = MCP_TOOLS.find((tool) => tool.name === "convert_admin_provider")!;
const read = MCP_TOOLS.find((tool) => tool.name === "read_admin_conversion")!;
const readProvider = MCP_TOOLS.find((tool) => tool.name === "read_admin_provider")!;

let admin: AdminFixture;
let legacy: string;

// Response bodies are asserted on loosely.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(tool: typeof start, id: string): Promise<{ status: number; body: any }> {
  const response = await callRoute(tool, admin.secret, { id });
  return { status: response.status, body: await response.json() };
}

async function settle(outcome: Error | null): Promise<void> {
  await vi.waitFor(() => expect(control.release).not.toBeNull());
  control.release!(outcome);
  control.release = null;
  await vi.waitFor(async () => {
    const { body } = await call(read, legacy);
    expect(body.conversion.state).not.toBe("running");
  });
}

beforeEach(async () => {
  await resetDatabase();
  control.runs = 0;
  control.release = null;
  admin = await seedAdmin();
  const org = await seedFixture();
  legacy = newId("provider");
  await db.insert(providers).values({
    id: legacy,
    organizationId: org.organizationId,
    adapter: "ses",
    name: "legacy",
    credentials: encryptCredentials(SES_CREDENTIALS),
  });
});

describe("POST /v1/admin/providers/:id/convert", () => {
  it("answers 202 while the run continues, and refuses to start a second one", async () => {
    const first = await call(start, legacy);
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({ id: legacy, started: true, conversion: { state: "running", interrupted: false } });
    expect(first.body.plan).toMatchObject({ provider_id: legacy, converted: false });

    const provider = await call(readProvider, legacy);
    expect(provider.body.status).toBe("converting");
    expect(provider.body.settings).not.toHaveProperty("conversionJob");

    const second = await call(start, legacy);
    expect(second.body.started).toBe(false);

    await settle(null);
    expect(control.runs).toBe(1);
    const { body } = await call(read, legacy);
    expect(body.conversion).toMatchObject({ state: "done", reached: "flip", error: null });
    expect(body.conversion.finished_at).not.toBeNull();
  });

  it("records where a failed run stopped, and starts again from there", async () => {
    await call(start, legacy);
    await settle(new ConversionStoppedError("tag", "associate", new Error("AccessDenied")));

    const { body } = await call(read, legacy);
    expect(body.conversion).toMatchObject({ state: "failed", stopped_at: "tag", reached: "associate" });
    expect(body.conversion.error).toContain("AccessDenied");
    expect((await call(readProvider, legacy)).body.status).toBe("needs_conversion");

    const again = await call(start, legacy);
    expect(again.body.started).toBe(true);
    await settle(null);
    expect(control.runs).toBe(2);
  });

  it("takes over a run whose heartbeat stopped", async () => {
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const job = { state: "running", started_at: stale, heartbeat_at: stale, finished_at: null, reached: "parent", stopped_at: null, error: null };
    await db.update(providers).set({ settings: { conversionJob: JSON.stringify(job) } }).where(eq(providers.id, legacy));

    const before = await call(read, legacy);
    expect(before.body.conversion).toMatchObject({ state: "running", interrupted: true });
    expect((await call(readProvider, legacy)).body.status).toBe("needs_conversion");

    const taken = await call(start, legacy);
    expect(taken.body.started).toBe(true);
    await settle(null);
  });

  it("answers 404 for an id that isn't a provider", async () => {
    const { status } = await call(start, "pac_missing");
    expect(status).toBe(404);
    expect(control.runs).toBe(0);
  });
});
