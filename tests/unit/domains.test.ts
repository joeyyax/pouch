import { describe, expect, it } from "vitest";
import { assertCan } from "@/lib/domains";
import { ApiError } from "@/lib/api/errors";
import { capabilitiesOf } from "@/lib/providers/adapters";
import type { AdapterCapabilities } from "@/lib/providers/adapters/types";

function capabilities(overrides: Partial<AdapterCapabilities> = {}): AdapterCapabilities {
  return { ...capabilitiesOf("mock"), ...overrides };
}

const context = { webhookUrl: "https://mail.example.com/api/webhooks/mock/pac_1" };

describe("assertCan", () => {
  it("passes a capability the adapter declares", () => {
    expect(() => assertCan(capabilities(), "domainsViaApi", "add a domain", context)).not.toThrow();
  });

  it("turns a capability the adapter lacks into a 422 naming what's missing", () => {
    try {
      assertCan(capabilities({ domainsViaApi: false }), "domainsViaApi", "add a domain", context);
      throw new Error("expected assertCan to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      const api = error as ApiError;
      expect(api.code).toBe("capability_unavailable");
      expect(api.status).toBe(422);
      expect(api.message).toContain("add a domain");
      expect(api.detail).toEqual({
        setup: [{ step: "domain", message: "Add this domain in the provider's dashboard." }],
      });
    }
  });

  it("carries the webhook step's URL, so the caller can act on it", () => {
    try {
      assertCan(capabilities({ webhooksViaApi: false }), "webhooksViaApi", "register a webhook", context);
      throw new Error("expected assertCan to throw");
    } catch (error) {
      const detail = (error as ApiError).detail as { setup: { step: string; message: string }[] };
      expect(detail.setup[0]?.step).toBe("webhooks");
      expect(detail.setup[0]?.message).toContain(context.webhookUrl);
    }
  });
});
