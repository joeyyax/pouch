/** How long a domain holds inbound mail before the sweep purges it, absent an override. */
export const INBOUND_RETENTION_DEFAULT_DAYS = 7;

/** The install's ceiling on a domain's retention window, absent an operator's setting. */
export const INBOUND_RETENTION_DEFAULT_MAX_DAYS = 30;

/** The highest the ceiling goes. */
export const INBOUND_RETENTION_HARD_MAX_DAYS = 365;

/** The label inbound mail lands on when a domain doesn't pick its own. */
export const INBOUND_SUBDOMAIN_DEFAULT = "inbound";

/** One lowercase DNS label. */
export const INBOUND_SUBDOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** How long an attachment or raw message link stays valid. */
export const INBOUND_DOWNLOAD_URL_TTL_SECONDS = 900;
