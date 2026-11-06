import { brand } from "@/lib/brand";
import { escapeHtml } from "@/lib/format/html";
import { markSvg } from "@/lib/brand-mark";
import { FONT_STACK, PALETTE, textOn } from "@/lib/brand-palette";
import { HEX_COLOR } from "@/lib/domains/layout";

/** Markup that's been escaped, or written here. Anything else is text. */
export class SafeHtml {
  constructor(readonly value: string) {}
}


/** A template whose interpolations are escaped unless they're already `SafeHtml`. */
export function html(strings: TemplateStringsArray, ...values: (string | SafeHtml)[]): SafeHtml {
  let out = strings[0] ?? "";
  values.forEach((value, index) => {
    out += (value instanceof SafeHtml ? value.value : escapeHtml(value)) + (strings[index + 1] ?? "");
  });
  return new SafeHtml(out);
}

/** No scripts, no loads, no framing, no forms. Styles are the page's own inline `<style>` block. */
export const HOSTED_PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** The same, with forms posting back to this origin. */
export const HOSTED_FORM_CSP = HOSTED_PAGE_CSP.replace("form-action 'none'", "form-action 'self'");

/** What the page is saying: asking, done just now, already done, a dead link, or a failure. */
export type PageTone = "question" | "success" | "done" | "invalid" | "error";

/** Pouch's own pages carry its mark; a domain's subscribers see the domain's name and accent, or nothing when the link names no domain. */
export type PageBrand = { kind: "pouch" } | { kind: "domain"; name: string; accent: string | null; footer: string | null } | { kind: "plain" };

export const PLAIN_BRAND: PageBrand = { kind: "plain" };

export const POUCH_BRAND: PageBrand = { kind: "pouch" };

/** A button that posts the page's own URL with these fields. */
export interface PageAction {
  label: string;
  fields?: Record<string, string>;
  quiet?: boolean;
}

export interface HostedPageInput {
  tone: PageTone;
  title: string;
  /** One paragraph each. */
  body: (string | SafeHtml)[];
  actions?: PageAction[];
  brand?: PageBrand;
  /** Pouch pages only: the line under the card. */
  footer?: string;
}

const { light, dark } = PALETTE;

const STYLE = `
:root{color-scheme:light dark;--bg:${light.background};--card:${light.card};--fg:${light.foreground};--soft:${light.soft};--muted:${light.muted};--border:${light.border};--accent:${light.primary};--on-accent:${light.onPrimary};--success:${light.success};--success-soft:${light.successSoft};--warning:${light.warning};--warning-soft:${light.warningSoft};--danger:${light.danger};--danger-soft:${light.dangerSoft};--shadow:0 1px 3px rgba(18,26,64,.05),0 8px 22px rgba(18,26,64,.06)}
@media (prefers-color-scheme:dark){:root{--bg:${dark.background};--card:${dark.card};--fg:${dark.foreground};--soft:${dark.soft};--muted:${dark.muted};--border:${dark.border};--accent:${dark.primary};--on-accent:${dark.onPrimary};--success:${dark.success};--success-soft:${dark.successSoft};--warning:${dark.warning};--warning-soft:${dark.warningSoft};--danger:${dark.danger};--danger-soft:${dark.dangerSoft};--shadow:none}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;min-height:100dvh;background:var(--bg);color:var(--fg);font:16px/1.55 ${FONT_STACK};-webkit-font-smoothing:antialiased;display:flex;flex-direction:column;align-items:center;padding:40px 16px}
@media (min-width:640px){body{padding-top:96px}}
.brand{display:flex;align-items:center;gap:10px;margin:0 0 24px;font-size:17px;font-weight:600;letter-spacing:-.01em;max-width:30rem;overflow-wrap:anywhere;text-align:center}
.brand svg{width:28px;height:28px;flex:none}
main{width:100%;max-width:30rem;background:var(--card);border:1px solid var(--border);border-radius:20px;box-shadow:var(--shadow);padding:24px}
@media (min-width:640px){main{padding:40px}}
.icon{width:40px;height:40px;border-radius:999px;display:flex;align-items:center;justify-content:center;margin:0 0 20px}
.icon svg{width:20px;height:20px}
.success .icon{background:var(--success-soft);color:var(--success)}
.done .icon{background:var(--bg);color:var(--soft)}
.invalid .icon{background:var(--warning-soft);color:var(--warning)}
.error .icon{background:var(--danger-soft);color:var(--danger)}
h1{font-size:22px;line-height:1.25;font-weight:600;letter-spacing:-.01em;margin:0 0 12px;text-wrap:balance}
@media (min-width:640px){h1{font-size:24px}}
p{margin:0 0 12px;color:var(--soft)}
p:last-child{margin-bottom:0}
strong{color:var(--fg);font-weight:600;overflow-wrap:anywhere}
a{color:var(--fg);text-underline-offset:2px}
form{margin:0}
.actions{display:flex;flex-direction:column;gap:12px;margin-top:28px}
button{appearance:none;width:100%;min-height:48px;padding:12px 24px;border-radius:999px;font:600 16px/1.25 ${FONT_STACK};cursor:pointer;border:1px solid transparent;background:var(--accent);color:var(--on-accent)}
button.quiet{background:transparent;color:var(--fg);border-color:var(--border)}
@media (hover:hover){button:hover{filter:brightness(1.08)}button.quiet:hover{background:var(--bg);filter:none}}
button:active{filter:brightness(.92)}
button:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
footer{max-width:30rem;margin-top:24px;font-size:13px;line-height:1.5;color:var(--muted);text-align:center;overflow-wrap:anywhere;white-space:pre-line}
`;

const MARK = markSvg({ fill: "var(--accent)", attributes: 'aria-hidden="true"' });

const CHECK = `<path d="M5 10.5l3.2 3.2L15 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
const ALERT = `<path d="M10 5.5v5.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="10" cy="14.5" r="1.2" fill="currentColor"/>`;

const ICON: Record<PageTone, string | null> = { question: null, success: CHECK, done: CHECK, invalid: ALERT, error: ALERT };

function accentStyle(pageBrand: PageBrand): string {
  if (pageBrand.kind === "pouch") return "";
  if (pageBrand.kind === "plain" || !pageBrand.accent || !HEX_COLOR.test(pageBrand.accent)) return ":root{--accent:var(--fg);--on-accent:var(--card)}";
  return `:root{--accent:${pageBrand.accent};--on-accent:${textOn(pageBrand.accent)}}`;
}

function header(pageBrand: PageBrand): SafeHtml | string {
  if (pageBrand.kind === "plain") return "";
  if (pageBrand.kind === "pouch") return html`<header class="brand">${new SafeHtml(MARK)}<span>${brand.name}</span></header>`;
  return html`<header class="brand"><span>${pageBrand.name}</span></header>`;
}

function footer(input: HostedPageInput, pageBrand: PageBrand): SafeHtml | string {
  const text = pageBrand.kind === "domain" ? (pageBrand.footer ?? pageBrand.name) : pageBrand.kind === "pouch" ? input.footer : null;
  return text ? html`<footer>${text}</footer>` : "";
}

function actionForm(action: PageAction): SafeHtml {
  const fields = Object.entries(action.fields ?? {}).map(([name, value]) => html`<input type="hidden" name="${name}" value="${value}">`);
  return html`<form method="post">${join(fields)}<button type="submit"${new SafeHtml(action.quiet ? ' class="quiet"' : "")}>${action.label}</button></form>`;
}

function join(parts: SafeHtml[]): SafeHtml {
  return new SafeHtml(parts.map((part) => part.value).join(""));
}

/** A public page on the app's origin, reached from a link in an email. The token is in the URL, so no referrer leaves. */
export function hostedPage(input: HostedPageInput, status: number): Response {
  const pageBrand = input.brand ?? POUCH_BRAND;
  const brandName = pageBrand.kind === "pouch" ? brand.name : pageBrand.kind === "domain" ? pageBrand.name : null;
  const icon = ICON[input.tone];
  const actions = input.actions ?? [];

  const page = html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="robots" content="noindex"><title>${brandName ? `${input.title} · ${brandName}` : input.title}</title><style>${new SafeHtml(STYLE + accentStyle(pageBrand))}</style></head><body>${header(pageBrand)}<main class="${input.tone}">${new SafeHtml(icon ? `<div class="icon"><svg viewBox="0 0 20 20" aria-hidden="true">${icon}</svg></div>` : "")}<h1>${input.title}</h1>${join(input.body.map((line) => html`<p>${line}</p>`))}${actions.length > 0 ? html`<div class="actions">${join(actions.map(actionForm))}</div>` : ""}</main>${footer(input, pageBrand)}</body></html>`;

  return new Response(page.value, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": actions.length > 0 ? HOSTED_FORM_CSP : HOSTED_PAGE_CSP,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
    },
  });
}

/** A POST to a hosted page: a mail client's RFC 8058 one-click request, or a person pressing the page's button. */
export async function readPost(request: Request): Promise<{ oneClick: boolean; fields: URLSearchParams }> {
  const body = await request.text().catch(() => "");
  const fields = new URLSearchParams(body);
  return { oneClick: fields.get("List-Unsubscribe") === "One-Click" || /name="List-Unsubscribe"\s+One-Click/.test(body), fields };
}
