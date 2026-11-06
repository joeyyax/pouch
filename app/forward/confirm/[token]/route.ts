/**
 * Where a forward target's confirmation link lands. GET only shows what's being asked, so a link
 * scanner opening it confirms nothing; the button POSTs.
 */
import { withRequestId } from "@/lib/api/request-context";
import { hostedPage, html, type HostedPageInput } from "@/lib/hosted-page";
import { confirmForwardTarget, readForwardLink, type ForwardConsent } from "@/lib/addresses/forward-targets";
import { logger } from "@/lib/logger";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("forward:confirm");

interface Context {
  params: Promise<{ token: string }>;
}

const INVALID: HostedPageInput = {
  tone: "invalid",
  title: "This link doesn't work anymore",
  body: ["It expired, or the forward it confirms was removed. Ask whoever set up the forward to send a new link."],
};

const FAILED: HostedPageInput = {
  tone: "error",
  title: "Forwarding wasn't confirmed",
  body: ["Nothing changed. Try the link again in a minute."],
};

function on(consent: ForwardConsent): HostedPageInput["body"] {
  return [html`Mail sent to <strong>${consent.address}</strong> forwards to <strong>${consent.email}</strong>.`, "Every forward has a link at the bottom to stop them."];
}

async function respond(work: () => Promise<Response>): Promise<Response> {
  try {
    return await work();
  } catch (error) {
    log.error(`forward confirmation failed: ${safeErrorMessage(error)}`);
    return hostedPage(FAILED, 500);
  }
}

async function get(_request: Request, { params }: Context): Promise<Response> {
  const { token } = await params;
  return respond(async () => {
    const link = await readForwardLink(token);
    if (!link) return hostedPage(INVALID, 404);
    if (link.state === "confirmed") return hostedPage({ tone: "done", title: "Forwarding is already on", body: on(link.consent) }, 200);
    const { consent } = link;
    return hostedPage(
      {
        tone: "question",
        title: "Forward this mail to you?",
        body: [
          html`${consent.requester} wants to forward mail sent to <strong>${consent.address}</strong> to <strong>${consent.email}</strong>.`,
          "Replies you send go straight to the sender, from your own mailbox. Every forward has a link to stop them.",
        ],
        actions: [{ label: "Confirm forwarding" }],
        footer: "Not expecting this? Close this page and nothing forwards.",
      },
      200,
    );
  });
}

async function post(_request: Request, { params }: Context): Promise<Response> {
  const { token } = await params;
  return respond(async () => {
    const link = await readForwardLink(token);
    if (!link) return hostedPage(INVALID, 404);
    if (link.state === "confirmed") return hostedPage({ tone: "done", title: "Forwarding is already on", body: on(link.consent) }, 200);
    const consent = await confirmForwardTarget(token);
    if (!consent) return hostedPage(INVALID, 404);
    return hostedPage({ tone: "success", title: "Forwarding is on", body: on(consent) }, 200);
  });
}

export const GET = withRequestId<[Context]>(get);
export const POST = withRequestId<[Context]>(post);
