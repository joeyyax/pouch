import { eq } from "drizzle-orm";
import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { apiKeys, messages } from "@/lib/db/schema";
import { resetRateLimitMemory } from "@/lib/api/rate-limit";
import { createSubmissionServer, createImplicitTlsServer, closeSmtpServers, type SmtpListener } from "@/lib/smtp/server";
import type { SMTPServer } from "smtp-server";
import { resetMockSends } from "@/lib/providers/adapters/mock";
import { addDomainKey, addSuppression, resetDatabase, seedFixture, type Fixture } from "./fixtures";
import { SMTP_CERTIFICATE, SMTP_PRIVATE_KEY } from "../fixtures/smtp-certificate";

const tls = { key: Buffer.from(SMTP_PRIVATE_KEY), cert: Buffer.from(SMTP_CERTIFICATE) };

/** Listens on an ephemeral port and resolves once it's bound, wrapped the same way `startSmtpServers` tracks a listener for shutdown. */
function listen(server: SMTPServer): Promise<SmtpListener> {
  return new Promise((resolve) => {
    const netServer = server.listen(0, () => {
      const address = netServer.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, port });
    });
  });
}

let fixture: Fixture;
let submission: SmtpListener;
let implicitTls: SmtpListener;

beforeEach(async () => {
  await resetDatabase();
  resetRateLimitMemory();
  resetMockSends();
  fixture = await seedFixture({ scopeToDomain: false });
  submission = await listen(createSubmissionServer(tls));
  implicitTls = await listen(createImplicitTlsServer(tls));
});

afterEach(async () => {
  await closeSmtpServers([submission, implicitTls]);
});

function submissionTransport(secret: string): Transporter {
  return nodemailer.createTransport({
    host: "127.0.0.1",
    port: submission.port,
    secure: false,
    requireTLS: true,
    tls: { rejectUnauthorized: false },
    auth: { user: fixture.key.id, pass: secret },
  });
}

function implicitTlsTransport(secret: string): Transporter {
  return nodemailer.createTransport({
    host: "127.0.0.1",
    port: implicitTls.port,
    secure: true,
    tls: { rejectUnauthorized: false },
    auth: { user: fixture.key.id, pass: secret },
  });
}

async function queuedMessage(subject: string) {
  const [row] = await db.select().from(messages).where(eq(messages.subject, subject)).limit(1);
  if (!row) throw new Error(`no queued message with subject "${subject}"`);
  return row;
}

describe("SMTP ingress", () => {
  it("accepts AUTH PLAIN over STARTTLS and queues the same way POST /v1/emails would", async () => {
    const info = await submissionTransport(fixture.secret).sendMail({
      from: `Sender <hi@${"example.com"}>`,
      to: "to@outside.example",
      cc: "cc@outside.example",
      bcc: "bcc@outside.example",
      subject: "smtp-basic",
      html: "<p>Hello</p>",
      headers: { "X-Custom": "yes" },
    });
    expect(info.accepted).toHaveLength(3);

    const row = await queuedMessage("smtp-basic");
    expect(row).toBeDefined();
    expect(row.status).toBe("queued");
    expect(row.testMode).toBe(false);
    expect(row.envelope.to).toEqual(["to@outside.example"]);
    expect(row.envelope.cc).toEqual(["cc@outside.example"]);
    // Bcc never appears in a header — mailparser can't see it, so it's recovered from RCPT TO
    // addresses that aren't in To or Cc.
    expect(row.envelope.bcc).toEqual(["bcc@outside.example"]);
    expect(row.envelope.headers["x-custom"]).toBe("yes");
  });

  it("accepts a To header with a display name", async () => {
    const info = await submissionTransport(fixture.secret).sendMail({
      from: "hi@example.com",
      to: "Joey <joey@outside.example>",
      subject: "smtp-display-name",
      text: "hello",
    });
    expect(info.accepted).toHaveLength(1);

    const row = await queuedMessage("smtp-display-name");
    expect(row.envelope.to).toEqual(["joey@outside.example"]);
  });

  it("accepts multiple To recipients, each with its own display name", async () => {
    const info = await submissionTransport(fixture.secret).sendMail({
      from: "hi@example.com",
      to: "Ann <ann@outside.example>, Bo <bo@outside.example>",
      subject: "smtp-multi-recipient",
      text: "hello",
    });
    expect(info.accepted).toHaveLength(2);

    const row = await queuedMessage("smtp-multi-recipient");
    expect(row.envelope.to).toEqual(["ann@outside.example", "bo@outside.example"]);
  });

  it("accepts a quoted display name containing a comma", async () => {
    const info = await submissionTransport(fixture.secret).sendMail({
      from: "hi@example.com",
      to: '"Yax, Joey" <joey@outside.example>',
      subject: "smtp-quoted-comma-name",
      text: "hello",
    });
    expect(info.accepted).toHaveLength(1);

    const row = await queuedMessage("smtp-quoted-comma-name");
    expect(row.envelope.to).toEqual(["joey@outside.example"]);
  });

  it("accepts implicit TLS on the 465-equivalent listener", async () => {
    await implicitTlsTransport(fixture.secret).sendMail({
      from: "hi@example.com",
      to: "to@outside.example",
      subject: "smtp-implicit-tls",
      text: "hello",
    });

    const row = await queuedMessage("smtp-implicit-tls");
    expect(row).toBeDefined();
  });

  it("routes a test-mode key's send through test mode, exactly as it would over HTTP", async () => {
    const testFixture = await seedFixture({ scopeToDomain: false, keyMode: "test" });
    const transport = nodemailer.createTransport({
      host: "127.0.0.1",
      port: submission.port,
      secure: false,
      requireTLS: true,
      tls: { rejectUnauthorized: false },
      auth: { user: testFixture.key.id, pass: testFixture.secret },
    });

    await transport.sendMail({
      from: "hi@example.com",
      to: "to@outside.example",
      subject: "smtp-test-mode",
      text: "hello",
    });

    const row = await queuedMessage("smtp-test-mode");
    expect(row.testMode).toBe(true);
  });

  it("rejects an invalid key at AUTH with a permanent SMTP reply", async () => {
    const transport = submissionTransport("sk_live_not-a-real-key");
    await expect(transport.sendMail({ from: "hi@example.com", to: "to@outside.example", subject: "x", text: "x" })).rejects.toMatchObject({
      responseCode: 535,
    });
  });

  it("rejects a suppressed recipient at DATA with the API's own message, as a permanent failure", async () => {
    await addSuppression(fixture.organizationId, "blocked@outside.example");

    await expect(
      submissionTransport(fixture.secret).sendMail({
        from: "hi@example.com",
        to: "blocked@outside.example",
        subject: "smtp-suppressed",
        text: "hello",
      }),
    ).rejects.toMatchObject({
      responseCode: 550,
      response: expect.stringContaining("Recipient is suppressed"),
    });
  });

  it("rejects a message with no subject the same way the HTTP schema would", async () => {
    await expect(
      submissionTransport(fixture.secret).sendMail({
        from: "hi@example.com",
        to: "to@outside.example",
        subject: "",
        text: "hello",
      }),
    ).rejects.toMatchObject({ responseCode: 550, response: expect.stringContaining('Field "subject"') });
  });

  it("rejects a domain outside the key's scope with a permanent reply", async () => {
    // A second domain in the same organization, with a key scoped only to it — the same
    // key_not_scoped case POST /v1/emails would return for a from address on example.com.
    const scoped = await addDomainKey(fixture);
    const transport = nodemailer.createTransport({
      host: "127.0.0.1",
      port: submission.port,
      secure: false,
      requireTLS: true,
      tls: { rejectUnauthorized: false },
      auth: { user: scoped.key.id, pass: scoped.secret },
    });

    await expect(
      transport.sendMail({ from: "hi@example.com", to: "to@outside.example", subject: "x", text: "x" }),
    ).rejects.toMatchObject({ responseCode: 550, response: expect.stringContaining("can't send from example.com") });
  });

  it("retries are worth it on a rate limit, marked with a 4xx reply", async () => {
    await db.update(apiKeys).set({ rateLimit: 1 }).where(eq(apiKeys.id, fixture.key.id));

    await submissionTransport(fixture.secret).sendMail({
      from: "hi@example.com",
      to: "to@outside.example",
      subject: "smtp-rate-1",
      text: "hello",
    });

    await expect(
      submissionTransport(fixture.secret).sendMail({
        from: "hi@example.com",
        to: "to@outside.example",
        subject: "smtp-rate-2",
        text: "hello",
      }),
    ).rejects.toMatchObject({ responseCode: 450 });
  });
});

describe("SMTP ingress, sensitive header", () => {
  it("marks the message sensitive on X-Pouch-Sensitive: 1 and strips the header", async () => {
    await submissionTransport(fixture.secret).sendMail({
      from: "hi@example.com",
      to: "to@outside.example",
      subject: "smtp-sensitive",
      text: "Your code is 123456",
      headers: { "X-Pouch-Sensitive": "1", "X-Custom": "yes" },
    });

    const row = await queuedMessage("smtp-sensitive");
    expect(row.bodyWithheld).toBe("");
    expect(row.envelope.headers).toEqual({ "x-custom": "yes" });
  });

  it("strips the header and leaves the message unmarked on any other value", async () => {
    await submissionTransport(fixture.secret).sendMail({
      from: "hi@example.com",
      to: "to@outside.example",
      subject: "smtp-not-sensitive",
      text: "hello",
      headers: { "X-Pouch-Sensitive": "yes" },
    });

    const row = await queuedMessage("smtp-not-sensitive");
    expect(row.bodyWithheld).toBeNull();
    expect(row.envelope.headers).toEqual({});
  });
});
