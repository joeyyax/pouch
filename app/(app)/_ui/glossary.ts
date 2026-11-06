/** One definition per term, so every screen explains it the same way. */
export const GLOSSARY = {
  queued: "Accepted by the API and not yet handed to the provider.",
  sent: "Handed to the provider. No word back from the receiving server yet.",
  delivered: "The receiving server accepted it.",
  deferred: "The receiving server asked to try again later. The provider keeps retrying.",
  bounced: "The receiving server refused it. A hard bounce suppresses the address.",
  complained: "The recipient marked it as spam. The address is suppressed.",
  failed: "It couldn't be sent: the provider refused it or retries ran out.",
  resolved: "Delivered, bounced, complained or failed. Mail still in flight isn't counted.",

  held: "Queued and waiting, because its domain is paused or the organization is suspended. It sends when the hold lifts.",
  due: "Ready to send and waiting for a worker.",
  sending: "A worker is handing it to the provider right now.",
  retrying: "Waiting out a backoff before the next attempt.",
  silent: "Handed to the provider over an hour ago with no delivery, bounce or complaint back.",

  p50: "Half of sends took this long or less.",
  p95: "95% of sends took this long or less.",
  p99: "99% of sends took this long or less.",
  queue_p95: "95% of sends waited this long or less before reaching the provider.",
  pp: "Percentage points: how far the rate moved from the previous window.",

  healthy: "Bounces, complaints, blocklists and sending patterns all look normal.",
  watch: "Something is drifting the wrong way, like a rising bounce rate or a jump in volume. Worth a look.",
  at_risk: "Needs action now: a rate is close to the pause line, or a blocklist or sending pattern puts delivery at risk.",
  paused: "Sending is on hold until someone releases it. Queued mail waits and isn't lost.",

  moving: "Moving to another provider. It keeps sending on the current one until the new one verifies.",

  live: "Sends go through the domain's provider to real inboxes.",
  sensitive: "This email was identified as sensitive, so its contents aren't available.",
  test: "Sends go to a mock provider that reports them delivered a few seconds later. Nothing reaches a real inbox.",
  every_domain: "Sends from any domain in the organization, including ones added later.",
  rate_limit: "Requests a key can make per minute. Past it, the API answers 429 with how long to wait.",

  single_opt_in: "New members get batches right away, without confirming their address.",
  double_opt_in: "New members confirm by email before they get a batch.",
  pending_member: "Sent a confirmation link and hasn't opened it yet. Gets no batches, and expires after 7 days.",

  address_active: "Delivers mail to its key's webhook and forwards it to confirmed mailboxes.",
  address_expired: "Past its expiry. Mail to it is dropped and counted. Extending it makes it active again.",
  address_revoked: "Turned off for good. Mail to it is dropped and counted, and its local part is never reissued.",
  address_dropped: "Mail the address took in and didn't deliver: after expiry or revocation, past a limit or for a virus. Nothing bounces.",
  forward_pending: "Sent a confirmation link and hasn't opened it yet. Nothing forwards until it does.",
} as const;

export type GlossaryTerm = keyof typeof GLOSSARY;
