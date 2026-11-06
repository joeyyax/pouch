import { describe, expect, it } from "vitest";
import { accountTargeted, type TargetedFinding } from "@/lib/observations/account-targeted";
import { tagQuiet } from "@/lib/observations/tag-quiet";

function targeted(addresses: [string, number][], reason: string | null = ""): TargetedFinding {
  return { addresses: addresses.map(([address, count]) => ({ address, count })), reason, tags: [], keyIds: [] };
}

describe("account_targeted wording", () => {
  it("names one address, says what was seen and that someone may be targeting it", () => {
    const wording = accountTargeted.condition(targeted([["jane@example.com", 14]]));
    expect(wording.title).toBe("jane@example.com got 14 sensitive messages in 24 hours");
    expect(wording.body).toBe("10 or more in a day is unusual for one address. Someone may be targeting this account.");
    expect(wording.links).toEqual([{ href: "/messages?address=jane%40example.com&sensitive=1&days=1", label: "See these messages" }]);
  });

  it("uses the reason every message shares", () => {
    expect(accountTargeted.condition(targeted([["jane@example.com", 14]], "a password reset link")).title).toBe(
      "jane@example.com got 14 password reset links in 24 hours",
    );
  });

  it("falls back to sensitive messages when the reasons differ", () => {
    expect(accountTargeted.condition(targeted([["jane@example.com", 14]], null)).title).toBe("jane@example.com got 14 sensitive messages in 24 hours");
  });

  it("collapses several addresses into one, naming the top three and a count", () => {
    const wording = accountTargeted.condition(
      targeted([
        ["a@example.com", 20],
        ["b@example.com", 15],
        ["c@example.com", 12],
        ["d@example.com", 11],
        ["e@example.com", 10],
      ], "a sign-in link"),
    );
    expect(wording.title).toBe("5 addresses got 10 or more sign-in links in 24 hours");
    expect(wording.body).toBe("a@example.com (20), b@example.com (15), c@example.com (12) and 2 more. Someone may be targeting these accounts.");
    expect(wording.links).toEqual([{ href: "/messages?sensitive=1&days=1", label: "See sensitive messages" }]);
  });

  it("lists two addresses with and", () => {
    expect(accountTargeted.condition(targeted([["a@example.com", 12], ["b@example.com", 10]])).body).toBe(
      "a@example.com (12) and b@example.com (10). Someone may be targeting these accounts.",
    );
  });

  it("counts addresses in the digest and never names one", () => {
    const one = accountTargeted.digestLine(targeted([["jane@example.com", 14]], "a password reset link"));
    expect(one.text).toBe("one address got 14 password reset links in 24 hours. Someone may be targeting that account.");
    expect(one.text).not.toContain("jane@");

    const several = accountTargeted.digestLine(targeted([["a@example.com", 12], ["b@example.com", 10]]));
    expect(several.text).toBe("2 addresses each got 10 or more sensitive messages in 24 hours. Someone may be targeting those accounts.");
    expect(several.path).toBe("/messages?sensitive=1&days=1");
  });
});

describe("tag_quiet wording", () => {
  const finding = { tag: "order-confirmation", average: 318, tags: ["order-confirmation"], keyIds: [] };

  it("names the tag and its usual daily count, like the domain condition", () => {
    const wording = tagQuiet.condition(finding);
    expect(wording.title).toBe("The order-confirmation tag went quiet");
    expect(wording.body).toBe("None sent in the last day, against about 320 a day over the previous 14 days.");
    expect(wording.links).toEqual([{ href: "/messages?tag=order-confirmation&days=15", label: "See earlier messages" }]);
  });

  it("says the same in the digest", () => {
    expect(tagQuiet.digestLine(finding)).toEqual({
      text: "the order-confirmation tag went quiet. None sent in the last day, against about 320 a day over the previous 14 days.",
      path: "/messages?tag=order-confirmation&days=15",
    });
  });
});
