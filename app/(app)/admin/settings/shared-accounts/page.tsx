import { permanentRedirect } from "next/navigation";

export default function SharedAccountsPage() {
  permanentRedirect("/admin/settings/providers");
}
