import { auth } from "@/lib/auth";
import { PASSKEY_OPTIONS_PATH, requireUserVerification } from "@/lib/auth/passkey";
import { guardMagicLinkRequest, REQUEST_MAGIC_LINK_PATH } from "@/lib/auth/magic-link";
import { guardPasswordResetRequest, REQUEST_PASSWORD_RESET_PATH } from "@/lib/auth/password-reset";
import { withRequestId } from "@/lib/api/request-context";

export const dynamic = "force-dynamic";

async function get(request: Request): Promise<Response> {
  if (new URL(request.url).pathname === PASSKEY_OPTIONS_PATH) return requireUserVerification(await auth.handler(request));
  return auth.handler(request);
}

async function post(request: Request): Promise<Response> {
  if (new URL(request.url).pathname === REQUEST_PASSWORD_RESET_PATH) {
    const refused = await guardPasswordResetRequest(request);
    if (refused) return refused;
  }
  if (new URL(request.url).pathname === REQUEST_MAGIC_LINK_PATH) {
    const refused = await guardMagicLinkRequest(request);
    if (refused) return refused;
  }
  return auth.handler(request);
}

export const GET = withRequestId(get);
export const POST = withRequestId(post);
