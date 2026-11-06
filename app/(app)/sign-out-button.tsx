"use client";

import { useRouter } from "next/navigation";
import { signOut } from "@/lib/auth/client";
import { recordSignOutAction } from "../(auth)/login/actions";

export function SignOutButton({ className = "underline underline-offset-4" }: { className?: string }) {
  const router = useRouter();

  return (
    <button
      type="button"
      onClick={async () => {
        // Recorded before the session is destroyed — the session that names who's signing out.
        await recordSignOutAction();
        await signOut();
        router.push("/login");
        router.refresh();
      }}
      className={className}
    >
      Sign out
    </button>
  );
}
