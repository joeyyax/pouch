import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  applyLayoutOverrides,
  brandNameFor,
  layoutOverrideSchema,
  mergeLayout,
  renderLayout,
  renderLayoutPreview,
  serializeLayout,
  type DomainLayout,
} from "@/lib/domains/layout";

const layout: DomainLayout = {
  brandName: "Scope",
  logoUrl: "https://scope.example/mark.png",
  accent: "#1d46f5",
  footer: "Scope · Portland, OR",
};

describe("mergeLayout", () => {
  const merge = (patch: Parameters<typeof mergeLayout>[1], current: DomainLayout | null = layout) => mergeLayout(current, patch, "scope.example");

  it("wants a brand name", () => {
    expect(() => merge({ name: "  " })).toThrow(ZodError);
    expect(merge({ name: " Scope " })?.brandName).toBe("Scope");
  });

  it("takes an https logo or none, and nothing in between", () => {
    expect(merge({ logo: null })?.logoUrl).toBeNull();
    expect(merge({})?.logoUrl).toBe("https://scope.example/mark.png");
    // Mail clients won't load http, and an internal URL shouldn't leak into a recipient's mail.
    expect(() => merge({ logo: "http://scope.example/mark.png" })).toThrow(ZodError);
    expect(() => merge({ logo: "javascript:alert(1)" })).toThrow(ZodError);
  });

  it("takes a six-digit hex accent and nothing else", () => {
    expect(merge({ accent: "#1d46f5" })?.accent).toBe("#1d46f5");
    expect(() => merge({ accent: "blue" })).toThrow(ZodError);
    expect(() => merge({ accent: "#fff" })).toThrow(ZodError);
  });

  it("wants a footer", () => {
    expect(() => merge({ footer: "   " })).toThrow(ZodError);
  });

  it("keeps what a patch leaves out", () => {
    expect(merge({ accent: "#000000" })).toEqual({ ...layout, accent: "#000000" });
  });

  it("needs every required field on a domain without a layout", () => {
    expect(() => merge({ accent: "#000000" }, null)).toThrow(ZodError);
    expect(merge({ name: "Scope", accent: "#000000", footer: "Hi" }, null)).toEqual({
      brandName: "Scope",
      logoUrl: null,
      accent: "#000000",
      footer: "Hi",
    });
  });

  it("leaves a stored value it doesn't touch alone, even one today's rules refuse", () => {
    const stored = { ...layout, logoUrl: "data:image/png;base64,AAAA" };
    expect(merge({ accent: "#000000" }, stored)).toEqual({ ...stored, accent: "#000000" });
  });

  it("clears on null", () => {
    expect(merge(null)).toBeNull();
  });
});

describe("serializeLayout", () => {
  it("falls back to the domain name for a layout saved before brand names", () => {
    expect(serializeLayout({ ...layout, brandName: undefined as unknown as string }, "scope.example").name).toBe("scope.example");
  });
});

describe("layoutOverrideSchema", () => {
  it("accepts an empty object — every field is optional", () => {
    expect(layoutOverrideSchema.safeParse({}).success).toBe(true);
  });

  it("takes an https logo and nothing else", () => {
    expect(layoutOverrideSchema.safeParse({ logo: "https://acme.example.com/mark.png" }).success).toBe(true);
    expect(layoutOverrideSchema.safeParse({ logo: "http://acme.example.com/mark.png" }).success).toBe(false);
    expect(layoutOverrideSchema.safeParse({ logo: "javascript:alert(1)" }).success).toBe(false);
    expect(layoutOverrideSchema.safeParse({ logo: "data:text/html,<script>alert(1)</script>" }).success).toBe(false);
  });

  it("takes a six-digit hex accent and nothing else", () => {
    expect(layoutOverrideSchema.safeParse({ accent: "#ff0000" }).success).toBe(true);
    expect(layoutOverrideSchema.safeParse({ accent: "red" }).success).toBe(false);
  });

  it("wants a non-blank name and footer when given", () => {
    expect(layoutOverrideSchema.safeParse({ name: "  " }).success).toBe(false);
    expect(layoutOverrideSchema.safeParse({ footer: "  " }).success).toBe(false);
  });
});

describe("applyLayoutOverrides", () => {
  it("returns the layout unchanged with no overrides", () => {
    expect(applyLayoutOverrides(layout, null)).toEqual(layout);
  });

  it("replaces only the overridden fields, keeping the rest of the domain's layout", () => {
    const merged = applyLayoutOverrides(layout, { footer: "Acme · Portland, OR" });
    expect(merged.footer).toBe("Acme · Portland, OR");
    expect(merged.brandName).toBe(layout.brandName);
    expect(merged.logoUrl).toBe(layout.logoUrl);
    expect(merged.accent).toBe(layout.accent);
  });

  it("replaces every overridden field at once", () => {
    const merged = applyLayoutOverrides(layout, {
      name: "Acme",
      logo: "https://acme.example.com/mark.png",
      accent: "#ff0000",
      footer: "Acme · Portland, OR",
    });
    expect(merged).toEqual({
      brandName: "Acme",
      logoUrl: "https://acme.example.com/mark.png",
      accent: "#ff0000",
      footer: "Acme · Portland, OR",
    });
  });

  it("renders an override through the same escaping as a domain-level field", () => {
    const html = renderLayout(
      "<p>Hi</p>",
      applyLayoutOverrides(layout, { name: '<script>alert(1)</script>', footer: '<img src=x onerror=alert(1)>' }),
      "scope.example",
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});

describe("brandNameFor", () => {
  it("uses the layout's brand name when there is one", () => {
    expect(brandNameFor(layout, "scope.example")).toBe("Scope");
  });

  it("falls back to the domain name for a row saved before brandName existed", () => {
    const legacy = { logoUrl: null, accent: "#1d46f5", footer: "x" } as DomainLayout;
    expect(brandNameFor(legacy, "scope.example")).toBe("scope.example");
  });

  it("falls back for a blank brand name too", () => {
    expect(brandNameFor({ ...layout, brandName: "   " }, "scope.example")).toBe("scope.example");
  });
});

describe("renderLayout", () => {
  it("keeps the caller's html and adds the frame around it", () => {
    const html = renderLayout("<p>Your invite is ready.</p>", layout, "scope.example");
    expect(html).toContain("<p>Your invite is ready.</p>");
    expect(html).toContain("https://scope.example/mark.png");
    expect(html).toContain("#1d46f5");
    expect(html).toContain("Scope · Portland, OR");
  });

  it("substitutes nothing — there are no variables", () => {
    const html = renderLayout("<p>Hi {{name}}</p>", layout, "scope.example");
    expect(html).toContain("{{name}}");
  });

  it("escapes the footer and the logo URL, which are operator input", () => {
    const html = renderLayout(
      "<p>Hi</p>",
      {
        brandName: "Scope",
        logoUrl: 'https://x.test/a.png"onerror="alert(1)',
        accent: "#1d46f5",
        footer: '<script>alert(1)</script>',
      },
      "scope.example",
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain('onerror="alert(1)"');
  });

  it("turns footer newlines into lines", () => {
    expect(renderLayout("<p>Hi</p>", { ...layout, footer: "Scope\nPortland, OR" }, "scope.example")).toContain(
      "Scope<br>Portland, OR",
    );
  });

  it("uses the brand name as the logo's alt text", () => {
    const html = renderLayout("<p>Hi</p>", layout, "scope.example");
    expect(html).toContain('alt="Scope"');
  });

  it("renders the brand name as text instead of an empty box when there's no logo", () => {
    const html = renderLayout("<p>Hi</p>", { ...layout, logoUrl: null }, "scope.example");
    expect(html).not.toContain("<img");
    expect(html).toContain(">Scope<");
  });

  it("falls back to the domain name for a layout saved before brandName existed", () => {
    const legacy = { logoUrl: null, accent: "#1d46f5", footer: "x" } as DomainLayout;
    const html = renderLayout("<p>Hi</p>", legacy, "scope.example");
    expect(html).toContain(">scope.example<");
  });

  it("declares both color schemes and overrides the frame colors for dark, not the accent", () => {
    const html = renderLayout("<p>Hi</p>", layout, "scope.example");
    expect(html).toContain('name="color-scheme" content="light dark"');

    const darkBlock = html.match(/@media \(prefers-color-scheme: dark\) \{([\s\S]*?)\}\s*<\/style>/)?.[1] ?? "";
    expect(darkBlock).toContain("!important");
    // The frame colors flip in dark; the operator's accent doesn't appear in the override at all.
    expect(darkBlock).not.toContain("#1d46f5");
  });

  it("keeps the light background out of the inline body style, so the dark override isn't fighting it", () => {
    const html = renderLayout("<p>Hi</p>", layout, "scope.example");
    const bodyTag = html.match(/<body[^>]*>/)?.[0] ?? "";
    expect(bodyTag).not.toContain("background");
  });
});

describe("renderLayoutPreview", () => {
  it("locks to the requested scheme with no media query", () => {
    const dark = renderLayoutPreview("<p>Hi</p>", layout, "scope.example", "dark");
    expect(dark).not.toContain("@media");
    expect(dark).toContain("#0b0d17");

    const light = renderLayoutPreview("<p>Hi</p>", layout, "scope.example", "light");
    expect(light).not.toContain("@media");
    expect(light).toContain("#f6f7f9");
  });

  it("still frames the same body and brand as renderLayout", () => {
    const preview = renderLayoutPreview("<p>Hi</p>", layout, "scope.example", "light");
    expect(preview).toContain("<p>Hi</p>");
    expect(preview).toContain('alt="Scope"');
  });
});
