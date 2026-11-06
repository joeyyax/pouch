/**
 * Where a digest's `List-Unsubscribe` header points. Public, no session. GET asks, so a link
 * scanner turns nothing off; the button POSTs, and so does a mail client's RFC 8058 one-click.
 */
import { withRequestId } from "@/lib/api/request-context";
import { baseUrl } from "@/lib/api/urls";
import { hostedPage, html, readPost, type HostedPageInput } from "@/lib/hosted-page";
import { logger } from "@/lib/logger";
import { InvalidUnsubscribeTokenError, readUnsubscribeToken, redeemUnsubscribeToken } from "@/lib/mail/digest/unsubscribe";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("mail:digest-unsubscribe");

interface Context {
  params: Promise<{ token: string }>;
}

function settings() {
  return html`<a href="${baseUrl()}/user/settings">your account settings</a>`;
}

function invalid(): HostedPageInput {
  return { tone: "invalid", title: "This link isn't valid", body: [html`Turn digests off in ${settings()} instead.`] };
}

const FAILED: HostedPageInput = { tone: "error", title: "The digest wasn't turned off", body: ["Nothing changed. Try the link again in a minute."] };

async function get(_request: Request, { params }: Context): Promise<Response> {
  const { token } = await params;
  try {
    const found = await readUnsubscribeToken(token);
    if (!found) return hostedPage(invalid(), 404);
    const who = html`<strong>${found.email}</strong>`;
    if (!found.on) {
      return hostedPage({ tone: "done", title: `The ${found.cadence} digest is already off`, body: [html`${who} doesn't get it. Turn it back on in ${settings()}.`] }, 200);
    }
    return hostedPage(
      {
        tone: "question",
        title: `Turn off the ${found.cadence} digest?`,
        body: [html`${who} stops getting the ${found.cadence} digest. Turn it back on any time in ${settings()}.`],
        actions: [{ label: "Turn off the digest" }],
      },
      200,
    );
  } catch (error) {
    log.error(`digest unsubscribe page failed: ${safeErrorMessage(error)}`);
    return hostedPage(FAILED, 500);
  }
}

async function post(request: Request, { params }: Context): Promise<Response> {
  const { token } = await params;
  const { oneClick } = await readPost(request);
  try {
    const result = await redeemUnsubscribeToken(token);
    if (oneClick) return new Response(null, { status: 200 });
    return hostedPage(
      { tone: "success", title: `The ${result.cadence} digest is off`, body: [html`<strong>${result.email}</strong> won't get it again. Turn it back on in ${settings()}.`] },
      200,
    );
  } catch (err) {
    const status = err instanceof InvalidUnsubscribeTokenError ? 404 : 500;
    if (status === 500) log.error(`digest unsubscribe failed: ${safeErrorMessage(err)}`);
    if (oneClick) return new Response(null, { status });
    return hostedPage(status === 404 ? invalid() : FAILED, status);
  }
}

export const GET = withRequestId<[Context]>(get);
export const POST = withRequestId<[Context]>(post);
