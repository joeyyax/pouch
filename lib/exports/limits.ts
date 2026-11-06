/**
 * Export size limits.
 *
 * Past these, an export doesn't stream from the request — it queues as a row in `exports`
 * (lib/db/schema/exports.ts) and worker/exports.ts builds it in the background. Below them,
 * behavior is unchanged from #152: the request streams the file directly and nothing is
 * written to a row at all. The ceiling used to mean "refused"; it now means "queued instead
 * of streamed" — nothing above it is turned away outright.
 */

/** Rows pulled per database round trip while streaming an export. */
export const EXPORT_BATCH_SIZE = 500;

/** Message rows a CSV or NDJSON log export will stream directly before it queues instead. */
export const EXPORT_MAX_MESSAGES = 10_000;

/** Messages a bodies export will decrypt and bundle directly before it queues instead. Lower
 * than the log ceiling: each body is read from object storage and held in memory long enough
 * to write its .eml entry. */
export const EXPORT_MAX_BODIES = 1_000;

/** Claims one export row gets before the worker marks it failed. A clean shutdown gives its claim back. */
export const EXPORT_MAX_ATTEMPTS = 3;

/**
 * Ceiling on a finished artifact, enforced as it streams. Stays under 2 GiB so `size_bytes`
 * fits an integer and under zip's 4 GiB offset limit.
 */
export const EXPORT_MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;

/** Entries a zip without zip64 can list. */
export const EXPORT_MAX_ZIP_ENTRIES = 0xffff;

/** How long a queued export's artifact stays downloadable before the worker deletes it and the
 * row reads `expired`. It's a second, unencrypted copy of content the org's own retention
 * setting otherwise governs — see the PR description — so its lifetime is short and fixed
 * rather than tied to that setting. */
export const EXPORT_ARTIFACT_TTL_DAYS = 7;
