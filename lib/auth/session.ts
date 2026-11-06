import { headers } from "next/headers";
import { auth } from "./index";

export async function getSession() {
  return auth.api.getSession({ headers: await headers() });
}

/** Returns the session, or null when nobody is signed in. Route handlers redirect on null. */
export async function requireSession() {
  const session = await getSession();
  if (!session?.user?.id) return null;
  return session;
}
