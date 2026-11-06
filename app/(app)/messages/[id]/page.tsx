import { notFound } from "next/navigation";
import { requireOrganization } from "@/lib/dashboard/session";
import { readMessage } from "@/lib/dashboard/messages";
import { listDomainNames } from "@/lib/dashboard/domains";
import { listKeyFilterOptions } from "@/lib/dashboard/keys";
import { MessagesScreen } from "../messages-screen";
import { loadFirstSend, loadMessages, loadTagOptions } from "../page";
import { readMessagesQuery, type SearchParams } from "@/lib/messages/query";

export const dynamic = "force-dynamic";

export default async function MessagePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { organizationId, timeZone } = await requireOrganization();
  const [{ id }, search] = await Promise.all([params, searchParams]);

  const message = await readMessage(organizationId, id);
  if (!message) notFound();

  const query = readMessagesQuery(search);
  const [{ rows, offset, hasOlder, volume, failed, searchDegraded }, firstSend, tagOptions, domainNames, keyOptions] = await Promise.all([
    loadMessages(organizationId, search, timeZone),
    loadFirstSend(organizationId),
    loadTagOptions(organizationId, search),
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
      open={message}
    />
  );
}
