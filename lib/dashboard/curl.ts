import { baseUrl } from "@/lib/api/urls";

/** Stands in for a key's secret in an example. */
export const KEY_PLACEHOLDER = "$KEY";

function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ? process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "") : baseUrl();
}

/** Single-quotes a shell argument, closing and reopening the quote around any `'` it contains. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function curlFor(secret: string, body: Record<string, unknown>): string {
  return [
    `curl ${appUrl()}/v1/emails`,
    `  -H "Authorization: Bearer ${secret}"`,
    `  -H "Content-Type: application/json"`,
    `  -d ${shellQuote(JSON.stringify(body))}`,
  ].join(" \\\n");
}

/** A GET against `path`, such as `/v1/emails/msg_1?include=body`. */
export function readExample(secret: string, path: string): string {
  return [`curl ${shellQuote(`${appUrl()}${path}`)}`, `  -H "Authorization: Bearer ${secret}"`].join(" \\\n");
}

/** One tab of a runnable example. */
export interface SnippetLanguage {
  id: "curl" | "typescript";
  label: string;
  language: "bash" | "typescript";
  code: string;
}

/** The variable a caller's code keeps its key in. Pouch never reads it. */
export const CALLER_KEY_VAR = "POUCH_API_KEY";

/** Where the SDK points when no `baseUrl` is given. */
const SDK_DEFAULT_BASE_URL = "https://pouch.email";

function curl(code: string): SnippetLanguage {
  return { id: "curl", label: "curl", language: "bash", code };
}

/** The SDK client a placeholder key reads from the environment, or a real one names inline. */
function typescript(secret: string, body: string[]): SnippetLanguage {
  const base = appUrl();
  const options = [
    `apiKey: ${secret === KEY_PLACEHOLDER ? `process.env.${CALLER_KEY_VAR}!` : JSON.stringify(secret)}`,
    ...(base === SDK_DEFAULT_BASE_URL ? [] : [`baseUrl: ${JSON.stringify(base)}`]),
  ];
  const client = ["const pouch = new PouchClient({", ...options.map((option) => `  ${option},`), "});"];
  const code = [`import { PouchClient } from "@joeyyax/pouch";`, "", ...client, "", ...body].join("\n");
  return { id: "typescript", label: "TypeScript", language: "typescript", code };
}

/** The first send a key can make, against a domain it's scoped to, in curl and the SDK. */
export function sendSnippets(secret: string, domainName: string): SnippetLanguage[] {
  const body = { from: `hi@${domainName}`, to: "you@example.com", subject: "First send", html: "<p>It works.</p>" };
  const fields = Object.entries(body).map(([key, value]) => `  ${key}: ${JSON.stringify(value)},`);
  return [curl(curlFor(secret, body)), typescript(secret, ["const message = await pouch.emails.send({", ...fields, "});"])];
}

/** Reading one message back, with its body when asked, in curl and the SDK. */
export function messageReadSnippets(secret: string, id: string, withBody = false): SnippetLanguage[] {
  const path = `/v1/emails/${id}${withBody ? "?include=body" : ""}`;
  const call = withBody ? `await pouch.emails.get(${JSON.stringify(id)}, { include: ["body"] });` : `await pouch.emails.get(${JSON.stringify(id)});`;
  return [curl(readExample(secret, path)), typescript(secret, [`const message = ${call}`])];
}
