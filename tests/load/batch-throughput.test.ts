/** How long one batch request takes to accept. Not part of `pnpm test`: run `pnpm test:load`. LOAD_BATCH sets its size. */
import { appendFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { apiKeyActor } from "@/lib/activity/record";
import { createBatch } from "@/lib/bulk/create";
import { setBulkAllowed } from "@/lib/domains";
import { resetDatabase, seedFixture } from "../integration/fixtures";

const SIZE = Number(process.env.LOAD_BATCH ?? 2000);

describe("batch throughput", () => {
  it(`accepts a batch of ${SIZE}`, async () => {
    await resetDatabase();
    const fixture = await seedFixture({ scopeToDomain: false });
    await setBulkAllowed({ organizationId: fixture.organizationId, domainIds: [fixture.domainId], actor: apiKeyActor(fixture.key.id, fixture.key.name) }, fixture.domainId, true);

    const start = performance.now();
    const batch = await createBatch(
      { organizationId: fixture.organizationId, domainIds: [fixture.domainId], apiKeyId: fixture.key.id, mode: "live" },
      {
        from: "Ada <ada@example.com>",
        subject: "Notice for {{name}}",
        html: "<p>Hi {{name}}.</p>",
        recipients: Array.from({ length: SIZE }, (_, i) => ({ address: `person${i}@example.net`, attributes: { name: `Person ${i}` } })),
      },
    );
    const ms = performance.now() - start;

    appendFileSync(
      process.env.LOAD_REPORT ?? "/dev/stderr",
      `batch ${SIZE}: accepted in ${(ms / 1000).toFixed(1)}s, ${(SIZE / (ms / 1000)).toFixed(0)} recipients/s\n\n`,
    );
    expect(batch.counts.queued).toBe(SIZE);
  });
});
