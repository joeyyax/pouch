"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth/session";
import { isAdmin } from "@/lib/auth/admin";
import { failed, succeeded, type ActionState } from "@/lib/dashboard/action-state";
import {
  CurrentSessionError,
  LastCredentialError,
  NotOwnedError,
  removePasskey,
  revokeOtherSessions,
  revokeSession,
  updateName,
  updateTimeZone,
} from "@/lib/dashboard/user-settings";
import { timeZoneInput } from "@/lib/schemas/user-settings";
import { updateDigestPreferences } from "@/lib/mail/digest/preferences";
import { setNotificationPreference } from "@/lib/notifications/preferences";

/** Every action here scopes to the session making the request — never an id a form field names. */
async function requireUser() {
  const session = await requireSession();
  if (!session) throw new Error("Not signed in.");
  return session;
}

function toState(error: unknown, fallback: string): ActionState {
  if (error instanceof LastCredentialError || error instanceof CurrentSessionError || error instanceof NotOwnedError) {
    return { status: "error", message: error.message };
  }
  return failed(error, fallback);
}

export async function updateNameAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await requireUser();
  const name = String(form.get("name") ?? "").trim();

  if (!name) return { status: "error", message: 'Field "name" is required.', field: "name" };

  try {
    await updateName(session.user.id, name, await headers());
    revalidatePath("/user/settings");
    return succeeded("Name updated.");
  } catch (error) {
    return toState(error, "The name couldn't be updated.");
  }
}

export async function updateTimeZoneAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await requireUser();
  const parsed = timeZoneInput.safeParse(String(form.get("timeZone") ?? ""));
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]!.message, field: "timeZone" };

  try {
    await updateTimeZone(session.user.id, parsed.data);
    // Every screen formats dates in it.
    revalidatePath("/", "layout");
    return succeeded("Time zone updated.");
  } catch (error) {
    return toState(error, "The time zone couldn't be updated.");
  }
}

export async function removePasskeyAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await requireUser();
  const id = String(form.get("id") ?? "");

  try {
    await removePasskey(session.user.id, id, await headers());
    revalidatePath("/user/settings");
    return succeeded("Passkey removed.");
  } catch (error) {
    return toState(error, "The passkey couldn't be removed.");
  }
}

/** Admin-only: a digest spans every organization, so only an admin has one to turn off. */
export async function updateDigestPreferencesAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await requireUser();
  if (!(await isAdmin(session.user.id))) return { status: "error", message: "Not found." };

  try {
    await updateDigestPreferences(session.user.id, {
      daily: form.get("daily") === "true",
      weekly: form.get("weekly") === "true",
      monthly: form.get("monthly") === "true",
    });
    revalidatePath("/user/settings");
    return succeeded("Digest preferences updated.");
  } catch (error) {
    return toState(error, "The digest preferences couldn't be updated.");
  }
}

/** The signed-in person's own email, in every organization they own. */
export async function updateNotificationPreferenceAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await requireUser();

  try {
    await setNotificationPreference(session.user.id, String(form.get("type") ?? ""), form.get("on") === "true");
    revalidatePath("/user/settings");
    return succeeded("Notifications updated.");
  } catch (error) {
    return toState(error, "The notification couldn't be updated.");
  }
}

export async function revokeSessionAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await requireUser();
  const token = String(form.get("token") ?? "");

  try {
    await revokeSession(session.user.id, token, session.session.token, await headers());
    revalidatePath("/user/settings");
    return succeeded("Session revoked.");
  } catch (error) {
    return toState(error, "The session couldn't be revoked.");
  }
}

export async function revokeOtherSessionsAction(_previous: ActionState, _form: FormData): Promise<ActionState> {
  const session = await requireUser();

  try {
    const count = await revokeOtherSessions(session.user.id, session.session.token, await headers());
    revalidatePath("/user/settings");
    return succeeded(count === 1 ? "Signed out 1 other session." : `Signed out ${count} other sessions.`);
  } catch (error) {
    return toState(error, "The other sessions couldn't be signed out.");
  }
}
