/** What's copied into the search index, and nothing more. See docs/decisions.md, "Search copies the fields it searches, never a body". */
import type { MessageRow, SuppressionRow } from "@/lib/db/schema";

export const SEARCH_INDEXES = ["messages", "suppressions"] as const;
export type SearchIndexName = (typeof SEARCH_INDEXES)[number];

export interface MessageDocument {
  id: string;
  organization_id: string;
  domain_id: string;
  domain: string;
  from: string;
  subject: string;
  recipients: string[];
  tags: string[];
  /** Unix seconds, for the list's window. */
  created_at: number;
}

export interface SuppressionDocument {
  id: string;
  organization_id: string;
  address: string;
  created_at: number;
}

export type SearchDocument = MessageDocument | SuppressionDocument;

export interface IndexSettings {
  searchableAttributes: string[];
  filterableAttributes: string[];
}

export const INDEX_SETTINGS: Record<SearchIndexName, IndexSettings> = {
  messages: {
    searchableAttributes: ["recipients", "subject", "from", "tags", "domain"],
    filterableAttributes: ["organization_id", "created_at"],
  },
  suppressions: {
    searchableAttributes: ["address"],
    filterableAttributes: ["organization_id"],
  },
};

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

/** A row an organization holds. The service's own mail and suppressions are never indexed. */
export type Owned<T extends { organizationId: string | null }> = T & { organizationId: string };

export function isOwned<T extends { organizationId: string | null }>(row: T): row is Owned<T> {
  return row.organizationId !== null;
}

export function messageDocument(row: Owned<Pick<MessageRow, "id" | "organizationId" | "domainId" | "fromAddress" | "subject" | "recipients" | "tags" | "createdAt">>, domainName: string): MessageDocument {
  return {
    id: row.id,
    organization_id: row.organizationId,
    domain_id: row.domainId,
    domain: domainName,
    from: row.fromAddress,
    subject: row.subject,
    recipients: row.recipients,
    tags: row.tags,
    created_at: seconds(row.createdAt),
  };
}

export function suppressionDocument(row: Owned<Pick<SuppressionRow, "id" | "organizationId" | "address" | "createdAt">>): SuppressionDocument {
  return { id: row.id, organization_id: row.organizationId, address: row.address, created_at: seconds(row.createdAt) };
}
