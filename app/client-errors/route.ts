import { withRequestId } from "@/lib/api/request-context";
import { ingestClientError } from "@/lib/errors/client-ingest";

export const dynamic = "force-dynamic";

export const POST = withRequestId(ingestClientError);
