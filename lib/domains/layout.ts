import { z } from "zod";
import { wireClass } from "@/lib/wire";
import { escapeHtml } from "@/lib/format/html";

/**
 * A domain's frame: brand name, logo, accent, footer. A send with `layout: true` wraps the
 * caller's html in it, or `layout` can carry an object overriding one or more of those fields
 * for that send only — see `LayoutOverrides`. No variables, no per-message templates — the
 * caller owns the body, the domain owns the frame's structure and its defaults.
 */
export interface DomainLayout {
  /**
   * The sender's identity in the frame: the logo's alt text, and what renders in its place when
   * there's no logo. Required going forward, but `layout` is jsonb, so rows saved before this
   * field existed don't have it at the type level either — read through `brandNameFor`, never
   * `layout.brandName` directly, so an old row falls back to the domain name instead of reading
   * `undefined`.
   */
  brandName: string;
  /**
   * Either an operator-hosted https URL or the public URL of a logo uploaded through the layout
   * form, stored in the `assets` bucket. Mail clients fetch it unauthenticated either way, so it
   * has to be publicly readable.
   */
  logoUrl: string | null;
  /** Hex accent, used for the rule and link color. Rendered as given, in both color schemes. */
  accent: string;
  /** One or two lines under the body. */
  footer: string;
}

export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

const HTTPS_URL = /^https:\/\/\S+$/;

/** One rule per field, shared by the stored layout, its PATCH and a send's overrides. */
const nameField = z.string().trim().min(1, "say who this mail is from").max(200);
const logoField = z.string().trim().max(1000).refine((value) => HTTPS_URL.test(value), "must be an https URL");
const accentField = z.string().trim().regex(HEX_COLOR, "must be a hex color like #1d46f5");
const footerField = z.string().trim().min(1, "say who the mail is from").max(500);

/** A domain's layout as the API reads and writes it. */
export interface SerializedLayout {
  name: string;
  logo: string | null;
  accent: string;
  footer: string;
}

/** A whole layout, after a PATCH is merged onto what's stored. */
export const layoutValueSchema = z.object({
  name: nameField,
  logo: logoField.nullable(),
  accent: accentField,
  footer: footerField,
});

/** `layout` on `PATCH /v1/domains/:id`. Fields left out keep their stored value. */
export const layoutPatchSchema = z
  .object({
    name: nameField.optional().describe("Who the mail is from: the logo's alt text, and what shows in its place without one."),
    logo: logoField
      .nullable()
      .optional()
      .describe("An https URL to the logo. null removes it. Uploading a file is dashboard-only."),
    accent: accentField.optional().describe("Hex color for the rule and links, such as #1d46f5."),
    footer: footerField.optional().describe("One or two lines under the body."),
  })
  .nullable()
  .describe(
    "The frame a send with layout: true is wrapped in. Fields left out keep their stored value; on a domain without a layout, name, accent and footer are required. null removes the layout.",
  );

export type LayoutPatch = z.output<typeof layoutPatchSchema>;

export function serializeLayout(layout: DomainLayout, domainName: string): SerializedLayout {
  return { name: brandNameFor(layout, domainName), logo: layout.logoUrl, accent: layout.accent, footer: layout.footer };
}

/** The stored layout with a PATCH applied, or null when it clears. Throws `ZodError` on what's left invalid. */
export function mergeLayout(current: DomainLayout | null, patch: LayoutPatch, domainName: string): DomainLayout | null {
  if (patch === null) return null;
  // Only what the patch sends is checked; a stored value it leaves alone stays as it is.
  const changes = layoutPatchSchema.unwrap().parse(patch);
  const merged = current
    ? { ...serializeLayout(current, domainName), ...changes }
    : layoutValueSchema.parse({ logo: null, ...changes });
  return { brandName: merged.name, logoUrl: merged.logo, accent: merged.accent, footer: merged.footer };
}

/**
 * A send's overrides on top of the domain's layout. Every field optional — the request schema
 * (`lib/schemas/email.ts`) is what enforces this at the API boundary; this is the shape a
 * validated override is stored and applied in. Same fields as `DomainLayout`, minus `logoUrl`'s
 * upload path: an override is a URL or nothing, never an `assets`-bucket upload.
 */
export interface LayoutOverrides {
  name?: string;
  logo?: string;
  accent?: string;
  footer?: string;
}

export const layoutOverrideSchema = z.object({
  name: nameField.optional().describe("Overrides the layout's brand name for this send."),
  logo: logoField
    .optional()
    .describe("Overrides the layout's logo for this send. Must be an https URL — there's no upload path through this API."),
  accent: accentField.optional().describe("Overrides the layout's accent color for this send."),
  footer: footerField.optional().describe("Overrides the layout's footer for this send."),
});

/**
 * The domain's layout with a send's overrides applied. A field left off `overrides` (or
 * `overrides` itself being null, the `layout: true` case) falls back to the domain's value.
 * Rendering an overridden field goes through the exact same escaping as the domain's own —
 * `frameParts` below doesn't know or care which value it was handed.
 */
export function applyLayoutOverrides(layout: DomainLayout, overrides: LayoutOverrides | null): DomainLayout {
  if (!overrides) return layout;
  return {
    brandName: overrides.name ?? layout.brandName,
    logoUrl: overrides.logo ?? layout.logoUrl,
    accent: overrides.accent ?? layout.accent,
    footer: overrides.footer ?? layout.footer,
  };
}


/**
 * The brand name a layout renders, tolerating a row saved before `brandName` existed. Falls back
 * to the domain name only for that migration case — never as a design default, since a domain
 * name is often not the brand (`mail.example.com` is not "Example").
 */
export function brandNameFor(layout: DomainLayout, domainName: string): string {
  return layout.brandName?.trim() || domainName;
}

/** Class names on the frame we send, so a rebrand can't change the HTML a recipient receives. */
const CLASS = {
  page: wireClass("page"),
  card: wireClass("card"),
  text: wireClass("text"),
  brand: wireClass("brand"),
  footer: wireClass("footer"),
} as const;

/** The frame's two color schemes. The accent is operator-chosen and isn't part of this — it's rendered as given in both. */
const SCHEME_COLORS = {
  light: { page: "#f6f7f9", card: "#ffffff", text: "#1a1a1a", brand: "#1a1a1a", footer: "#6b7280" },
  dark: { page: "#0b0d17", card: "#171a28", text: "#eef0f7", brand: "#eef0f7", footer: "#9aa2b8" },
} as const;

type Scheme = keyof typeof SCHEME_COLORS;

interface FrameParts {
  accent: string;
  logo: string;
  footer: string;
}

function frameParts(layout: DomainLayout, domainName: string): FrameParts {
  const accent = HEX_COLOR.test(layout.accent) ? layout.accent : "#000000";
  const brandName = brandNameFor(layout, domainName);
  const logo = layout.logoUrl
    ? `<tr><td style="padding:0 0 24px"><img src="${escapeHtml(layout.logoUrl)}" alt="${escapeHtml(brandName)}" height="32" style="height:32px;width:auto;max-width:100%;border:0;display:block"></td></tr>`
    : `<tr><td class="${CLASS.brand}" style="padding:0 0 24px;font-size:18px;font-weight:700;line-height:1;word-break:break-word">${escapeHtml(brandName)}</td></tr>`;
  const footer = layout.footer
    .split("\n")
    .map((line) => escapeHtml(line.trim()))
    .filter(Boolean)
    .join("<br>");
  return { accent, logo, footer: footer.length > 0 ? footer : "" };
}

function frameBody(html: string, parts: FrameParts, pageClass: string, cardClass: string, textClass: string, footerClass: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="${pageClass}">
<tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="${cardClass}" style="max-width:600px;border-radius:12px;padding:32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;line-height:1.6">
${parts.logo}<tr><td class="${textClass}">${html}</td></tr>
<tr><td style="padding:24px 0 0"><div style="height:2px;background:${parts.accent};width:40px"></div></td></tr>
<tr><td class="${footerClass}" style="padding:16px 0 0;font-size:13px;line-height:1.5">${parts.footer}</td></tr>
</table>
</td></tr>
</table>`;
}

/**
 * Wraps a body in the domain's frame. Tables and inline styles, because that's what mail clients
 * render — except the colors that flip in dark mode, which live only in the `<style>` block so a
 * competing inline value can't win over the media query. `color-scheme` and
 * `supported-color-schemes` opt in; clients that honor neither just render the light frame.
 *
 * Newlines in the footer become lines. `domainName` is only read for the brand-name fallback on
 * a layout saved before that field existed — see `brandNameFor`.
 */
export function renderLayout(html: string, layout: DomainLayout, domainName: string): string {
  const parts = frameParts(layout, domainName);
  const { light, dark } = SCHEME_COLORS;

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<style>
.${CLASS.page}{background:${light.page}}
.${CLASS.card}{background:${light.card}}
.${CLASS.text}{color:${light.text}}
.${CLASS.brand}{color:${light.brand}}
.${CLASS.footer}{color:${light.footer}}
@media (prefers-color-scheme: dark) {
.${CLASS.page}{background:${dark.page} !important}
.${CLASS.card}{background:${dark.card} !important}
.${CLASS.text}{color:${dark.text} !important}
.${CLASS.brand}{color:${dark.brand} !important}
.${CLASS.footer}{color:${dark.footer} !important}
}
</style>
</head>
<body class="${CLASS.page}" style="margin:0;padding:0">
${frameBody(html, parts, CLASS.page, CLASS.card, CLASS.text, CLASS.footer)}
</body>
</html>`;
}

/**
 * The frame rendered for exactly one color scheme, with no media query — colors are inlined
 * directly instead of going through `<style>`. Dashboard preview only: an operator needs to see
 * both the light frame (what most recipients get) and the dark one regardless of the browser or
 * dashboard's own theme, which a real `prefers-color-scheme` block can't guarantee on demand.
 */
export function renderLayoutPreview(html: string, layout: DomainLayout, domainName: string, scheme: Scheme): string {
  const parts = frameParts(layout, domainName);
  const colors = SCHEME_COLORS[scheme];

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="${scheme}">
<style>
.${CLASS.page}{background:${colors.page}}
.${CLASS.card}{background:${colors.card}}
.${CLASS.text}{color:${colors.text}}
.${CLASS.brand}{color:${colors.brand}}
.${CLASS.footer}{color:${colors.footer}}
</style>
</head>
<body class="${CLASS.page}" style="margin:0;padding:0">
${frameBody(html, parts, CLASS.page, CLASS.card, CLASS.text, CLASS.footer)}
</body>
</html>`;
}
