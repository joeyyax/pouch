import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { forwardConfirmationMail } from "@/lib/addresses/forward-targets";
import { resetMail } from "@/lib/auth/password-reset";
import { invitationMail } from "@/lib/invitations/mail";
import { listConfirmationMail } from "@/lib/lists/opt-in";
import { bulkFanoutMail } from "@/lib/mail/alerts/bulk-fanout";
import { dmarcPolicyReadyMail } from "@/lib/mail/dmarc-policy-ready";
import { deliveryTimeMail, observationNoticeMail } from "@/lib/mail/notices";
import { domainVerificationFailedMail } from "@/lib/mail/alerts/domain-verification-failed";
import { KeyCreatedEmail, keyCreatedMail } from "@/lib/mail/alerts/key-created";
import { keyRevokedMail } from "@/lib/mail/alerts/key-revoked";
import { providerBackingOffMail } from "@/lib/mail/alerts/provider-backing-off";
import { reputationAlertMail } from "@/lib/mail/alerts/reputation-changed";
import { webhookDisabledMail } from "@/lib/mail/alerts/webhook-disabled";
import { digestMail } from "@/lib/mail/digest/copy";
import { DigestEmail } from "@/lib/mail/digest/email";
import { DEFAULT_STALL_LINES } from "@/lib/domains/guard";
import type { DigestSummary } from "@/lib/mail/digest/metrics";
import { baseUrl } from "@/lib/api/urls";
import { renderSystemMail, SystemMail, systemMailText, type SystemMailBody } from "@/lib/mail/template";

const LINK = "https://pouch.test/x?token=a&b=c";
const HOSTILE = `"><img src=x onerror=alert(1)><script>alert(1)</script>`;
const reason = "Test reason.";

const key = { id: "key_1", name: HOSTILE, mode: "live", organizationId: "org_1", domainIds: [] } as never;
const alerts: [string, Omit<SystemMailBody, "reason">][] = [
  ["bulk fan-out", bulkFanoutMail({ organizationId: "org_1", apiKeyId: "key_1", bodyHash: "h", day: "2026-10-01", count: 300, threshold: 240 }, { key: HOSTILE, organization: HOSTILE })],
  ["domain verification failed", domainVerificationFailedMail({ id: "dom_1", name: HOSTILE, organizationId: "org_1" } as never, ["DKIM missing"], HOSTILE)],
  ["key created", keyCreatedMail(key, HOSTILE)],
  ["key revoked", keyRevokedMail(key, HOSTILE)],
  ["provider backing off", providerBackingOffMail({ name: HOSTILE, adapter: "ses", organizationId: null } as never, new Date("2026-10-01T12:00:00Z"), 30 * 60_000, null)],
  ["observation notice", observationNoticeMail({ organizationName: HOSTILE, wording: { title: HOSTILE, body: HOSTILE, links: [{ href: "/messages", label: HOSTILE }] } })],
  ["webhook disabled", webhookDisabledMail({ url: `https://hooks.example/${HOSTILE}`, organizationId: "org_1" } as never, 5, HOSTILE)],
];

const linked: [string, SystemMailBody][] = [
  ["forward confirmation", forwardConfirmationMail({ requester: HOSTILE, address: `${HOSTILE}@inbound.example.com`, email: "me@example.net", url: LINK })],
  ["invitation", invitationMail({ to: "ada@example.com", organizationName: HOSTILE, invitedByName: HOSTILE, link: LINK, expiresAt: new Date(Date.now() + 864e5), hasAccount: false })],
  ["password reset", resetMail(HOSTILE, LINK)],
  ["reputation alert", reputationAlertMail({ kind: "entered", subjectType: "domain", subjectName: HOSTILE, standing: "paused", findings: [], url: LINK, changedAt: new Date() })],
  ["DMARC policy ready", dmarcPolicyReadyMail({ domainName: HOSTILE, days: 30, record: { name: `_dmarc.${HOSTILE}`, value: `v=DMARC1; p=quarantine; rua=mailto:${HOSTILE}` }, url: LINK })],
  ["delivery time", deliveryTimeMail({ domainName: HOSTILE, title: HOSTILE, body: HOSTILE, action: HOSTILE, url: LINK })],
];

const digestSummary: DigestSummary = {
    window: { cadence: "weekly", windowKey: "2026-W40", since: new Date(), until: new Date(), previousSince: new Date(), previousUntil: new Date() },
    total: 10,
    previousTotal: 5,
    delivered: 9,
    bounced: 1,
    complained: 0,
    failed: 0,
    previous: { delivered: 4, bounced: 1, complained: 0, failed: 0 },
    buckets: [{ start: new Date(), total: 10 }],
    providers: [{ id: HOSTILE, name: HOSTILE, total: 10, delivered: 9, bounced: 1, complained: 0, failed: 0 }],
    organizations: [{ id: HOSTILE, name: HOSTILE, total: 10, delivered: 9, bounced: 1, complained: 0, failed: 0 }],
    topBounceReasons: [{ reason: HOSTILE, count: 1 }],
    attention: {
      standingChanges: [{ subject: HOSTILE, domainId: HOSTILE, organizationId: HOSTILE, organization: HOSTILE, standing: "at_risk" }],
      findings: [{ type: HOSTILE, providerId: HOSTILE, provider: HOSTILE, organizationId: HOSTILE, organization: HOSTILE }],
      stalledDomains: [{ domainId: HOSTILE, domain: HOSTILE, organizationId: HOSTILE, organization: HOSTILE }],
      slowDomains: [],
      observations: [{ organizationId: HOSTILE, organization: HOSTILE, key: "tag_quiet", tone: "info", text: HOSTILE, path: "/" }],
      suspended: [{ organizationId: HOSTILE, organization: HOSTILE }],
      webhooksExhausted: [{ organizationId: HOSTILE, organization: HOSTILE, count: 2 }],
      endpointsDisabled: [],
      failedSignIns: [{ organizationId: HOSTILE, organization: HOSTILE, count: 1 }],
    },
    inbound: { received: 0, spam: 0, dmarcFailed: 0, virus: 0 },
    growth: { organizations: 0, domainsVerified: 0, keys: 0, suppressions: 0 },
    lines: DEFAULT_STALL_LINES,
  };
const digest = digestMail(digestSummary, LINK);

const renderBody = (body: SystemMailBody) => renderSystemMail(createElement(SystemMail, body));

/** The header's mark, the one image system mail carries: the same two URLs for every recipient. */
const MARK_SRCS = [`${baseUrl()}/mail/mark.png`, `${baseUrl()}/mail/mark-dark.png`];
const withoutMark = (html: string) => html.replace(/<img class="pm-logo(?:-dark)?"[^>]*>/g, "");

function expectSafe(html: string): void {
  expect(html).not.toContain("<script>");
  expect(withoutMark(html)).not.toContain("<img");
  expect(html).toContain("&lt;script&gt;");
}

describe("system mail", () => {
  it.each(linked)("%s has both parts, a button and the link as fallback text", async (_name, body) => {
    const { html, text } = await renderBody(body);
    expect(html).toMatch(/^<!DOCTYPE html/);
    expect(html.match(/href="https:\/\/pouch\.test\/x\?token=a&amp;b=c"/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain(`>${body.action!.label}<`);
    expect(text).toContain(LINK);
    expect(text).toContain(body.reason);
    expectSafe(html);
  });

  it.each(alerts)("the %s alert has both parts and escapes what it names", async (_name, body) => {
    const { html, text } = await renderBody({ ...body, reason });
    expect(html).toContain(`<h1`);
    expect(text.startsWith(body.heading)).toBe(true);
    expect(text).toContain(reason);
    if (html.includes("&lt;")) expectSafe(html);
    expect(withoutMark(html)).not.toContain("<img");
  });

  it("puts the digest's turn-off link in both parts", async () => {
    const { html, text } = await renderBody(digest);
    expect(html).toContain('href="https://pouch.test/x?token=a&amp;b=c"');
    expect(text).toContain(`Turn off the weekly digest: ${LINK}`);
    expectSafe(html);
  });

  it("carries no tracking pixel: the only images are the mark, at the same URLs for everyone", async () => {
    for (const [, body] of linked) {
      const { html } = await renderBody(body);
      expect([...html.matchAll(/<img[^>]*\ssrc="([^"]*)"/g)].map((match) => match[1])).toEqual(MARK_SRCS);
      expect(withoutMark(html)).not.toMatch(/<img|background-image|url\(/i);
    }
  });

  it("renders an alert or the digest from its component, text from the same props", async () => {
    const alert = await renderSystemMail(createElement(KeyCreatedEmail, { apiKey: key, organization: HOSTILE, reason }));
    expect(alert).toEqual(await renderBody({ ...keyCreatedMail(key, HOSTILE), reason }));
    expect(alert.text).toBe(systemMailText({ ...keyCreatedMail(key, HOSTILE), reason }));

    const email = await renderSystemMail(createElement(DigestEmail, { summary: digestSummary, unsubscribeUrl: LINK }));
    expect(email.text).toBe(systemMailText(digest));
  });

  it("refuses an email that doesn't render the layout", async () => {
    await expect(renderSystemMail(createElement("p", null, "Hi"))).rejects.toThrow(/SystemMail/);
  });

  it("builds the list confirmation with both parts, the domain's accent and escaped list name", () => {
    const { html, text } = listConfirmationMail(HOSTILE, LINK, "#0f766e");
    expect(html).toContain('bgcolor="#0f766e"');
    expect(html).toContain('href="https://pouch.test/x?token=a&amp;b=c"');
    expect(text).toContain(LINK);
    expectSafe(html);
    expect(listConfirmationMail("News", LINK, "red;x").html).not.toContain("red;x");
  });
});
