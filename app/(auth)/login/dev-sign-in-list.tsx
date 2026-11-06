"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import type { DevAccountKey } from "@/lib/dev/seed-accounts";
import { recordSignInAction } from "./actions";
import { signInDevAccountAction } from "./dev-sign-in-action";
import type { DevAccountOption } from "@/lib/dev/accounts";

/**
 * Development only, additive to the form above it. Each row signs in through the same
 * `signIn.email` path the form uses — `signInDevAccountAction` calls `auth.api.signInEmail`
 * with the seeded dev password, never a session minted by hand — so `recordSignInAction`
 * fires the same way and the activity log stays honest.
 */
export function DevSignInList({ accounts }: { accounts: DevAccountOption[] }) {
  const router = useRouter();
  const [pendingKey, setPendingKey] = useState<DevAccountKey | null>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (accounts.length === 0) return null;

  function signInAs(key: DevAccountKey) {
    setError(null);
    setPendingKey(key);
    startTransition(async () => {
      const result = await signInDevAccountAction(key);
      if (!result.ok) {
        setError("That dev account isn't seeded. Run `pnpm dev:data`.");
        setPendingKey(null);
        return;
      }
      void recordSignInAction();
      router.push("/");
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-6">
      <p className="text-2xs text-muted-foreground">Dev accounts</p>
      <div className="flex flex-col gap-2">
        {accounts.map((account) => (
          <button
            key={account.key}
            type="button"
            disabled={pending}
            onClick={() => signInAs(account.key)}
            className={cn(
              "flex w-full items-center justify-between rounded-lg border border-border px-3 py-2 text-left transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            <span className="flex flex-col">
              <span className="type-body-sm font-medium text-foreground">{account.name}</span>
              <span className="text-2xs text-muted-foreground">
                {account.org} · {account.role}
              </span>
            </span>
            {pending && pendingKey === account.key ? <span className="text-2xs text-muted-foreground">Signing in…</span> : null}
          </button>
        ))}
      </div>
      {error ? <p className="text-2xs text-danger">{error}</p> : null}
    </div>
  );
}
