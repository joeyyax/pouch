import type { ReactNode } from "react";
import { requireFeaturePage } from "@/lib/dashboard/feature-guard";

export default async function Layout({ children }: { children: ReactNode }) {
  await requireFeaturePage("addresses");
  return children;
}
