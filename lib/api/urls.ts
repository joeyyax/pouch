/** Public base URL of this service, without a trailing slash. */
export function baseUrl(): string {
  return (process.env.APP_URL || "http://localhost:3100").replace(/\/$/, "");
}

/** Where a message is readable. The public API is `/v1`; `/api/v1` is the route class behind it. */
export function messageUrl(id: string): string {
  return `${baseUrl()}/v1/emails/${id}`;
}

/** Where an export's status can be polled. */
export function exportUrl(id: string): string {
  return `${baseUrl()}/v1/exports/${id}`;
}

/** Where an inbound message is readable, while it's retained. */
export function inboundMessageUrl(id: string): string {
  return `${baseUrl()}/v1/inbound/${id}`;
}

/** Where a provider posts its inbound callback for one domain. */
export function inboundWebhookUrl(adapter: string, domainId: string): string {
  return `${baseUrl()}/api/webhooks/inbound/${adapter}/${domainId}`;
}

/** The hosted one-click unsubscribe page a bulk message's List-Unsubscribe header points at. */
export function hostedUnsubscribeUrl(token: string): string {
  return `${baseUrl()}/u/${token}`;
}

/** The hosted double opt-in confirmation page a list confirmation email links to. */
export function hostedConfirmUrl(token: string): string {
  return `${baseUrl()}/confirm/${token}`;
}
