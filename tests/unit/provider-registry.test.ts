import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CAPABILITY_KEYS,
  ADAPTER_KEYS,
  buildAdapter,
  capabilitiesOf,
  credentialsSchemaOf,
  isConfiguredFor,
  adaptersWithSetup,
  settingsSchemaOf,
  setupSteps,
} from "@/lib/providers/adapters";

/** Anything that builds an Adapter to read it would be decrypting credentials to do so. */
describe("the credential-free setup check", () => {
  it("declares removalViaApi to match whether the adapter has a remove method", () => {
    for (const providerAdapter of ADAPTER_KEYS) {
      const client = buildAdapter(providerAdapter, { serverToken: "t", accessKeyId: "a", secretAccessKey: "s", region: "us-west-2" });
      expect([providerAdapter, capabilitiesOf(providerAdapter).removalViaApi]).toEqual([
        providerAdapter,
        client.domain.remove !== undefined,
      ]);
    }
  });

  it("registers every adapter that declares a setup step", () => {
    const declared = ADAPTER_KEYS.filter((providerAdapter) =>
      Boolean(buildAdapter(providerAdapter, { serverToken: "t", accessKeyId: "a", secretAccessKey: "s", region: "us-west-2" }).setup),
    );
    expect(adaptersWithSetup().sort()).toEqual(declared.sort());
  });

  it("agrees with the adapter's own answer, for finished and unfinished settings", () => {
    const cases: Record<string, Record<string, string>[]> = {
      ses: [
        {},
        { configurationSetName: "set", topicArn: "arn" },
        { configurationSetName: "set", topicArn: "arn", subscriptionConfirmed: "true" },
      ],
      mock: [{}, { mockConfigured: "true" }],
    };

    for (const [providerAdapter, settingsCases] of Object.entries(cases)) {
      for (const settings of settingsCases) {
        const provider = buildAdapter(
          providerAdapter,
          { serverToken: "t", accessKeyId: "a", secretAccessKey: "s", region: "us-west-2" },
          settings,
        );
        expect(isConfiguredFor(providerAdapter, settings), `${providerAdapter} ${JSON.stringify(settings)}`).toBe(
          provider.setup?.isConfigured(settings) ?? true,
        );
      }
    }
  });

  it("calls an adapter with no setup step finished, since it has nothing to finish", () => {
    expect(buildAdapter("mailpace", { serverToken: "t" }).setup).toBeUndefined();
    expect(isConfiguredFor("mailpace", {})).toBe(true);
  });

  it("doesn't claim an unknown adapter is unfinished", () => {
    expect(isConfiguredFor("retired", {})).toBe(true);
  });
});

describe("provider registry", () => {
  it("declares every capability key on every registered adapter", () => {
    for (const providerAdapter of ADAPTER_KEYS) {
      const capabilities = capabilitiesOf(providerAdapter) as unknown as Record<string, unknown>;
      for (const key of CAPABILITY_KEYS) {
        expect(capabilities[key], `${providerAdapter}.${key}`).toBeDefined();
      }
      expect(Object.keys(capabilities).sort()).toEqual([...CAPABILITY_KEYS].sort());
    }
  });

  it("gives every registered adapter a credentials schema that rejects an empty object", () => {
    for (const providerAdapter of ADAPTER_KEYS) {
      const schema = credentialsSchemaOf(providerAdapter);
      expect(schema, providerAdapter).toBeInstanceOf(z.ZodType);
    }
    expect(credentialsSchemaOf("mailpace").safeParse({}).success).toBe(false);
    expect(credentialsSchemaOf("ses").safeParse({}).success).toBe(false);
  });

  it("accepts the credentials each adapter actually needs", () => {
    expect(credentialsSchemaOf("mailpace").safeParse({ serverToken: "t" }).success).toBe(true);
    expect(
      credentialsSchemaOf("ses").safeParse({ accessKeyId: "AKIA", secretAccessKey: "s", region: "us-west-2" }).success,
    ).toBe(true);
    expect(credentialsSchemaOf("mock").safeParse({}).success).toBe(true);
  });

  it("describes every credentials field, so the dashboard can label them", () => {
    for (const providerAdapter of ADAPTER_KEYS) {
      const shape = (credentialsSchemaOf(providerAdapter) as z.ZodObject).shape;
      for (const [field, value] of Object.entries(shape)) {
        expect((value as z.ZodType).description, `${providerAdapter}.${field}`).toBeTruthy();
      }
    }
  });

  it("leaves nothing for the console on an adapter that manages itself", () => {
    expect(setupSteps("ses", { webhookUrl: "https://mail.example.com/api/webhooks/ses/pac_1" })).toEqual([]);
  });

  it("says mailpace can only check itself with an organization token, per provider", () => {
    expect(buildAdapter("mailpace", { serverToken: "t" }).canHealthCheck).toBe(false);
    expect(buildAdapter("mailpace", { serverToken: "t", organizationToken: "o" }).canHealthCheck).toBe(true);
  });

  it("says the adapters that can always check themselves can", () => {
    expect(buildAdapter("mock", {}).canHealthCheck).toBe(true);
    expect(
      buildAdapter("ses", { accessKeyId: "a", secretAccessKey: "s", region: "us-west-2" }).canHealthCheck,
    ).toBe(true);
  });

  it("has canHealthCheck agree with what healthCheck actually does", async () => {
    // The flag exists to grey out a button. If it disagreed with the call, the button would lie.
    const unable = buildAdapter("mailpace", { serverToken: "t" });
    expect(unable.canHealthCheck).toBe(false);
    expect((await unable.healthCheck()).ok).toBeNull();
  });

  it("marks mailpace as needing a credential copied out of its dashboard", () => {
    const steps = setupSteps("mailpace", { webhookUrl: "https://mail.example.com/api/webhooks/mailpace/pac_1" });
    expect(steps.map((step) => step.step)).toContain("credentials");
  });

  it("names the webhook step for an adapter that can't register its own, and nothing for one that can", () => {
    const steps = setupSteps("mailpace", { webhookUrl: "https://mail.example.com/api/webhooks/mailpace/pac_1" });
    expect(steps.map((step) => step.step)).toContain("webhooks");
    expect(steps.find((step) => step.step === "webhooks")?.message).toContain(
      "https://mail.example.com/api/webhooks/mailpace/pac_1",
    );
    expect(setupSteps("mock", { webhookUrl: "https://mail.example.com/api/webhooks/mock/pac_1" })).toEqual([]);
  });

  it("names the removal step for an adapter that can't remove a domain through its API", () => {
    expect(capabilitiesOf("mailpace").removalViaApi).toBe(false);
    const steps = setupSteps("mailpace", { webhookUrl: "https://mail.example.com/api/webhooks/mailpace/pac_1" });
    expect(steps.map((step) => step.step)).toContain("removal");
    expect(capabilitiesOf("ses").removalViaApi).toBe(true);
    expect(setupSteps("ses", { webhookUrl: "https://mail.example.com/api/webhooks/ses/pac_1" })).toEqual([]);
  });

  it("keeps the SES and SNS SDKs inside the SES adapter", () => {
    const root = join(import.meta.dirname, "../..");
    const allowed = join(root, "lib/providers/adapters/ses/");

    function walk(directory: string): string[] {
      return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return walk(path);
        return entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") ? [path] : [];
      });
    }

    const leaked = ["lib", "worker", "app", "scripts"]
      .flatMap((directory) => walk(join(root, directory)))
      .filter((path) => !path.startsWith(allowed))
      .filter((path) => /@aws-sdk\/client-(sesv2|sns|cloudwatch|eventbridge|iam|sts)/.test(readFileSync(path, "utf8")))
      .map((path) => path.slice(root.length + 1));

    expect(leaked).toEqual([]);
  });

  it("gives every registered adapter a settings schema", () => {
    for (const providerAdapter of ADAPTER_KEYS) {
      expect(settingsSchemaOf(providerAdapter), providerAdapter).toBeInstanceOf(z.ZodType);
      // Settings are optional config, so a provider with none is valid everywhere.
      expect(settingsSchemaOf(providerAdapter).safeParse({}).success, providerAdapter).toBe(true);
    }
    expect(() => settingsSchemaOf("carrier-pigeon")).toThrow(/carrier-pigeon/);
  });

  it("describes every settings field", () => {
    for (const providerAdapter of ADAPTER_KEYS) {
      const shape = (settingsSchemaOf(providerAdapter) as z.ZodObject).shape;
      for (const [field, value] of Object.entries(shape)) {
        expect((value as z.ZodType).description, `${providerAdapter}.${field}`).toBeTruthy();
      }
    }
  });

  it("rejects settings whose values aren't strings, since the column holds a flat map", () => {
    expect(settingsSchemaOf("mailpace").safeParse({ webhookPublicKey: { nested: true } }).success).toBe(false);
    expect(settingsSchemaOf("ses").safeParse({ topicArn: 12 }).success).toBe(false);
  });

  it("takes the settings each adapter actually reads", () => {
    expect(settingsSchemaOf("mailpace").safeParse({ webhookPublicKey: "key" }).success).toBe(true);
    expect(
      settingsSchemaOf("ses").safeParse({
        topicArn: "arn:aws:sns:us-west-2:1:topic",
        configurationSetName: "set",
        subscriptionConfirmed: "true",
      }).success,
    ).toBe(true);
  });
});
