import { afterEach, describe, expect, it } from "vitest";
import { baseUrl, messageUrl } from "@/lib/api/urls";

const original = process.env.APP_URL;
afterEach(() => {
  if (original === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = original;
});

describe("baseUrl", () => {
  it("drops a trailing slash", () => {
    process.env.APP_URL = "https://email.example.com/";
    expect(baseUrl()).toBe("https://email.example.com");
  });

});

describe("messageUrl", () => {
  it("points at the public /v1 path, not the route class behind it", () => {
    process.env.APP_URL = "https://email.example.com";
    expect(messageUrl("msg_123")).toBe("https://email.example.com/v1/emails/msg_123");
  });
});
