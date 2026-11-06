import { source } from "@/lib/source";
import { AnchorRedirect } from "./anchor-redirect";

/** The old app reference's anchors, `/reference#post-v1-emails`, mapped to their pages here. */
export function ReferenceAnchors() {
  const targets: Record<string, string> = { smtp: "/smtp/", errors: "/conventions/#errors", base: "/conventions/#base" };
  for (const page of source.getPages()) {
    if (page.slugs[0] === "reference" && page.slugs.length > 2) targets[page.slugs.at(-1)!] = page.url;
  }
  return <AnchorRedirect targets={targets} />;
}
