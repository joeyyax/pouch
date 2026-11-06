import { notFound } from "next/navigation";
import { readAdminProvider } from "@/lib/dashboard/admin-providers";
import { ProviderScreen } from "./provider-screen";

export const dynamic = "force-dynamic";

export default async function ProviderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const provider = await readAdminProvider(id);
  if (!provider) notFound();
  return <ProviderScreen provider={provider} />;
}
