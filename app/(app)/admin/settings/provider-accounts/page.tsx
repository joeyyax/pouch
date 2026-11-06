import { permanentRedirect } from "next/navigation";

export default function ProviderAccountsPage() {
  permanentRedirect("/admin/settings/providers");
}
