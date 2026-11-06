"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ZodError } from "zod";
import type { ProviderRow } from "@/lib/providers";
import {
  assignOrganization,
  createAdminProvider,
  deleteAdminProvider,
  probeProvider,
  setupAdminProvider,
  unassignOrganization,
  updateAdminProvider,
} from "@/lib/providers/admin";
import { adminProviderRow } from "@/lib/providers/admin-read";
import { adminProviderKind } from "@/lib/providers/admin-serialize";
import { ConversionStoppedError, convertToTenant, type ConversionStage } from "@/lib/providers/convert";
import { adoptDomainForOrganization } from "@/lib/domains";
import { adoptDomainSchema } from "@/lib/schemas/domain";
import { adminActor } from "@/lib/activity/record";
import type { ActivityActor } from "@/lib/activity/types";
import { ApiError } from "@/lib/api/errors";
import { requireAdmin } from "@/lib/auth/admin";
import { failed, succeeded, type ActionState } from "@/lib/dashboard/action-state";
import { capabilitiesOf } from "@/lib/providers/adapters";
import { parseAdmin, patchAdminProviderSchema } from "@/lib/schemas/admin";

const LIST = "/admin/settings/providers";

async function operatorActor(): Promise<ActivityActor> {
  const session = await requireAdmin();
  return adminActor(session.user.id, session.user.name ?? session.user.email ?? "Admin");
}

async function providerFrom(form: FormData): Promise<ProviderRow> {
  return adminProviderRow(String(form.get("id") ?? ""));
}

function revalidate(id?: string): void {
  revalidatePath(LIST);
  if (id) revalidatePath(`${LIST}/${id}`);
  revalidatePath("/admin/settings/organizations");
}

/** Reads `cred_<field>` entries. Blank ones are dropped. */
function credentialsFromForm(form: FormData): Record<string, string> {
  const credentials: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (key.startsWith("cred_") && typeof value === "string" && value.trim() !== "") {
      credentials[key.slice("cred_".length)] = value;
    }
  }
  return credentials;
}

function zodFailed(error: unknown, fallback: string): ActionState {
  if (error instanceof ZodError) {
    const issue = error.issues[0];
    return {
      status: "error",
      message: issue ? `Field "${issue.path.join(".") || "value"}" isn't valid: ${issue.message}.` : fallback,
      ...(issue?.path[0] ? { field: String(issue.path[0]) } : {}),
    };
  }
  return failed(error, fallback);
}

const SETUP_UNFINISHED = "Setup finishes once SNS confirms the subscription.";

/** What the result panel shows once, after a write that touched credentials. */
export type CredentialWriteState =
  | ActionState
  | { status: "created"; id: string; name: string; verified: boolean | null; configured: boolean }
  | { status: "rotated"; verified: boolean | null };

export async function createProviderAction(_previous: CredentialWriteState, form: FormData): Promise<CredentialWriteState> {
  const actor = await operatorActor();
  const adapterName = String(form.get("adapter") ?? "");
  const name = String(form.get("name") ?? "").trim();
  if (!name) return { status: "error", message: 'Field "name" is required.', field: "name" };

  const organizationId = String(form.get("organizationId") ?? "");

  try {
    if (!capabilitiesOf(adapterName).sharing && !organizationId) {
      return { status: "error", message: 'Field "organization" is required.', field: "organizationId" };
    }
    const { provider, verified, configured } = await createAdminProvider(
      {
        adapter: adapterName,
        name,
        credentials: credentialsFromForm(form),
        ...(organizationId ? { organization_id: organizationId } : {}),
      },
      { actor },
    );
    revalidate();
    return { status: "created", id: provider.id, name: provider.name, verified, configured };
  } catch (error) {
    return failed(error, `Provider ${name} couldn't be added.`);
  }
}

export async function rotateCredentialsAction(_previous: CredentialWriteState, form: FormData): Promise<CredentialWriteState> {
  const actor = await operatorActor();
  try {
    const provider = await providerFrom(form);
    const patch = parseAdmin(patchAdminProviderSchema, { credentials: credentialsFromForm(form) });
    const { verified } = await updateAdminProvider(provider, patch, { actor });
    revalidate(provider.id);
    return { status: "rotated", verified: verified ?? null };
  } catch (error) {
    return failed(error, "The credentials couldn't be replaced.");
  }
}

export async function renameProviderAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const actor = await operatorActor();
  try {
    const provider = await providerFrom(form);
    const patch = parseAdmin(patchAdminProviderSchema, { name: form.get("name") });
    await updateAdminProvider(provider, patch, { actor });
    revalidate(provider.id);
    return succeeded(`Renamed to ${patch.name}.`);
  } catch (error) {
    return failed(error, "The provider couldn't be renamed.");
  }
}

export async function setWebhookKeyAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const actor = await operatorActor();
  try {
    const provider = await providerFrom(form);
    const key = String(form.get("webhookPublicKey") ?? "").trim();
    if (!key) return { status: "error", message: 'Field "webhook key" is required.', field: "webhookPublicKey" };
    await updateAdminProvider(provider, { settings: { webhookPublicKey: key } }, { actor });
    revalidate(provider.id);
    return succeeded("Webhook key saved.");
  } catch (error) {
    return failed(error, "The webhook key couldn't be saved.");
  }
}

export async function deleteProviderAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const actor = await operatorActor();
  try {
    await deleteAdminProvider(await providerFrom(form), { actor });
  } catch (error) {
    return failed(error, "The provider couldn't be deleted.");
  }

  // Redirect, not a client push: the action's own re-render of this detail route hits
  // notFound() for the row that's gone, and the 404 wins the race.
  revalidate();
  redirect(LIST);
}

export type TestProviderState = ActionState | { status: "tested"; ok: boolean | null; detail: string | null };

export async function testProviderAction(_previous: TestProviderState, form: FormData): Promise<TestProviderState> {
  await operatorActor();
  try {
    const provider = await adminProviderRow(String(form.get("id") ?? ""));
    const health = await probeProvider(provider);
    revalidate(provider.id);
    return { status: "tested", ok: health.ok, detail: health.detail };
  } catch (error) {
    return failed(error, "The provider couldn't be tested.");
  }
}

export async function runSetupAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  await operatorActor();
  try {
    const provider = await providerFrom(form);
    const configured = await setupAdminProvider(provider);
    revalidate(provider.id);
    return succeeded(configured ? "Setup is finished." : `Setup ran. ${SETUP_UNFINISHED}`);
  } catch (error) {
    return failed(error, "Setup couldn't be run.");
  }
}

export async function assignOrganizationAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const actor = await operatorActor();
  try {
    const provider = await providerFrom(form);
    await assignOrganization(provider.id, String(form.get("organizationId") ?? ""), {}, { actor });
    revalidate(provider.id);
    return succeeded("Organization assigned. Its first domain sets up its space at the provider.");
  } catch (error) {
    return failed(error, "The organization couldn't be assigned.");
  }
}

export async function unassignOrganizationAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const actor = await operatorActor();
  try {
    const provider = await providerFrom(form);
    await unassignOrganization(provider, String(form.get("organizationId") ?? ""), { actor });
    revalidate(provider.id);
    return succeeded("Organization unassigned.");
  } catch (error) {
    return failed(error, "The organization couldn't be unassigned.");
  }
}

export type ConvertState =
  | ActionState
  | { status: "converted"; reached: ConversionStage | null; suppressionsCopied: number }
  | { status: "stopped"; stage: ConversionStage; reached: ConversionStage | null; message: string };

export async function convertProviderAction(_previous: ConvertState, form: FormData): Promise<ConvertState> {
  const actor = await operatorActor();
  try {
    const provider = await providerFrom(form);
    if (adminProviderKind(provider) !== "legacy") throw new ApiError("validation_failed", `${provider.name} isn't a legacy provider.`);
    const result = await convertToTenant(provider.id, { actor });
    revalidate(provider.id);
    return { status: "converted", reached: result.reached, suppressionsCopied: result.suppressionsCopied };
  } catch (error) {
    if (error instanceof ConversionStoppedError) {
      revalidate(String(form.get("id") ?? ""));
      const cause = error.cause instanceof Error ? error.cause.message : "The provider call failed.";
      return { status: "stopped", stage: error.stage, reached: error.reached, message: cause };
    }
    return failed(error, "The conversion couldn't start.");
  }
}

export type AdoptDomainState =
  | ActionState
  | { status: "adopted"; name: string; verified: boolean; organizationName: string };

/** Admin-only. An organization key adding the same domain still gets `domain_unavailable`. */
export async function adoptDomainAction(_previous: AdoptDomainState, form: FormData): Promise<AdoptDomainState> {
  const actor = await operatorActor();
  const organizationName = String(form.get("organizationName") ?? "The organization");
  try {
    const request = adoptDomainSchema.parse({
      name: form.get("name"),
      organization_id: form.get("organizationId"),
      provider_id: form.get("providerId"),
    });
    const domain = await adoptDomainForOrganization(request, actor);
    revalidate(String(form.get("id") ?? ""));
    revalidatePath("/domains");
    return { status: "adopted", name: domain.name, verified: domain.status === "verified", organizationName };
  } catch (error) {
    return zodFailed(error, "The domain couldn't be adopted.");
  }
}
