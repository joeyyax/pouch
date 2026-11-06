import { describe, expect, it } from "vitest";
import { buildMime, quotedPrintable } from "@/lib/providers/adapters/mime";
import { htmlToText } from "@/lib/messages/html-to-text";
import type { OutboundMessage } from "@/lib/providers/adapters/types";

function outbound(overrides: Partial<OutboundMessage>): OutboundMessage {
  return {
    id: "msg_test",
    from: { name: "Ada", address: "ada@example.com" },
    to: ["person@example.net"],
    cc: [],
    bcc: [],
    replyTo: [],
    subject: "Hello",
    html: null,
    text: null,
    headers: {},
    tags: [],
    attachments: [],
    ...overrides,
  };
}

/** Pulls the decoded body of the first part whose Content-Type starts with the given subtype. */
function decodedPart(mime: string, contentType: string): string {
  const boundaryMatch = mime.match(/boundary="([^"]+)"/);
  const sections = boundaryMatch ? mime.split(`--${boundaryMatch[1]}`) : [mime];
  const part = sections.find((section) => section.includes(`Content-Type: ${contentType}`));
  if (!part) throw new Error(`no part with Content-Type: ${contentType} in:\n${mime}`);
  const body = part.split("\r\n\r\n").slice(1).join("\r\n\r\n").trim();
  if (part.includes("Content-Transfer-Encoding: base64")) {
    return Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8");
  }
  const joined = body.replace(/=\r\n/g, "");
  return Buffer.from(
    joined.replace(/=([0-9A-F]{2})|([^])/g, (_all, hex: string | undefined, raw: string | undefined) =>
      hex ? String.fromCharCode(parseInt(hex, 16)) : (raw ?? ""),
    ),
    "binary",
  )
    .toString("utf8")
    .replace(/\r\n/g, "\n");
}

describe("buildMime", () => {
  it("quotes a display name carrying specials, so a comma or an @ can't split the address", () => {
    const header = (name: string) => buildMime(outbound({ text: "t", from: { name, address: "a@example.com" } })).split("\r\n").find((line) => line.startsWith("From:"));
    expect(header("Doe, Jane")).toBe('From: "Doe, Jane" <a@example.com>');
    expect(header('ada@example.net via x@in.example.com')).toBe('From: "ada@example.net via x@in.example.com" <a@example.com>');
    expect(header('Say "hi"')).toBe('From: "Say \\"hi\\"" <a@example.com>');
    expect(header("Ada")).toBe("From: Ada <a@example.com>");
  });

  it("sends a single text/html part when there is no text alongside html", () => {
    const mime = buildMime(outbound({ html: "<p>Hi</p>" }));

    expect(mime).not.toContain("multipart/alternative");
    expect(mime).toContain("Content-Type: text/html; charset=utf-8");
  });

  it("builds multipart/alternative once a plain-text part exists alongside html", () => {
    const html = "<h1>Receipt</h1><p>Thanks for your order.</p>";
    const message = outbound({ html, text: htmlToText(html) });

    const mime = buildMime(message);

    expect(mime).toContain("Content-Type: multipart/alternative");
    expect(decodedPart(mime, "text/plain")).toBe("Receipt\n\nThanks for your order.");
    expect(decodedPart(mime, "text/html")).toBe(html);
  });

  it("carries the derived text's link through to the sent message", () => {
    const html = '<p>Track it: <a href="https://example.com/t/1">here</a></p>';
    const message = outbound({ html, text: htmlToText(html) });

    const mime = buildMime(message);

    expect(decodedPart(mime, "text/plain")).toBe("Track it: here https://example.com/t/1");
  });

  it("preserves an explicit text part untouched, rather than the derived one", () => {
    const message = outbound({ html: "<p>Rich</p>", text: "Handwritten plain text." });

    const mime = buildMime(message);

    expect(decodedPart(mime, "text/plain")).toBe("Handwritten plain text.");
  });

  it("sends a single text/html part, not multipart/alternative, when text is an explicit empty string", () => {
    const message = outbound({ html: "<p>Hi</p>", text: "" });

    const mime = buildMime(message);

    expect(mime).not.toContain("multipart/alternative");
    expect(mime).not.toContain("text/plain");
    expect(mime).toContain("Content-Type: text/html; charset=utf-8");
  });
});

describe("quoted-printable", () => {
  it("leaves plain ASCII alone, so the file reads as text", () => {
    expect(quotedPrintable("Thanks for your order.")).toBe("Thanks for your order.");
  });

  it("escapes the equals sign, since it's the escape character", () => {
    expect(quotedPrintable("a=b")).toBe("a=3Db");
  });

  it("escapes non-ASCII as its UTF-8 bytes", () => {
    expect(quotedPrintable("café")).toBe("caf=C3=A9");
  });

  it("escapes whitespace at the end of a line, which a transport would otherwise strip", () => {
    expect(quotedPrintable("trailing \nnext")).toBe("trailing=20\r\nnext");
  });

  it("soft-wraps a long line without splitting an escape", () => {
    const encoded = quotedPrintable(`${"a".repeat(70)}café`);
    for (const line of encoded.split("\r\n")) expect(line.length).toBeLessThanOrEqual(76);
    expect(encoded).toContain("=\r\n");
    expect(encoded).not.toMatch(/=\r\n[0-9A-F]{2}[^=]/);
  });

  it("round-trips through a decoder", () => {
    const source = "Line one — with an em dash\nLine two = two\n\tTabbed";
    expect(decodedPart(buildMime(outbound({ text: source })), "text/plain")).toBe(source);
  });
});
