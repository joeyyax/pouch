import { errorResponse } from "@/lib/api/response";
import { receive } from "@/lib/webhooks/receive";
import { withRequestId } from "@/lib/api/request-context";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ adapter: string; providerId: string }>;
}

async function post(request: Request, context: Context): Promise<Response> {
  try {
    const { adapter, providerId } = await context.params;
    return await receive(adapter, providerId, request);
  } catch (error) {
    return errorResponse(error);
  }
}

export const POST = withRequestId(post);
