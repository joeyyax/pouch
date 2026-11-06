import { describe, expect, it } from "vitest";
import { sendEmailSchema } from "@/lib/schemas/email";

const valid = { from: "Ada <ada@example.com>", to: "person@example.net", subject: "Hello", html: "<p>Hi</p>" };

describe("sendEmailSchema", () => {
  it("rejects an empty recipient list", () => {
    const result = sendEmailSchema.safeParse({ ...valid, to: [] });
    expect(result.success).toBe(false);
  });

  it("rejects more recipients than the ceiling", () => {
    const to = Array.from({ length: 51 }, (_, i) => `person${i}@example.net`);
    const result = sendEmailSchema.safeParse({ ...valid, to });
    expect(result.success).toBe(false);
  });

  it("accepts recipients up to the ceiling", () => {
    const to = Array.from({ length: 50 }, (_, i) => `person${i}@example.net`);
    expect(sendEmailSchema.safeParse({ ...valid, to }).success).toBe(true);
  });

  it("rejects a request with neither html nor text", () => {
    const { html: _html, ...withoutBody } = valid;
    const result = sendEmailSchema.safeParse(withoutBody);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.message).toBe('At least one of "html" or "text" is required.');
  });

  it("accepts a text-only body", () => {
    const { html: _html, ...withoutHtml } = valid;
    expect(sendEmailSchema.safeParse({ ...withoutHtml, text: "Hi" }).success).toBe(true);
  });

  it("rejects a subject carrying a line break", () => {
    const result = sendEmailSchema.safeParse({ ...valid, subject: "Hello\r\nBcc: evil@example.net" });
    expect(result.success).toBe(false);
  });

  it("rejects a subject carrying a control character", () => {
    const result = sendEmailSchema.safeParse({ ...valid, subject: "Hello\x00" });
    expect(result.success).toBe(false);
  });

  it("rejects a subject carrying a unicode line separator", () => {
    const result = sendEmailSchema.safeParse({ ...valid, subject: "Hello\u2028World" });
    expect(result.success).toBe(false);
  });

  it("takes layout as a boolean or an object of overrides, and nothing else", () => {
    expect(sendEmailSchema.safeParse({ ...valid, layout: true }).success).toBe(true);
    expect(sendEmailSchema.safeParse({ ...valid, layout: false }).success).toBe(true);
    expect(sendEmailSchema.safeParse({ ...valid, layout: { footer: "Acme · Portland, OR" } }).success).toBe(true);
    expect(sendEmailSchema.safeParse({ ...valid, layout: {} }).success).toBe(true);
    expect(sendEmailSchema.safeParse({ ...valid, layout: "yes" }).success).toBe(false);
  });

  it("rejects a layout override with a non-https logo", () => {
    expect(sendEmailSchema.safeParse({ ...valid, layout: { logo: "http://acme.example.com/mark.png" } }).success).toBe(false);
    expect(sendEmailSchema.safeParse({ ...valid, layout: { logo: "javascript:alert(1)" } }).success).toBe(false);
  });

  it("accepts a layout override naming every field", () => {
    const result = sendEmailSchema.safeParse({
      ...valid,
      layout: { name: "Acme", logo: "https://acme.example.com/mark.png", accent: "#ff0000", footer: "Acme · Portland, OR" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a list of list ids to subscribe recipients to", () => {
    expect(sendEmailSchema.safeParse({ ...valid, subscribe: ["lst_123"] }).success).toBe(true);
  });

  it("accepts an empty subscribe list as a no-op", () => {
    expect(sendEmailSchema.safeParse({ ...valid, subscribe: [] }).success).toBe(true);
  });

  it("rejects a subscribe entry that isn't a non-empty string", () => {
    expect(sendEmailSchema.safeParse({ ...valid, subscribe: [""] }).success).toBe(false);
  });
});
