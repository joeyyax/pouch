import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { jobHeartbeats } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { IntervalLoop } from "@/lib/worker/interval-loop";
import { readLoopLiveness } from "@/lib/system/read";

class TestLoop extends IntervalLoop<void> {
  protected readonly name = "retention";
  protected readonly log = logger.child("test");
  protected readonly intervalMs = 60_000;
  protected readonly workerId = "worker-test";

  outcome: "ok" | "throws" | "hangs" = "ok";

  protected async run(): Promise<void> {
    if (this.outcome === "throws") throw new Error("every tick throws");
    if (this.outcome === "hangs") await new Promise<void>(() => {});
  }
}

const row = async () => (await db.select().from(jobHeartbeats).where(eq(jobHeartbeats.name, "retention")))[0];
const status = async () => (await readLoopLiveness()).find((loop) => loop.loop === "retention")?.status;

async function runOnce(loop: TestLoop): Promise<void> {
  const before = (await row())?.lastFinishedAt?.getTime();
  loop.start();
  await vi.waitFor(async () => expect((await row())?.lastFinishedAt?.getTime()).not.toBe(before), { timeout: 5_000 });
  await loop.stop();
}

beforeEach(async () => {
  await db.delete(jobHeartbeats);
});

describe("IntervalLoop heartbeats", () => {
  it("records a start and a finish for a run, and reads ok", async () => {
    await runOnce(new TestLoop());

    const recorded = await row();
    expect(recorded?.lastStartedAt).not.toBeNull();
    expect(recorded?.lastFinishedAt).not.toBeNull();
    expect(recorded?.lastError).toBeNull();
    expect(recorded?.workerId).toBe("worker-test");
    expect(await status()).toBe("ok");
  });

  it("reads failing, not ok, when every run throws, and ok again once one lands", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const loop = new TestLoop();
    loop.outcome = "throws";
    await runOnce(loop);

    expect(await status()).toBe("failing");
    expect((await row())?.consecutiveFailures).toBe(1);

    const recovering = new TestLoop();
    await runOnce(recovering);

    expect(await status()).toBe("ok");
    expect((await row())?.consecutiveFailures).toBe(0);
  });

  it("records the start of a run that never finishes, with no finish", async () => {
    const loop = new TestLoop();
    loop.outcome = "hangs";
    loop.start();
    await vi.waitFor(async () => expect((await row())?.lastStartedAt).toBeTruthy(), { timeout: 5_000 });

    expect((await row())?.lastFinishedAt).toBeNull();
  });
});
