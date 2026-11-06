/**
 * Bodies as a .zip of .eml files, one per message, matching the messages screen's current
 * filter. A message whose body has aged out of retention still gets an entry — its .eml
 * carries the reason in its headers and in place of the body text — so the archive's file
 * count always matches the message count and nothing reads as silently dropped.
 */
import type { MessageFilters } from "@/lib/messages/filters";
import { retentionDaysFor } from "@/lib/organizations";
import { buildMessageEml, loadExportBody } from "./eml";
import { iterateExportMessages } from "./messages-query";
import { ZipWriter } from "./zip";

/** Keeps entry names unique and filesystem-safe without leaking recipient addresses into them. */
function entryName(messageId: string, index: number): string {
  return `${String(index).padStart(6, "0")}-${messageId}.eml`;
}

export async function* bodiesZipChunks(organizationId: string, filters: MessageFilters): AsyncGenerator<Buffer> {
  const retentionDays = await retentionDaysFor(organizationId);
  const zip = new ZipWriter();
  let index = 0;

  for await (const { message, domainName } of iterateExportMessages(organizationId, filters)) {
    const body = await loadExportBody(message, retentionDays);
    const eml = buildMessageEml(message, domainName, body);
    yield zip.addFile(entryName(message.id, index), Buffer.from(eml, "utf8"), message.createdAt);
    index += 1;
  }

  yield zip.finish();
}
