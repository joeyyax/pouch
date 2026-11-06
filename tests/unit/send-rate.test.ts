import { describe, expect, it } from "vitest";
import { sendRateSubject } from "@/lib/providers/send-rate";

describe("sendRateSubject", () => {
  it("puts a shared provider, its tenant and an ordinary row on one AWS account in one bucket", () => {
    const parent = sendRateSubject({ id: "pac_parent", adapter: "ses", providerIdentity: "210987654321", sharedProviderId: null });
    const tenant = sendRateSubject({ id: "pac_tenant", adapter: "ses", providerIdentity: "210987654321", sharedProviderId: "pac_parent" });
    const legacy = sendRateSubject({ id: "pac_legacy", adapter: "ses", providerIdentity: "210987654321", sharedProviderId: null });

    expect(parent).toBe("ses:210987654321");
    expect(tenant).toBe(parent);
    expect(legacy).toBe(parent);
  });

  it("falls back to the shared provider for a tenant, and the row otherwise, until the identity is known", () => {
    expect(sendRateSubject({ id: "pac_tenant", adapter: "ses", providerIdentity: null, sharedProviderId: "pac_parent" })).toBe("pac_parent");
    expect(sendRateSubject({ id: "pac_parent", adapter: "ses", providerIdentity: null, sharedProviderId: null })).toBe("pac_parent");
  });
});
