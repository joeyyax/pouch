/**
 * Flat `{{name}}` substitution for a batch send. No conditionals, no loops, no expressions —
 * bulk mode isn't a template system (docs/product/brief.md); this is string replacement
 * against a flat attribute map, nothing more.
 */
import { escapeHtml } from "@/lib/format/html";

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

function substitute(template: string, attributes: Record<string, string>, encode: (value: string) => string): string {
  return template.replace(PLACEHOLDER, (match, name: string) => (Object.hasOwn(attributes, name) ? encode(attributes[name]!) : match));
}

/** Replaces every `{{name}}` with the matching attribute, as written. For the subject and text part. An unknown name is left as written. */
export function renderTemplate(template: string, attributes: Record<string, string>): string {
  return substitute(template, attributes, (value) => value);
}

/** The same, with each value escaped, so an attribute reads as text in the html part instead of becoming markup. */
export function renderHtmlTemplate(template: string, attributes: Record<string, string>): string {
  return substitute(template, attributes, escapeHtml);
}
