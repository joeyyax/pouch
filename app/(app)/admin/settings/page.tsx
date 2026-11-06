import { redirect } from "next/navigation";

/** Gives the section room to grow instead of the first screen pretending to be the whole thing. */
export default function AdminSettingsPage() {
  redirect("/admin/settings/general");
}
