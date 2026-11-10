"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export function AnchorRedirect({ targets }: { targets: Record<string, string> }) {
  const router = useRouter();
  useEffect(() => {
    const target = targets[window.location.hash.slice(1).toLowerCase()];
    if (target) router.replace(target);
  }, [router, targets]);
  return null;
}
