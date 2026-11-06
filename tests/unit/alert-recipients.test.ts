import { describe, expect, it } from "vitest";
import { MAX_ALERT_RECIPIENTS, parseAlertRecipients } from "@/lib/settings/service";

describe("parseAlertRecipients", () => {
  it("reads commas, semicolons and new lines, normalizing and deduplicating", () => {
    expect(parseAlertRecipients("a@Example.com, b@example.com;\nA@example.com  c@example.com")).toEqual({
      ok: true,
      addresses: ["a@example.com", "b@example.com", "A@example.com", "c@example.com"],
    });
  });

  it("accepts an empty value, which clears the setting", () => {
    expect(parseAlertRecipients("  ")).toEqual({ ok: true, addresses: [] });
  });

  it("names the first address that isn't one", () => {
    expect(parseAlertRecipients("a@example.com, nope")).toEqual({ ok: false, message: '"nope" isn\'t an email address.' });
  });

  it("caps the list", () => {
    const many = Array.from({ length: MAX_ALERT_RECIPIENTS + 1 }, (_, i) => `u${i}@example.com`).join(",");
    expect(parseAlertRecipients(many).ok).toBe(false);
  });
});
