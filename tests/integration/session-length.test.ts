/**
 * #565: `session_days` sets how long a new session lasts. Better Auth fixes the length when its
 * instance is built, so the value is read once at start (`loadSessionLength` in `register()`).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { sessions } from "@/lib/db/schema";
import { adminActor } from "@/lib/activity/record";
import { createAccountWithPassword } from "@/lib/auth/provisioning";
import { loadSessionLength, runningSessionDays } from "@/lib/auth/session-length";
import { setSetting } from "@/lib/settings/values";
import { POST } from "@/app/api/auth/[...all]/route";
import { resetDatabase, seedFixture } from "./fixtures";

const ORIGIN = process.env.APP_URL ?? "http://localhost:3100";
const EMAIL = "session@example.net";
const PASSWORD = "correct horse battery staple";
const DAY_MS = 24 * 60 * 60 * 1000;
const ADMIN = adminActor("usr_admin", "Admin");

let userId: string;

async function signIn(): Promise<{ status: number; days: number; cookie: string }> {
  const response = await POST(
    new Request(`${ORIGIN}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    }),
  );
  const [row] = await db.select().from(sessions).where(eq(sessions.userId, userId)).orderBy(desc(sessions.createdAt)).limit(1);
  return {
    status: response.status,
    days: Math.round((row!.expiresAt.getTime() - row!.createdAt.getTime()) / DAY_MS),
    cookie: response.headers.get("set-cookie") ?? "",
  };
}

beforeAll(async () => {
  await resetDatabase();
  // What the app does at start, before anything builds Better Auth.
  await setSetting("session_days", 3, ADMIN);
  expect(await loadSessionLength()).toBe(3);

  const { organizationId } = await seedFixture();
  userId = (await createAccountWithPassword({ email: EMAIL, name: "Session", organizationId, password: PASSWORD, emailVerified: true })).id;
});

describe("session length", () => {
  it("applies to a new session and its cookie", async () => {
    const { status, days, cookie } = await signIn();

    expect(status).toBe(200);
    expect(days).toBe(3);
    expect(cookie).toContain(`Max-Age=${3 * 24 * 60 * 60}`);
  });

  it("waits for a restart: a change after start leaves new sessions at the length the app started with", async () => {
    await setSetting("session_days", 10, ADMIN);

    expect((await signIn()).days).toBe(3);
    expect(runningSessionDays()).toBe(3);
  });

  it("refuses a length outside 1 to 90 days", async () => {
    await expect(setSetting("session_days", 0, ADMIN)).rejects.toMatchObject({ code: "validation_failed" });
    await expect(setSetting("session_days", 91, ADMIN)).rejects.toMatchObject({ code: "validation_failed" });
  });
});
