/**
 * The hosted unsubscribe page (#7) — where a bulk message's `List-Unsubscribe` header points.
 * Public, no session. GET asks, so a link scanner opening it unsubscribes nobody; the page's
 * buttons POST a `scope`, and a mail client's RFC 8058 one-click POST unsubscribes from the list
 * with no page. Dispatches on the token's id prefix: a list-backed batch signs a membership id
 * (`lmb_`), an inline-recipient batch signs a message id (`msg_`) — see lib/lists/tokens.ts.
 */
import { withRequestId } from "@/lib/api/request-context";
import { hostedPage, html, PLAIN_BRAND, readPost, type HostedPageInput, type PageAction, type PageBrand } from "@/lib/hosted-page";
import { domainPageBrand } from "@/lib/domains/page-brand";
import { readUnsubscribeToken, redeemUnsubscribeToken } from "@/lib/lists/unsubscribe";
import { readMessageUnsubscribeToken, redeemMessageUnsubscribeToken } from "@/lib/bulk/unsubscribe";
import { logger } from "@/lib/logger";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("lists:unsubscribe-page");

type Scope = "list" | "domain";

interface Context {
  params: Promise<{ token: string }>;
}

/** Read without redeeming. A message token has no list behind it, so its only scope is the domain. */
interface Link {
  address: string;
  listName: string | null;
  domainId: string;
  domainName: string;
  unsubscribed: boolean;
  domainStopped: boolean;
}

function isMessageToken(token: string): boolean {
  return token.startsWith("msg_");
}

async function read(token: string): Promise<Link | null> {
  if (isMessageToken(token)) {
    const link = await readMessageUnsubscribeToken(token);
    return link ? { ...link, listName: null, unsubscribed: link.domainStopped } : null;
  }
  return readUnsubscribeToken(token);
}

async function redeem(token: string, scope: Scope): Promise<void> {
  if (isMessageToken(token)) await redeemMessageUnsubscribeToken(token);
  else await redeemUnsubscribeToken(token, scope);
}

const FORGED: HostedPageInput = {
  tone: "invalid",
  title: "This unsubscribe link isn't valid",
  body: ["Use the unsubscribe link in a recent email, or reply to the sender and ask to be taken off."],
  brand: PLAIN_BRAND,
};

/** A domain unsubscribe stops bulk, not transactional, so the page says so rather than promising silence it won't deliver. */
const STILL_ARRIVES = "Receipts, password resets and other mail about your account still arrive.";

function sender(brand: PageBrand, link: Link): string {
  return brand.kind === "domain" ? brand.name : link.domainName;
}

function stopAll(brand: PageBrand, link: Link): PageAction {
  return { label: `Stop all bulk mail from ${sender(brand, link)}`, fields: { scope: "domain" }, quiet: true };
}

function page(link: Link, brand: PageBrand, did: Scope | null): HostedPageInput {
  const who = html`<strong>${link.address}</strong>`;
  const from = sender(brand, link);

  if (link.domainStopped) {
    return {
      tone: did ? "success" : "done",
      title: did ? `You won't get bulk mail from ${from}` : "You're already unsubscribed",
      body: [html`${who} gets no bulk mail from ${from}.`, STILL_ARRIVES],
      brand,
    };
  }

  if (link.listName === null) {
    return {
      tone: "question",
      title: `Stop bulk mail from ${from}?`,
      body: [html`${who} stops getting bulk mail from ${from}.`, STILL_ARRIVES],
      actions: [{ label: "Unsubscribe", fields: { scope: "domain" } }],
      brand,
    };
  }

  const list = html`<strong>${link.listName}</strong>`;
  if (link.unsubscribed) {
    return {
      tone: did ? "success" : "done",
      title: did ? "You're unsubscribed" : "You're already unsubscribed",
      body: [html`${who} won't get ${list} again.`],
      actions: [stopAll(brand, link)],
      brand,
    };
  }

  return {
    tone: "question",
    title: `Unsubscribe from ${link.listName}?`,
    body: [html`${who} stops getting ${list} from ${from}.`],
    actions: [{ label: "Unsubscribe", fields: { scope: "list" } }, stopAll(brand, link)],
    brand,
  };
}

async function render(token: string, scope: Scope | null): Promise<Response> {
  let brand: PageBrand = PLAIN_BRAND;
  try {
    let link = await read(token);
    if (!link) return hostedPage(FORGED, 404);
    brand = (await domainPageBrand(link.domainId)) ?? PLAIN_BRAND;
    if (scope) {
      await redeem(token, scope);
      link = { ...link, unsubscribed: true, domainStopped: link.domainStopped || scope === "domain" || isMessageToken(token) };
    }
    return hostedPage(page(link, brand, scope), 200);
  } catch (error) {
    log.error(`unsubscribe page failed: ${safeErrorMessage(error)}`);
    return hostedPage({ tone: "error", title: "You weren't unsubscribed", body: ["Nothing changed. Try the link again in a minute."], brand }, 500);
  }
}

async function get(_request: Request, { params }: Context): Promise<Response> {
  return render((await params).token, null);
}

/** A person pressing a button posts `scope`; a mail client's one-click is always list scope and gets no body. */
async function post(request: Request, { params }: Context): Promise<Response> {
  const { token } = await params;
  const { oneClick, fields } = await readPost(request);
  if (oneClick || !fields.has("scope")) {
    try {
      const link = await read(token);
      if (!link) return new Response(null, { status: 404 });
      await redeem(token, "list");
      return new Response(null, { status: 200 });
    } catch {
      return new Response(null, { status: 500 });
    }
  }
  return render(token, fields.get("scope") === "domain" ? "domain" : "list");
}

export const GET = withRequestId<[Context]>(get);
export const POST = withRequestId<[Context]>(post);
