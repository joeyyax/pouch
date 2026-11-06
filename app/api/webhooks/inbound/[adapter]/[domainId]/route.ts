import { ApiError } from "@/lib/api/errors";
import { errorResponse, json, readCapped } from "@/lib/api/response";
import { receiveInbound } from "@/lib/inbound/ingest";
import { withRequestId } from "@/lib/api/request-context";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ adapter: string; domainId: string }>;
}

async function post(request: Request, context: Context): Promise<Response> {
  try {
    const { adapter, domainId } = await context.params;
    // The raw bytes, before any parsing: the signature covers these and nothing else.
    const rawBody = await readCapped(request);
    const signed = { rawBody, headers: Object.fromEntries(request.headers) };

    const outcome = await receiveInbound(adapter, domainId, signed);
    if (!outcome.verified) {
      // Same envelope a bad signature on a known domain gets, so probing can't tell an unknown
      // domain from a known one with the wrong key.
      throw new ApiError("invalid_signature", "This event isn't signed with the key on file for this domain.");
    }

    return json({ accepted: outcome.result?.accepted ?? 0, duplicates: outcome.result?.duplicates ?? 0 });
  } catch (error) {
    return errorResponse(error);
  }
}

export const POST = withRequestId(post);
