/**
 * What a read of an organization returns.
 *
 * Its own file, with no imports, because both sides of the client boundary need it: the reads in
 * index.ts reach Postgres, and importing from there into a "use client" file drags the driver
 * into the browser bundle.
 */
export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  /** Days a message body stays readable before the worker shreds its key. 7-365, default 45. */
  bodyRetentionDays: number;
}

export interface OwnerSummary {
  name: string;
  email: string;
}
