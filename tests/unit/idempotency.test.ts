import { describe, expect, it } from "vitest";
import { hashRequest } from "@/lib/messages/idempotency";
import type { SendEmailRequest } from "@/lib/schemas/email";

const base: SendEmailRequest = {
  from: "ada@example.com",
  to: ["person@example.net"],
  subject: "Hello",
  html: "<p>Hi</p>",
};

describe("hashRequest", () => {
  it("ignores the order fields were written in", () => {
    const reordered = { subject: "Hello", html: "<p>Hi</p>", to: ["person@example.net"], from: "ada@example.com" };
    expect(hashRequest(reordered as SendEmailRequest)).toBe(hashRequest(base));
  });

  it("changes when the subject changes", () => {
    expect(hashRequest({ ...base, subject: "Goodbye" })).not.toBe(hashRequest(base));
  });

  it("changes when a recipient is added", () => {
    expect(hashRequest({ ...base, to: ["person@example.net", "other@example.net"] })).not.toBe(hashRequest(base));
  });

  it("keeps recipient order significant, since the provider receives it that way", () => {
    const forward = hashRequest({ ...base, to: ["a@example.net", "b@example.net"] });
    const reverse = hashRequest({ ...base, to: ["b@example.net", "a@example.net"] });
    expect(forward).not.toBe(reverse);
  });

  it("treats an absent optional field the same as an undefined one", () => {
    expect(hashRequest({ ...base, cc: undefined })).toBe(hashRequest(base));
  });

  it("changes when nested header values change", () => {
    const one = hashRequest({ ...base, headers: { "X-Trace": "one" } });
    const two = hashRequest({ ...base, headers: { "X-Trace": "two" } });
    expect(one).not.toBe(two);
  });
});
