/**
 * The hosted double opt-in confirmation page (#7) — where a list confirmation email's link
 * points when the domain has no `confirm_url` of its own. Public, no session. GET asks, so a link
 * scanner opening it confirms nothing; the button POSTs.
 */
import { withRequestId } from "@/lib/api/request-context";
import { hostedPage, html, PLAIN_BRAND, type HostedPageInput, type PageBrand } from "@/lib/hosted-page";
import { domainPageBrand } from "@/lib/domains/page-brand";
import { readConfirmToken, redeemConfirmToken, type ConfirmLink } from "@/lib/lists/opt-in";
import { logger } from "@/lib/logger";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("lists:confirm-page");

interface Context {
  params: Promise<{ token: string }>;
}

const FORGED: HostedPageInput = {
  tone: "invalid",
  title: "This link isn't valid",
  body: ["Open the link from the confirmation email again, and check the whole link made it into the address bar."],
  brand: PLAIN_BRAND,
};

function failed(brand: PageBrand): HostedPageInput {
  return { tone: "error", title: "Your subscription wasn't confirmed", body: ["Nothing changed. Try the link again in a minute."], brand };
}

function page(link: NonNullable<ConfirmLink>, brand: PageBrand, justConfirmed = false): [HostedPageInput, number] {
  const who = html`<strong>${link.address}</strong>`;
  const list = html`<strong>${link.listName}</strong>`;
  switch (link.state) {
    case "pending":
      return [
        {
          tone: "question",
          title: "Confirm your subscription",
          body: [html`${who} joins ${list}.`, "Every email has a link to unsubscribe."],
          actions: [{ label: "Confirm subscription" }],
          brand,
        },
        200,
      ];
    case "subscribed":
      return justConfirmed
        ? [{ tone: "success", title: "You're subscribed", body: [html`${who} now gets ${list}.`, "Every email has a link to unsubscribe."], brand }, 200]
        : [{ tone: "done", title: "You're already subscribed", body: [html`${who} gets ${list}.`], brand }, 200];
    case "expired":
      return [{ tone: "invalid", title: "This link has expired", body: ["Confirmation links last 7 days. Sign up again to get a new one."], brand }, 404];
    case "unsubscribed":
      return [
        { tone: "invalid", title: "This address unsubscribed", body: [html`${who} unsubscribed from ${list} after this link was sent, so it stays off. Sign up again to rejoin.`], brand },
        404,
      ];
  }
}

async function render(token: string, confirm: boolean): Promise<Response> {
  let brand: PageBrand = PLAIN_BRAND;
  try {
    let link = await readConfirmToken(token);
    if (!link) return hostedPage(FORGED, 404);
    brand = (await domainPageBrand(link.domainId)) ?? PLAIN_BRAND;
    if (confirm && link.state === "pending") {
      await redeemConfirmToken(token);
      link = { ...link, state: "subscribed" };
      return hostedPage(...page(link, brand, true));
    }
    return hostedPage(...page(link, brand));
  } catch (error) {
    log.error(`confirm page failed: ${safeErrorMessage(error)}`);
    return hostedPage(failed(brand), 500);
  }
}

async function get(_request: Request, { params }: Context): Promise<Response> {
  return render((await params).token, false);
}

async function post(_request: Request, { params }: Context): Promise<Response> {
  return render((await params).token, true);
}

export const GET = withRequestId<[Context]>(get);
export const POST = withRequestId<[Context]>(post);
