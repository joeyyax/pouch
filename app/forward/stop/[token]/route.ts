/**
 * Where a forward's stop link and List-Unsubscribe header point. GET asks first; POST stops, which
 * is also the RFC 8058 one-click request a mail client sends.
 */
import { withRequestId } from "@/lib/api/request-context";
import { hostedPage, html, readPost, type HostedPageInput } from "@/lib/hosted-page";
import { readForwardStop, stopForwardTarget } from "@/lib/addresses/forward-targets";
import { logger } from "@/lib/logger";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("forward:stop");

interface Context {
  params: Promise<{ token: string }>;
}

const GONE: HostedPageInput = {
  tone: "done",
  title: "Nothing forwards from this link",
  body: ["The forward it stops was removed, or the link was cut short. Open the stop link in a recent forward to check."],
};

const FAILED: HostedPageInput = {
  tone: "error",
  title: "Forwarding wasn't stopped",
  body: ["Forwards keep arriving until it is. Try the link again in a minute."],
};

function off(found: { address: string; email: string }): HostedPageInput["body"] {
  return [
    html`Mail sent to <strong>${found.address}</strong> no longer forwards to <strong>${found.email}</strong>.`,
    "Turning it back on takes a new confirmation, sent by whoever set up the forward.",
  ];
}

async function get(_request: Request, { params }: Context): Promise<Response> {
  const { token } = await params;
  try {
    const found = await readForwardStop(token);
    if (!found) return hostedPage(GONE, 404);
    if (found.status === "disabled") return hostedPage({ tone: "done", title: "Forwarding is already off", body: off(found) }, 200);
    return hostedPage(
      {
        tone: "question",
        title: "Stop these forwards?",
        body: [html`Mail sent to <strong>${found.address}</strong> stops forwarding to <strong>${found.email}</strong>. Mail already in your inbox stays.`],
        actions: [{ label: "Stop forwarding" }],
      },
      200,
    );
  } catch (error) {
    log.error(`forward stop page failed: ${safeErrorMessage(error)}`);
    return hostedPage(FAILED, 500);
  }
}

async function post(request: Request, { params }: Context): Promise<Response> {
  const { token } = await params;
  const { oneClick } = await readPost(request);
  try {
    const stopped = await stopForwardTarget(token);
    if (oneClick) return new Response(null, { status: stopped ? 200 : 404 });
    if (!stopped) return hostedPage(GONE, 404);
    return hostedPage({ tone: "success", title: "Forwarding is off", body: off(stopped) }, 200);
  } catch (error) {
    log.error(`forward stop failed: ${safeErrorMessage(error)}`);
    if (oneClick) return new Response(null, { status: 500 });
    return hostedPage(FAILED, 500);
  }
}

export const GET = withRequestId<[Context]>(get);
export const POST = withRequestId<[Context]>(post);
