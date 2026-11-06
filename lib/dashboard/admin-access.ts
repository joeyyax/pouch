/** Lines Admin settings → General shows under the Access entries. */
import { runningSessionDays } from "@/lib/auth/session-length";
import { SIGN_IN_SETTINGS, strandedIfTurnedOff, type SignInMethod } from "@/lib/auth/sign-in-methods";
import { systemMailReady } from "@/lib/mail/system";
import type { SettingKey } from "@/lib/settings/registry";
import { readSetting } from "@/lib/settings/values";

type Note = { text: string; warning: boolean };

function accounts(count: number): string {
  return count === 1 ? "1 account" : `${count} accounts`;
}

export async function accessNotes(): Promise<Partial<Record<SettingKey, Note>>> {
  const [stranded, mailReady, sessionDays] = await Promise.all([strandedIfTurnedOff(), systemMailReady(), readSetting("session_days")]);
  const notes: Partial<Record<SettingKey, Note>> = {};

  for (const [method, count] of Object.entries(stranded) as [SignInMethod, number][]) {
    if (count > 0) notes[SIGN_IN_SETTINGS[method]] = { text: `${accounts(count)} sign in only this way. Turning it off leaves them no way in.`, warning: true };
  }
  if (!mailReady) {
    notes.sign_in_magic_link = { text: "System mail isn't set up, so /login doesn't offer links.", warning: true };
  }
  const running = runningSessionDays();
  if (running !== sessionDays) {
    notes.session_days = { text: `New sessions last ${running} ${running === 1 ? "day" : "days"} until the app restarts.`, warning: false };
  }
  return notes;
}
