import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  Adapter,
  AdapterCapabilities,
  AdapterFactory,
  AdapterHealth,
  AdapterModule,
  NormalizedEvent,
  OutboundMessage,
  ProviderSettings,
  Receipt,
} from "./types";

/** Permissive by design: a test double shouldn't be the thing that rejects a request. */
const capabilities: AdapterCapabilities = {
  customHeaders: true,
  maxAttachmentBytes: 20 * 1024 * 1024,
  maxRecipients: 50,
  bulk: true,
  domainsViaApi: true,
  dnsRecordsViaApi: true,
  webhooksViaApi: true,
  removalViaApi: true,
  adoptionViaApi: false,
  credentialsWithoutConsole: true,
  // Nothing implements Adapter.inbound yet, and the flag has to match.
  sharing: false,
  subdomainSending: true,
};

/** The mock takes whatever it's given, so fixtures can reuse another adapter's credentials. */
const credentialsSchema = z.looseObject({});

/** Reads settings and nothing else, so the registry can answer it without credentials. */
function isConfigured(current: ProviderSettings): boolean {
  return current.mockConfigured === "true";
}

const settingsSchema = z.object({
  mockConfigured: z.string().optional().describe("Set once the mock's own event setup has run."),
  mockTopic: z.string().optional().describe("Domain the mock's event setup was built for."),
  /**
   * Set by the worker when it builds a mock instance for a test-mode message. A test-mode key
   * accepts every valid request, so this instance never simulates the accept-time provider
   * failures below — bounce/defer/slow are resolved later, asynchronously, by the worker's
   * test-mode loop.
   */
  testModeDelivery: z.string().optional().describe("Set when this instance is standing in for test mode."),
});

export interface MockSend {
  message: OutboundMessage;
  receipt: Receipt;
}

const sent: MockSend[] = [];

/** Every send the mock provider has accepted this process. */
export function mockSends(): readonly MockSend[] {
  return sent;
}

/** Domains whose first setup attempt has already failed. */
const setupFailures = new Set<string>();

/** Domains this adapter was asked to remove, readable by a test. */
export const removed = new Set<string>();

export function resetMockSends(): void {
  sent.length = 0;
  setupFailures.clear();
}

/**
 * Test mode. Records the message, delivers nothing.
 * A recipient whose local part is `bounce` fails; `defer` asks for a retry; `slow` asks for account backoff.
 */
const create: AdapterFactory = (_credentials, settings): Adapter => ({
  adapter: "mock",
  capabilities,

  async send(message: OutboundMessage): Promise<Receipt> {
    // The load harness stands in for a real provider's round trip.
    const latencyMs = Number(process.env.MOCK_SEND_LATENCY_MS ?? 0);
    if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));
    // A test-mode key accepts every valid request and delivers nothing: bounce/defer/slow
    // aren't accept-time provider failures here, they're resolved later by the worker's
    // test-mode loop as delivered/bounced events, the way a real provider's webhook would.
    const testMode = settings.testModeDelivery === "true";
    const locals = message.to.map((address) => address.split("@")[0]?.toLowerCase() ?? "");
    let receipt: Receipt;

    if (!testMode && locals.includes("bounce")) {
      receipt = { successful: false, errors: ["Mailbox does not exist"], failure: "permanent" };
    } else if (!testMode && locals.includes("defer")) {
      receipt = { successful: false, errors: ["Temporary failure, try again"], failure: "transient" };
    } else if (!testMode && locals.includes("slow")) {
      receipt = { successful: false, errors: ["You are sending emails too quickly"], failure: "backoff", retryAfterSeconds: 5, accountWide: true };
    } else {
      receipt = { successful: true, providerMessageId: `mock_${randomUUID()}` };
    }

    sent.push({ message, receipt });
    return receipt;
  },

  canHealthCheck: true,

  /** A test double is always reachable. */
  async healthCheck(): Promise<AdapterHealth> {
    return { ok: true, detail: null };
  },

  domain: {
    async create(name: string) {
      return {
        providerDomainId: `mock_${name}`,
        records: [
          { type: "TXT" as const, name: `mock._domainkey.${name}`, value: "v=DKIM1; k=rsa; p=mock", required: true },
          { type: "CNAME" as const, name: `bounces.${name}`, value: "mock.example.net", required: false },
        ],
      };
    },
    async verify() {
      return { answered: true, verified: true, missing: [], errors: [] };
    },
    /** Removal is what a real provider's API does here. It declares removalViaApi, so it has one. */
    async remove(name: string): Promise<void> {
      removed.add(name);
    },
  },

  setup: {
    isConfigured,
    /** A domain starting with "fail" fails its first attempt, the way a provider outage would. */
    async configureEvents(domain, context) {
      if (domain.startsWith("fail") && !setupFailures.has(domain)) {
        setupFailures.add(domain);
        throw new Error("Provider refused to configure events.");
      }
      await context.save({ mockTopic: domain });
      return { settings: { mockConfigured: "true" } };
    },
  },

  // Test mode applies its events in the worker, so no external call is ever authentic.
  events: {
    async verify(): Promise<boolean> {
      return false;
    },
    parse(): NormalizedEvent[] {
      return [];
    },
  },
});

export const mock: AdapterModule = {
  adapter: "mock",
  capabilities,
  credentialsSchema,
  settingsSchema,
  isConfigured,
  create,
};
