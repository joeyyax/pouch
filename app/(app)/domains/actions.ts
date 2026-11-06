"use server";

import { revalidatePath } from "next/cache";
import { brand } from "@/lib/brand";
import { redirect } from "next/navigation";
import { ApiError } from "@/lib/api/errors";
import { consumeRateLimit } from "@/lib/api/rate-limit";
import { requireOrganizationWrite, sessionActor } from "@/lib/dashboard/session";
import { createDomain, deleteDomain, domainFor, moveDomain, setBulkAllowed, setDomainLayout, verifyDomain } from "@/lib/domains";
import { applyDnsPlan, applyPendingDnsPlan } from "@/lib/domains/dns-apply";
import { removeDnsProvenance } from "@/lib/domains/dns-cleanup";
import { releaseDomainStall } from "@/lib/domains/stall";
import { dbNow } from "@/lib/db/clock";
import { layoutValueSchema, type LayoutPatch } from "@/lib/domains/layout";
import { uploadDomainLogo } from "@/lib/domains/logo-upload";
import { acceptDashboardMessage } from "@/lib/messages/create";
import { sendEmailSchema } from "@/lib/schemas/email";
import { ZodError } from "zod";
import { createDomainSchema } from "@/lib/schemas/domain";
import type { ActionState } from "@/lib/dashboard/action-state";
import { failed, rateLimited, succeeded } from "@/lib/dashboard/action-state";

/** A short, friendly canned body — this card no longer takes an editable one. */
const DEFAULT_TEST_HTML = `<p>This is a test message from ${brand.name}. If it's in your inbox, delivery works.</p>`;

/** Keeps someone from hammering a domain's real provider (or the quick-retest buttons) in a loop. */
const TEST_SEND_LIMIT_PER_MINUTE = 5;

/** A dashboard session reaches every domain in its organization. Every write comes through here. */
async function caller(action: string) {
  const session = await requireOrganizationWrite(action);
  return { organizationId: session.organizationId, domainIds: [] as string[], actor: sessionActor(session) };
}


export async function addDomainAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const scope = await caller("add a domain");
  const name = String(form.get("name") ?? "").trim();
  const providerId = String(form.get("providerId") ?? "");

  let id: string;
  try {
    // Blank binds to the organization's assigned provider.
    const parsed = createDomainSchema.parse({ name, provider_id: providerId || undefined });
    const domain = await createDomain(scope, parsed);
    id = domain.id;
  } catch (error) {
    if (error instanceof ZodError) {
      return { status: "error", message: error.issues[0]?.message ?? "That domain isn't valid.", field: "name" };
    }
    return failed(error, `${name} couldn't be added.`);
  }

  revalidatePath("/domains");
  redirect(`/domains/${id}/setup`);
}

export async function verifyDomainAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  // Reads from the provider, but records the answer on the domain — status and missing records.
  const scope = await caller("re-check this domain's verification");
  const id = String(form.get("id") ?? "");

  try {
    const domain = await verifyDomain(scope, id);
    revalidatePath(`/domains/${id}`, "layout");
    revalidatePath("/domains");
    if (domain.status === "verified") {
      return succeeded(`${domain.name} is verified.`);
    }
    const missing = domain.missing_records.length;
    return succeeded(
      missing > 0
        ? `${missing} of ${domain.dns_records.length} records still missing on ${domain.name}.`
        : `${domain.name} is still ${domain.status}.`,
    );
  } catch (error) {
    return failed(error, "The provider couldn't be asked about this domain.");
  }
}

/**
 * Publishes every step of the domain's reconciliation plan that isn't already correct or a
 * conflict. Idempotent: an already-applied or already-correct step is a no-op, so this is also
 * the retry — clicking it again picks up only what's still outstanding. See lib/domains/dns-apply.ts.
 */
export async function applyDnsPlanAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const scope = await caller("write DNS records for this domain");
  const id = String(form.get("id") ?? "");

  let result;
  try {
    result = await applyDnsPlan(scope, id);
  } catch (error) {
    return failed(error, "The records couldn't be published.");
  }

  revalidatePath(`/domains/${id}`, "layout");

  if (result.status === "no_account") return failed(new ApiError("not_found", "No DNS provider account is connected."), "Nothing was published.");
  if (result.status === "zone_not_found") {
    return failed(new ApiError("not_found", "The connected DNS provider account has no zone for this domain."), "Nothing was published.");
  }
  if (result.status === "unreachable") return failed(new ApiError("provider_unavailable", result.detail ?? "Couldn't reach the DNS provider."), "Nothing was published.");

  const applied = result.steps.filter((step) => step.status === "applied").length;
  const skipped = result.steps.filter((step) => step.status === "skipped").length;
  const conflicts = result.steps.filter((step) => step.status === "conflict").length;
  const failedSteps = result.steps.filter((step) => step.status === "failed");

  if (applied === 0 && failedSteps.length === 0) {
    return succeeded(conflicts > 0 ? `Nothing to publish. ${conflicts} ${conflicts === 1 ? "record needs" : "records need"} a human — see the record list.` : "Already published.");
  }

  const parts = [`${applied + skipped} of ${result.steps.length} published.`];
  if (failedSteps.length > 0) {
    const first = failedSteps[0]!;
    parts.push(`${first.record.name} failed: ${first.error}.`);
    if (failedSteps.length > 1) parts.push(`${failedSteps.length - 1} more failed. Retry to finish.`);
  }
  if (conflicts > 0) parts.push(`${conflicts} ${conflicts === 1 ? "conflict needs" : "conflicts need"} a human.`);

  return failedSteps.length > 0 ? failed(new ApiError("provider_unavailable", parts.join(" ")), parts.join(" ")) : succeeded(parts.join(" "));
}

/**
 * Same as `applyDnsPlanAction`, for a pending provider move's required records (#212):
 * publishes them alongside whatever the current provider still has published. A domain with no
 * move in progress has nothing to publish here.
 */
export async function applyPendingDnsPlanAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const scope = await caller("write DNS records for this domain's pending move");
  const id = String(form.get("id") ?? "");

  let result;
  try {
    result = await applyPendingDnsPlan(scope, id);
  } catch (error) {
    return failed(error, "The records couldn't be published.");
  }

  revalidatePath(`/domains/${id}`, "layout");

  if (result.status === "no_account") return failed(new ApiError("not_found", "No DNS provider account is connected."), "Nothing was published.");
  if (result.status === "zone_not_found") {
    return failed(new ApiError("not_found", "The connected DNS provider account has no zone for this domain."), "Nothing was published.");
  }
  if (result.status === "unreachable") return failed(new ApiError("provider_unavailable", result.detail ?? "Couldn't reach the DNS provider."), "Nothing was published.");

  const applied = result.steps.filter((step) => step.status === "applied").length;
  const skipped = result.steps.filter((step) => step.status === "skipped").length;
  const conflicts = result.steps.filter((step) => step.status === "conflict").length;
  const failedSteps = result.steps.filter((step) => step.status === "failed");

  if (applied === 0 && failedSteps.length === 0) {
    return succeeded(conflicts > 0 ? `Nothing to publish. ${conflicts} ${conflicts === 1 ? "record needs" : "records need"} a human — see the record list.` : "Already published.");
  }

  const parts = [`${applied + skipped} of ${result.steps.length} published.`];
  if (failedSteps.length > 0) {
    const first = failedSteps[0]!;
    parts.push(`${first.record.name} failed: ${first.error}.`);
    if (failedSteps.length > 1) parts.push(`${failedSteps.length - 1} more failed. Retry to finish.`);
  }
  if (conflicts > 0) parts.push(`${conflicts} ${conflicts === 1 ? "conflict needs" : "conflicts need"} a human.`);

  return failedSteps.length > 0 ? failed(new ApiError("provider_unavailable", parts.join(" ")), parts.join(" ")) : succeeded(parts.join(" "));
}

/**
 * Removes every DNS record this domain's provenance still holds and can safely remove — a
 * separate, explicit action from delete, gated on its own confirmation in the UI
 * (dns-cleanup-view.tsx). See lib/domains/dns-cleanup.ts for what "safely" means.
 */
export async function removeDnsCleanupAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const scope = await caller("remove DNS records for this domain");
  const id = String(form.get("id") ?? "");

  let result;
  try {
    result = await removeDnsProvenance(scope, id);
  } catch (error) {
    return failed(error, "The records couldn't be removed.");
  }

  revalidatePath(`/domains/${id}`, "layout");

  if (result.status === "no_account") return failed(new ApiError("not_found", "No DNS provider account is connected."), "Nothing was removed.");
  if (result.status === "zone_not_found") {
    return failed(new ApiError("not_found", "The connected DNS provider account has no zone for this domain."), "Nothing was removed.");
  }
  if (result.status === "unreachable") return failed(new ApiError("provider_unavailable", result.detail ?? "Couldn't reach the DNS provider."), "Nothing was removed.");

  const removed = result.steps.filter((step) => step.outcome === "removed").length;
  const refused = result.steps.filter((step) => step.outcome === "refused").length;
  const failedSteps = result.steps.filter((step) => step.outcome === "failed");

  if (removed === 0 && failedSteps.length === 0) {
    return succeeded(refused > 0 ? `Nothing removed. ${refused} ${refused === 1 ? "record has" : "records have"} changed since ${brand.name} wrote it — left alone.` : "Nothing to remove.");
  }

  const parts = [`${removed} of ${result.steps.length} removed.`];
  if (failedSteps.length > 0) {
    const first = failedSteps[0]!;
    parts.push(`${first.name} failed: ${first.error}.`);
    if (failedSteps.length > 1) parts.push(`${failedSteps.length - 1} more failed. Retry to finish.`);
  }
  if (refused > 0) parts.push(`${refused} left alone — changed since ${brand.name} wrote it.`);

  return failedSteps.length > 0 ? failed(new ApiError("provider_unavailable", parts.join(" ")), parts.join(" ")) : succeeded(parts.join(" "));
}

/**
 * Same as `removeDnsCleanupAction`, scoped to the previous provider's provenance (#212): the
 * dismissible cleanup a completed provider move offers, never automatic — cutover itself
 * (`worker/verify.ts`) never calls this or `removeDnsProvenance`.
 */
export async function removePreviousAccountCleanupAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const scope = await caller("remove DNS records for this domain's previous provider");
  const id = String(form.get("id") ?? "");

  let result;
  try {
    result = await removeDnsProvenance(scope, id, "previous_account");
  } catch (error) {
    return failed(error, "The records couldn't be removed.");
  }

  revalidatePath(`/domains/${id}`, "layout");

  if (result.status === "no_account") return failed(new ApiError("not_found", "No DNS provider account is connected."), "Nothing was removed.");
  if (result.status === "zone_not_found") {
    return failed(new ApiError("not_found", "The connected DNS provider account has no zone for this domain."), "Nothing was removed.");
  }
  if (result.status === "unreachable") return failed(new ApiError("provider_unavailable", result.detail ?? "Couldn't reach the DNS provider."), "Nothing was removed.");

  const removed = result.steps.filter((step) => step.outcome === "removed").length;
  const refused = result.steps.filter((step) => step.outcome === "refused").length;
  const failedSteps = result.steps.filter((step) => step.outcome === "failed");

  if (removed === 0 && failedSteps.length === 0) {
    return succeeded(refused > 0 ? `Nothing removed. ${refused} ${refused === 1 ? "record has" : "records have"} changed since ${brand.name} wrote it — left alone.` : "Nothing to remove.");
  }

  const parts = [`${removed} of ${result.steps.length} removed.`];
  if (failedSteps.length > 0) {
    const first = failedSteps[0]!;
    parts.push(`${first.name} failed: ${first.error}.`);
    if (failedSteps.length > 1) parts.push(`${failedSteps.length - 1} more failed. Retry to finish.`);
  }
  if (refused > 0) parts.push(`${refused} left alone — changed since ${brand.name} wrote it.`);

  return failedSteps.length > 0 ? failed(new ApiError("provider_unavailable", parts.join(" ")), parts.join(" ")) : succeeded(parts.join(" "));
}

export async function moveDomainAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const scope = await caller("move a domain to a different provider");
  const id = String(form.get("id") ?? "");
  const targetProviderId = String(form.get("providerId") ?? "");

  let domain;
  try {
    domain = await moveDomain(scope, id, targetProviderId);
  } catch (error) {
    return failed(error, "The move couldn't be started.");
  }

  revalidatePath(`/domains/${id}`, "layout");
  revalidatePath("/domains");
  return succeeded(`Moving ${domain.name} — publish the new records to finish.`);
}

export async function cancelMoveAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const scope = await caller("cancel a domain move");
  const id = String(form.get("id") ?? "");

  let domain;
  try {
    domain = await moveDomain(scope, id, null);
  } catch (error) {
    return failed(error, "The move couldn't be cancelled.");
  }

  revalidatePath(`/domains/${id}`, "layout");
  revalidatePath("/domains");
  return succeeded(`Move cancelled. ${domain.name} keeps sending where it is.`);
}

export async function deleteDomainAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const scope = await caller("delete a domain");
  const id = String(form.get("id") ?? "");

  try {
    await deleteDomain(scope, id);
  } catch (error) {
    return failed(error, "The domain couldn't be deleted.");
  }

  revalidatePath("/domains");
  redirect("/domains");
}

export async function releaseStallAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const scope = await caller("resume sending");
  const id = String(form.get("id") ?? "");

  let domain;
  try {
    domain = await releaseDomainStall(scope.organizationId, id, scope.actor, await dbNow());
  } catch (error) {
    return failed(error, "The pause couldn't be released.");
  }

  revalidatePath(`/domains/${id}`, "layout");
  revalidatePath("/domains");
  return succeeded(`${domain.name} is sending again.`);
}

export async function setBulkAllowedAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const scope = await caller("turn on bulk sending for this domain");
  const id = String(form.get("id") ?? "");
  const allowed = form.get("allowed") === "true";

  let domain;
  try {
    domain = await setBulkAllowed(scope, id, allowed);
  } catch (error) {
    return failed(error, `Bulk sending couldn't be ${allowed ? "turned on" : "turned off"} for this domain.`);
  }

  revalidatePath(`/domains/${id}`, "layout");
  return succeeded(allowed ? `Bulk sending turned on for ${domain.name}.` : `Bulk sending turned off for ${domain.name}.`);
}

export async function saveLayoutAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const scope = await caller("change this domain's layout");
  const id = String(form.get("id") ?? "");
  const clearing = form.get("clear") === "true";

  let patch: LayoutPatch = null;
  if (!clearing) {
    // The capability checks the same schema; this pass only words the error for the form.
    const parsed = layoutValueSchema.safeParse({
      name: form.get("brandName") ?? "",
      logo: String(form.get("logoUrl") ?? "").trim() || null,
      accent: form.get("accent") ?? "",
      footer: form.get("footer") ?? "",
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const key = String(issue?.path[0] ?? "");
      return {
        status: "error",
        message: issue ? `${issue.message.charAt(0).toUpperCase()}${issue.message.slice(1)}.` : "That layout isn't valid.",
        ...(LAYOUT_FORM_FIELD[key] ? { field: LAYOUT_FORM_FIELD[key] } : {}),
      };
    }
    patch = parsed.data;
  }

  try {
    await setDomainLayout(scope, id, patch);
  } catch (error) {
    return failed(error, "The layout couldn't be saved.");
  }
  revalidatePath(`/domains/${id}`, "layout");
  return succeeded(clearing ? "Layout removed. Sends from this domain render with no frame." : "Layout saved.");
}

/** The layout form's input names, by the API's field names. */
const LAYOUT_FORM_FIELD: Record<string, string> = { name: "brandName", logo: "logoUrl", accent: "accent", footer: "footer" };

/** `logoUrl` carries the uploaded file's public URL back to the form on success. */
export type LogoUploadState = ActionState & { logoUrl?: string };

export async function uploadLayoutLogoAction(_previous: LogoUploadState, form: FormData): Promise<LogoUploadState> {
  const scope = await caller("upload a logo");
  const id = String(form.get("id") ?? "");

  const file = form.get("logo");
  if (!(file instanceof File) || file.size === 0) {
    return { status: "error", message: "Choose a PNG to upload.", field: "logo" };
  }

  try {
    const domain = await domainFor(scope, id);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const logoUrl = await uploadDomainLogo(domain.id, bytes);
    return { status: "ok", message: "Logo uploaded.", logoUrl };
  } catch (error) {
    return failed(error, "The logo couldn't be uploaded.");
  }
}

export async function sendTestEmailAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await requireOrganizationWrite("send a test email");
  const { organizationId, email } = session;
  const domainId = String(form.get("domainId") ?? "");

  // Look up name from the database — the form supplies only the id.
  const domain = await domainFor({ organizationId, domainIds: [], actor: sessionActor(session) }, domainId).catch(() => null);
  if (!domain) {
    return failed(new ApiError("not_found", "That domain isn't in this organization.", { field: "domainId" }), "The test email couldn't be queued.");
  }

  // Scoped per domain, not per key: this is the operator clicking a button, not the API.
  const limit = await consumeRateLimit(`dashboard-test:${organizationId}:${domainId}`, TEST_SEND_LIMIT_PER_MINUTE);
  if (limit.exceeded) {
    const retrySeconds = Math.max(1, Math.ceil(limit.retryAfterMs / 1000));
    return rateLimited(`Try again in ${retrySeconds}s.`, limit.retryAfterMs);
  }

  const from = `noreply@${domain.name}`;
  const to = String(form.get("to") ?? "").trim() || email;
  const subject = `Test email from ${domain.name}`;
  const layout = form.get("layout") === "on" || form.get("layout") === "true";

  let parsed;
  try {
    parsed = sendEmailSchema.parse({
      from,
      to: [to],
      subject,
      html: DEFAULT_TEST_HTML,
      layout,
      tags: ["dashboard-test"],
    });
  } catch (error) {
    if (error instanceof ZodError) {
      const issue = error.issues[0];
      return {
        status: "error",
        message: issue ? `Field "${issue.path.join(".")}" ${issue.message}.` : "That test email isn't valid.",
        ...(issue?.path[0] ? { field: String(issue.path[0]) } : {}),
      };
    }
    throw error;
  }

  try {
    const { message } = await acceptDashboardMessage(organizationId, parsed, null);
    revalidatePath(`/domains/${domainId}`, "layout");
    revalidatePath("/messages");
    return succeeded("Test email queued.", `/messages/${message.id}`);
  } catch (error) {
    return failed(error, "The test email couldn't be queued.");
  }
}

export type { ActionState };
export { ApiError };