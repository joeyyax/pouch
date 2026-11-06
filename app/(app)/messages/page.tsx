import { requireOrganization } from "@/lib/dashboard/session";
import { listMessagePage, listTags, withFuzzySearch } from "@/lib/dashboard/messages";
import type { MessageListItem } from "@/lib/dashboard/views/messages";
import type { DayCount } from "@/lib/dashboard/views/days";
import { messageVolume } from "@/lib/dashboard/message-volume";
import { firstVerifiedDomain, listDomainNames } from "@/lib/dashboard/domains";
import { listKeyFilterOptions } from "@/lib/dashboard/keys";
import { KEY_PLACEHOLDER, sendSnippets, type SnippetLanguage } from "@/lib/dashboard/curl";
import { logger } from "@/lib/logger";
import { MessagesScreen } from "./messages-screen";
import { readMessagesQuery, type SearchParams } from "@/lib/messages/query";
import { safeErrorMessage } from "@/lib/errors/scrub";

export const dynamic = "force-dynamic";

const log = logger.child("dashboard:messages");

/**
 * Loads a page of the list. A query that fails leaves the chrome standing and hands the
 * table an error to show, because the operator can still change the filters that caused it.
 */
export async function loadMessages(
  organizationId: string,
  params: SearchParams,
  zone: string,
): Promise<{
  rows: MessageListItem[];
  offset: number;
  hasOlder: boolean;
  volume: DayCount[];
  failed: boolean;
  searchDegraded: boolean;
}> {
  const query = readMessagesQuery(params);
  try {
    const { filters, searchDegraded } = await withFuzzySearch(organizationId, query.filters);
    const [page, volume] = await Promise.all([
      listMessagePage(organizationId, filters, query.cursor),
      messageVolume(organizationId, filters, zone),
    ]);
    return { ...page, volume, failed: false, searchDegraded };
  } catch (err) {
    log.error(`listing messages failed: ${safeErrorMessage(err)}`);
    return { rows: [], offset: 0, hasOlder: false, volume: [], failed: true, searchDegraded: false };
  }
}

/** The send the empty state offers, once a verified domain exists to send from. */
export async function loadFirstSend(organizationId: string): Promise<SnippetLanguage[] | null> {
  const domain = await firstVerifiedDomain(organizationId).catch(() => null);
  return domain ? sendSnippets(KEY_PLACEHOLDER, domain) : null;
}

/** Tags the filter can offer: whatever the current scope's messages actually carry. */
export async function loadTagOptions(organizationId: string, params: SearchParams): Promise<string[]> {
  const { filters } = readMessagesQuery(params);
  try {
    return await listTags(organizationId, { domain: filters.domain, since: filters.since });
  } catch (err) {
    log.error(`listing tags failed: ${safeErrorMessage(err)}`);
    return [];
  }
}

export default async function MessagesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { organizationId, timeZone } = await requireOrganization();
  const params = await searchParams;
  const query = readMessagesQuery(params);
  const [{ rows, offset, hasOlder, volume, failed, searchDegraded }, firstSend, tagOptions, domainNames, keyOptions] = await Promise.all([
    loadMessages(organizationId, params, timeZone),
    loadFirstSend(organizationId),
    loadTagOptions(organizationId, params),
    listDomainNames(organizationId),
    listKeyFilterOptions(organizationId),
  ]);

  return (
    <MessagesScreen
      rows={rows}
      volume={volume}
      offset={offset}
      hasOlder={hasOlder}
      failed={failed}
      searchDegraded={searchDegraded}
      query={query}
      firstSend={firstSend}
      tagOptions={tagOptions}
      domainNames={domainNames}
      keyOptions={keyOptions}
    />
  );
}
