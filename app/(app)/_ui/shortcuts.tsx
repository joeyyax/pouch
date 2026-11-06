"use client";

import { ShortcutSheet } from "@/components/ui/shortcut-sheet";

/** `?` from any dashboard screen. */
export function AppShortcuts() {
  return (
    <ShortcutSheet
      groups={[
        {
          title: "Anywhere",
          shortcuts: [
            { keys: ["?"], label: "Show shortcuts" },
            { keys: ["/"], label: "Search messages" },
          ],
        },
        {
          title: "Lists",
          shortcuts: [
            { keys: ["Tab"], label: "Into or out of the list" },
            { keys: ["↑", "↓"], label: "Previous or next row" },
            { keys: ["Home", "End"], label: "First or last row" },
            { keys: ["←", "→"], label: "Links and buttons in the row" },
            { keys: ["Enter"], label: "Open the row" },
          ],
        },
        {
          title: "Open detail",
          shortcuts: [
            { keys: ["K", "↑"], label: "Previous" },
            { keys: ["J", "↓"], label: "Next" },
            { keys: ["Esc"], label: "Close and return to the row" },
          ],
        },
      ]}
    />
  );
}
