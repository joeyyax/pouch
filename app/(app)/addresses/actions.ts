"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ZodError } from "zod";
import type { OrganizationKeyRow } from "@/lib/api/keys";
import { isEmailAddress, normalizeAddress } from "@/lib/addresses";
import { FORWARD_TARGET_LIMIT } from "@/lib/addresses/constants";
import { addForwardTarget } from "@/lib/addresses/forward-targets";
import { addressCallerFor, createAddress, organizationKeyFor, revokeAddress, updateAddress, type AddressCaller } from "@/lib/addresses/manage";
import { createAddressSchema, updateAddressSchema } from "@/lib/schemas/address";
import { requireOrganizationWrite } from "@/lib/dashboard/session";
import { failed, succeeded, type ActionState } from "@/lib/dashboard/action-state";
import { featureAction } from "@/lib/dashboard/feature-action";

/** A session reaches every domain in its organization. */
async function caller(action: string): Promise<AddressCaller> {
  const session = await requireOrganizationWrite(action);
  return { organizationId: session.organizationId, domainIds: [], apiKeyId: null };
}

function refresh(id: string): void {
  revalidatePath("/addresses");
  revalidatePath(`/addresses/${id}`);
}

/** A schema message as a sentence, for the field it renders under. */
function sentence(message: string): string {
  const text = message.charAt(0).toUpperCase() + message.slice(1);
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function optional(form: FormData, name: string): string | undefined {
  const value = String(form.get(name) ?? "").trim();
  return value === "" ? undefined : value;
}

/** One mailbox per line or comma, deduplicated. */
function forwardTargetsFrom(form: FormData): string[] | ActionState {
  const listed = String(form.get("forward_to") ?? "").split(/[\n,]/).map((value) => normalizeAddress(value.trim())).filter(Boolean);
  // The capability refuses a second target that differs only in case.
  const emails = listed.filter((email, index) => listed.findIndex((other) => other.toLowerCase() === email.toLowerCase()) === index);
  if (emails.length > FORWARD_TARGET_LIMIT) {
    return { status: "error", message: `Up to ${FORWARD_TARGET_LIMIT} mailboxes. ${emails.length} are listed.`, field: "forward_to" };
  }
  const invalid = emails.find((email) => !isEmailAddress(email));
  if (invalid) return { status: "error", message: `${invalid} isn't a valid address.`, field: "forward_to" };
  return emails;
}

/**
 * Creates the address as the chosen key, through the capability `POST /v1/addresses` calls, then
 * adds each mailbox the way `POST /v1/addresses/:id/forward_targets` does. The address answers to that key.
 */
export const createAddressAction = featureAction("addresses", async function createAddressAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await requireOrganizationWrite("create an address");
  const keyId = optional(form, "key_id");
  if (!keyId) return { status: "error", message: "Choose the key the address answers to.", field: "key_id" };
  if (!optional(form, "domain_id")) return { status: "error", message: "Choose a domain.", field: "domain_id" };
  const targets = forwardTargetsFrom(form);
  if (!Array.isArray(targets)) return targets;

  let id: string;
  let key: OrganizationKeyRow;
  try {
    key = await organizationKeyFor(session.organizationId, keyId);
    const cap = optional(form, "message_cap");
    const request = createAddressSchema.parse({
      domain_id: optional(form, "domain_id"),
      local_part: optional(form, "local_part"),
      label: optional(form, "label"),
      expires_in: Number(form.get("expires_in")),
      message_cap: cap === undefined ? undefined : Number(cap),
    });
    id = (await createAddress(addressCallerFor(key), request)).id;
  } catch (error) {
    if (error instanceof ZodError) {
      const issue = error.issues[0];
      return { status: "error", message: issue ? sentence(issue.message) : "The address couldn't be created.", ...(issue?.path[0] ? { field: String(issue.path[0]) } : {}) };
    }
    return failed(error, "The address couldn't be created.");
  }

  // The address exists from here on. A mailbox that can't be added is reported on its page.
  let forwardError: string | null = null;
  for (const email of targets) {
    try {
      await addForwardTarget(key, id, { email });
    } catch (error) {
      const outcome = failed(error, `${email} couldn't be added.`);
      forwardError = outcome.status === "error" ? outcome.message : null;
      break;
    }
  }

  revalidatePath("/addresses");
  redirect(forwardError ? `/addresses/${id}?${new URLSearchParams({ forward_error: forwardError }).toString()}` : `/addresses/${id}`);
});

export const extendAddressAction = featureAction("addresses", async function extendAddressAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const owner = await caller("extend an address");
  const id = String(form.get("id") ?? "");
  const seconds = Number(form.get("expires_in"));
  if (!Number.isInteger(seconds) || seconds <= 0) return { status: "error", message: "Choose how long it stays open.", field: "expires_in" };
  try {
    const address = await updateAddress(owner, id, updateAddressSchema.parse({ expires_in: seconds }));
    refresh(id);
    return succeeded(`${address.address} extended.`);
  } catch (error) {
    if (error instanceof ZodError) return { status: "error", message: "That expiry is out of range.", field: "expires_in" };
    return failed(error, "The address couldn't be extended.");
  }
});

export const revokeAddressAction = featureAction("addresses", async function revokeAddressAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const owner = await caller("revoke an address");
  const id = String(form.get("id") ?? "");
  try {
    const address = await revokeAddress(owner, id);
    refresh(id);
    return succeeded(`${address.address} revoked.`);
  } catch (error) {
    return failed(error, "The address couldn't be revoked.");
  }
});
