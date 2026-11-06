import { withRequestId } from "@/lib/api/request-context";
import { openInboundDownload } from "@/lib/inbound/downloads";
import { isMessageDownloadToken, openMessageDownload } from "@/lib/messages/downloads";
import { attachmentDisposition } from "@/lib/storage/links";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ token: string }>;
}

/** An attachment or raw message behind a link `GET /v1/inbound/:id` or `GET /v1/emails/:id` minted. The token is the authorization. */
async function get(_request: Request, context: Context): Promise<Response> {
  const { token } = await context.params;
  const opened = isMessageDownloadToken(token) ? await openMessageDownload(token) : await openInboundDownload(token);
  if (!opened) {
    return Response.json(
      { error: { code: "invalid_token", message: "This download link is malformed or has expired. Read the message again for a fresh one." } },
      { status: 404 },
    );
  }
  return new Response(new Uint8Array(opened.content), {
    headers: {
      "content-type": opened.contentType,
      "content-disposition": attachmentDisposition(opened.filename),
      "content-length": String(opened.content.length),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'",
    },
  });
}

export const GET = withRequestId<[Context]>(get);
