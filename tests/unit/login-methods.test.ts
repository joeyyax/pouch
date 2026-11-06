import { describe, expect, it } from "vitest";
import { loginMethods, otherWays } from "@/app/(auth)/login/login-methods";

const ALL = { password: true, passkey: true, magic_link: true };

describe("loginMethods", () => {
  it("leads with a sign-in link and keeps the password closed when system mail works", () => {
    expect(loginMethods(ALL, true, undefined)).toEqual({
      passwordOffered: true,
      passwordOpen: false,
      linkOffered: true,
      passkeyOffered: true,
      canToggle: true,
    });
  });

  it("opens the password from ?method=password", () => {
    expect(loginMethods(ALL, true, "password")).toMatchObject({ passwordOpen: true, linkOffered: true, canToggle: true });
  });

  it("ignores any other method", () => {
    expect(loginMethods(ALL, true, "link").passwordOpen).toBe(false);
  });

  it("opens the password and drops the link, with nothing to toggle, when system mail isn't set up", () => {
    expect(loginMethods(ALL, false, undefined)).toMatchObject({ passwordOpen: true, linkOffered: false, canToggle: false });
    expect(loginMethods(ALL, false, "password")).toMatchObject({ passwordOpen: true, linkOffered: false, canToggle: false });
  });

  it("drops the password, even from ?method=password, while it's off", () => {
    expect(loginMethods({ ...ALL, password: false }, true, "password")).toMatchObject({
      passwordOffered: false,
      passwordOpen: false,
      linkOffered: true,
      canToggle: false,
    });
  });

  it("drops the link while it's off, and opens the password", () => {
    expect(loginMethods({ ...ALL, magic_link: false }, true, undefined)).toMatchObject({ passwordOpen: true, linkOffered: false, canToggle: false });
  });

  it("drops the passkey while it's off", () => {
    expect(loginMethods({ ...ALL, passkey: false }, true, undefined).passkeyOffered).toBe(false);
  });

  it("offers only the passkey when it's the only method on", () => {
    expect(loginMethods({ password: false, passkey: true, magic_link: false }, true, undefined)).toEqual({
      passwordOffered: false,
      passwordOpen: false,
      linkOffered: false,
      passkeyOffered: true,
      canToggle: false,
    });
  });
});

describe("otherWays", () => {
  it("names only the methods on offer", () => {
    expect(otherWays(loginMethods(ALL, true, undefined))).toBe(" Use your password or a sign-in link.");
    expect(otherWays(loginMethods({ ...ALL, magic_link: false }, true, undefined))).toBe(" Use your password.");
    expect(otherWays(loginMethods({ ...ALL, password: false }, true, undefined))).toBe(" Use a sign-in link.");
    expect(otherWays(loginMethods({ password: false, passkey: true, magic_link: false }, true, undefined))).toBe("");
  });
});
