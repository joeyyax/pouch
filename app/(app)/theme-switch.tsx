"use client";

import { useEffect, useState } from "react";
import { FOCUS_RING } from "@/components/ui/focus-ring";
import { cn } from "@/lib/utils";

type Theme = "light" | "dark" | "system";

const OPTIONS: { value: Theme; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "Auto" },
];

const DARK = "(prefers-color-scheme: dark)";

function stored(): Theme {
  try {
    const value = localStorage.getItem("theme");
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

function apply(theme: Theme): void {
  const dark = theme === "dark" || (theme === "system" && matchMedia(DARK).matches);
  document.documentElement.classList.toggle("dark", dark);
}

/** Light, dark or the system's choice, kept in the same `theme` key `THEME_INIT` reads. */
export function ThemeSwitch() {
  // Mounted only while the menu is open, so never on the server.
  const [theme, setTheme] = useState<Theme>(stored);

  useEffect(() => {
    if (theme !== "system") return;
    const query = matchMedia(DARK);
    const follow = () => apply("system");
    query.addEventListener("change", follow);
    return () => query.removeEventListener("change", follow);
  }, [theme]);

  function choose(next: Theme) {
    try {
      if (next === "system") localStorage.removeItem("theme");
      else localStorage.setItem("theme", next);
    } catch {}
    apply(next);
    setTheme(next);
  }

  return (
    <div role="radiogroup" aria-label="Theme" className="flex gap-0.5 rounded-xl bg-muted p-0.5">
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={theme === option.value}
          onClick={() => choose(option.value)}
          className={cn(
            "flex-1 rounded-[10px] px-2 py-1 text-xs font-semibold transition-colors pointer-coarse:min-h-11",
            FOCUS_RING,
            theme === option.value ? "bg-card text-foreground shadow-card" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
