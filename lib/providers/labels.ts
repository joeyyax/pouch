/**
 * Display names for the adapters, and nothing else.
 *
 * Its own file, with no imports, because both sides of the client boundary need it: everything
 * else under lib/providers reaches an SDK or the database, and a value imported from one of those
 * into a "use client" file drags that dependency into the browser bundle.
 */
export const ADAPTER_LABEL: Record<string, string> = {
  ses: "Amazon SES",
  mailpace: "Mailpace",
  cloudflare: "Cloudflare Email Service",
  mock: "Mock provider",
};

export function adapterLabel(adapter: string): string {
  return ADAPTER_LABEL[adapter] ?? adapter;
}
