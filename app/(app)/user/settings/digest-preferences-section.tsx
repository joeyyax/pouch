"use client";

import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import type { DigestPreferencesView } from "@/lib/mail/digest/preferences";
import { useAction } from "../../_ui/use-action";
import { updateDigestPreferencesAction } from "./actions";

const CADENCES: { key: keyof DigestPreferencesView; label: string; description: string }[] = [
  { key: "daily", label: "Daily", description: "Yesterday's volume and anything that failed." },
  { key: "weekly", label: "Weekly", description: "Volume against the prior week, bounce and complaint rates and what changed. On by default." },
  { key: "monthly", label: "Monthly", description: "The same shape, over a month." },
];

/** Admin-only: a digest spans every organization, so it's the admin's preference, not an owner's. */
export function DigestPreferencesSection({ preferences }: { preferences: DigestPreferencesView }) {
  const [pending, setPending] = useState(preferences);
  const update = useAction(updateDigestPreferencesAction);

  function toggle(key: keyof DigestPreferencesView, checked: boolean) {
    const next = { ...pending, [key]: checked };
    setPending(next);
    const form = new FormData();
    form.set("daily", String(next.daily));
    form.set("weekly", String(next.weekly));
    form.set("monthly", String(next.monthly));
    update.formAction(form);
  }

  return (
    <Card className="overflow-hidden p-0">
      <ul>
        {CADENCES.map(({ key, label, description }) => (
          <li key={key} className="flex items-center justify-between gap-4 border-b border-border p-5 last:border-b-0">
            <div className="min-w-0">
              <p className="font-semibold text-foreground">{label}</p>
              <p className="type-body-sm text-muted-foreground">{description}</p>
            </div>
            <Switch
              checked={pending[key]}
              onCheckedChange={(checked) => toggle(key, checked)}
              disabled={update.pending}
              aria-label={`${label} digest`}
            />
          </li>
        ))}
      </ul>
    </Card>
  );
}
