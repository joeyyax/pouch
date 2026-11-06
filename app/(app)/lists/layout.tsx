import type { ReactNode } from "react";
import { requireFeaturePage } from "@/lib/dashboard/feature-guard";

export default async function Layout({ children }: { children: ReactNode }) {
  await requireFeaturePage("lists");
  return children;
}
