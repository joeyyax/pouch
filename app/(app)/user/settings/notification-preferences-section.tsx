"use client";

import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import type { NotificationPreferenceView } from "@/lib/notifications/preferences";
import { useAction } from "../../_ui/use-action";
import { updateNotificationPreferenceAction } from "./actions";

/** One switch per type. A type the operator turned off reads off and can't change. */
export function NotificationPreferencesSection({ preferences }: { preferences: NotificationPreferenceView[] }) {
  const [on, setOn] = useState(() => new Map(preferences.map((preference) => [preference.type, preference.on])));
  const update = useAction(updateNotificationPreferenceAction);

  function toggle(type: string, checked: boolean) {
    setOn((current) => new Map(current).set(type, checked));
    const form = new FormData();
    form.set("type", type);
    form.set("on", String(checked));
    update.formAction(form);
  }

  return (
    <Card className="overflow-hidden p-0">
      <ul>
        {preferences.map(({ type, label, description, available }) => (
          <li key={type} className="flex items-center justify-between gap-4 border-b border-border p-5 last:border-b-0">
            <div className="min-w-0">
              <p className="font-semibold text-foreground">{label}</p>
              <p className="type-body-sm text-muted-foreground">
                {available ? description : `${description} Turned off for everyone on this install.`}
              </p>
            </div>
            <Switch
              checked={available && (on.get(type) ?? true)}
              onCheckedChange={(checked) => toggle(type, checked)}
              disabled={!available || update.pending}
              aria-label={`${label} email`}
            />
          </li>
        ))}
      </ul>
    </Card>
  );
}
