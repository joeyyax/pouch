"use server";

import { revalidatePath } from "next/cache";
import { adminActor } from "@/lib/activity/record";
import { requireAdmin } from "@/lib/auth/admin";
import { failed, succeeded, type ActionState } from "@/lib/dashboard/action-state";
import { featureAction } from "@/lib/dashboard/feature-action";
import { normalizeAddress } from "@/lib/addresses";
import { isSettingKey, settingDef } from "@/lib/settings/registry";
import { setSetting } from "@/lib/settings/values";
import { resolveSystemSender, resolveSystemSenderFor, SystemMailNotConfiguredError } from "@/lib/mail/system";
import { setDefaultForNewOrganizations } from "@/lib/providers/shared";
import { setReportHost, verifyReportHost } from "@/lib/dmarc/host";
import { parseAlertRecipients, setSystemAlertsTo, setSystemFromAddress } from "@/lib/settings/service";

const PATH = "/admin/settings/general";
const REPUTATION_PATH = "/admin/settings/reputation";
const LOCAL_PART_FIELD = "localPart";
const DOMAIN_FIELD = "domain";
const PROVIDER_FIELD = "providerId";
const ALERTS_FIELD = "alertsTo";
const REPORT_HOST_FIELD = "host";
const REPORT_PROVIDER_FIELD = "providerId";

/** Sets the address Pouch's own mail sends from, from a local part and a verified domain. */
export async function setSystemFromAddressAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  await requireAdmin();
  const localPart = String(form.get(LOCAL_PART_FIELD) ?? "").trim();
  const domain = String(form.get(DOMAIN_FIELD) ?? "").trim();

  if (domain === "" && localPart !== "") {
    return { status: "error", message: "Pick the domain to send from.", field: DOMAIN_FIELD };
  }
  if (domain !== "" && localPart === "") {
    return { status: "error", message: "Enter the part before the @.", field: LOCAL_PART_FIELD };
  }
  const address = domain === "" ? null : normalizeAddress(`${localPart}@${domain}`);

  try {
    // An address that can't send is refused rather than stored.
    if (address) await resolveSystemSenderFor(address);
    await setSystemFromAddress(address);
  } catch (error) {
    if (error instanceof SystemMailNotConfiguredError) {
      return { status: "error", message: error.message, field: LOCAL_PART_FIELD };
    }
    return failed(error, "The system from address couldn't be saved.");
  }
  revalidatePath(PATH);

  try {
    const sender = await resolveSystemSender();
    return succeeded(`System mail now sends from ${sender.fromAddress}, in ${sender.organizationName}.`);
  } catch (error) {
    if (error instanceof SystemMailNotConfiguredError) return { status: "error", message: `Saved. ${error.message}` };
    return failed(error, "Saved, but system mail still has nowhere to send from.");
  }
}

/** Sets where system alerts go. An empty value sends them to the system from address. */
export async function setSystemAlertsToAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  await requireAdmin();
  const parsed = parseAlertRecipients(String(form.get(ALERTS_FIELD) ?? ""));
  if (!parsed.ok) return { status: "error", message: parsed.message, field: ALERTS_FIELD };

  try {
    await setSystemAlertsTo(parsed.addresses);
  } catch (error) {
    return failed(error, "The system alert recipients couldn't be saved.");
  }
  revalidatePath(PATH);
  return succeeded(
    parsed.addresses.length === 0 ? "System alerts go to the system from address." : `System alerts go to ${parsed.addresses.join(", ")}.`,
  );
}

/** Sets the DMARC report host and the provider that receives it. An empty host clears it and takes the route down. */
export const setDmarcReportHostAction = featureAction("dmarc_reports", async function setDmarcReportHostAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  await requireAdmin();
  const host = String(form.get(REPORT_HOST_FIELD) ?? "").trim();
  const providerId = String(form.get(REPORT_PROVIDER_FIELD) ?? "").trim();

  let verified = false;
  try {
    await setReportHost({ host: host === "" ? null : host, providerId: providerId === "" ? null : providerId });
    verified = host !== "" && Boolean((await verifyReportHost())?.verified);
  } catch (error) {
    return failed(error, "The report host couldn't be saved.");
  }
  revalidatePath(REPUTATION_PATH);
  if (host === "") return succeeded("DMARC reports are off. The report route is down.");
  return succeeded(verified ? `Reports go to ${host}. Domains now get its address in their DMARC record.` : `Saved. Publish the records for ${host}, then check again.`);
});

/** Checks the report host's records again. */
export const checkDmarcReportHostAction = featureAction("dmarc_reports", async function checkDmarcReportHostAction(_previous: ActionState): Promise<ActionState> {
  await requireAdmin();
  let verified = false;
  try {
    verified = Boolean((await verifyReportHost())?.verified);
  } catch (error) {
    return failed(error, "The report host's records couldn't be checked.");
  }
  revalidatePath(REPUTATION_PATH);
  return verified ? succeeded("Every record checks out.") : { status: "error", message: "Not every record checks out yet." };
});

/** Points new organizations at a shared provider. An empty value clears it. */
export async function setDefaultProviderAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  await requireAdmin();
  const raw = String(form.get(PROVIDER_FIELD) ?? "").trim();

  try {
    await setDefaultForNewOrganizations(raw === "" ? null : raw);
  } catch (error) {
    return failed(error, "The default provider couldn't be saved.");
  }
  revalidatePath(PATH);
  return succeeded(raw === "" ? "New organizations wait for an admin to assign a provider." : "Default provider saved.");
}

/** Sets one value in the settings registry for the whole install. */
export async function setSettingAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await requireAdmin();
  const key = String(form.get("key") ?? "");
  if (!isSettingKey(key)) return { status: "error", message: `There's no setting called "${key}".` };
  const def = settingDef(key);

  try {
    await setSetting(key, String(form.get("value") ?? ""), adminActor(session.user.id, session.user.name ?? session.user.email ?? "Admin"));
  } catch (error) {
    return failed(error, `${def.label} couldn't be saved.`);
  }
  // Every screen's nav reads the features.
  revalidatePath("/", "layout");
  if (def.type === "boolean") return succeeded(`${def.label} turned ${form.get("value") === "true" ? "on" : "off"}.`);
  return succeeded(`${def.label} saved.`);
}
