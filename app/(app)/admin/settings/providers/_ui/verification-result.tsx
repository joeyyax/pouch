import { Callout } from "@/components/ui/callout";

/** `true` means the adapter checked and passed; `null` means it can't check itself. A failed check never gets here. */
export function VerificationResult({ verified, adapterLabel }: { verified: boolean | null; adapterLabel: string }) {
  if (verified === true) {
    return (
      <Callout tone="success" title="Verified">
        {adapterLabel} confirmed these credentials work.
      </Callout>
    );
  }

  return (
    <Callout tone="warn" title="Stored, not verified">
      {adapterLabel} can&apos;t check credentials on its own. This provider&apos;s health comes from send outcomes instead.
    </Callout>
  );
}
