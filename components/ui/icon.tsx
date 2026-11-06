import type { ReactNode, SVGProps } from "react";

// The one general-purpose icon registry — every inline outline icon on the
// site renders through this. The hand-drawn annotation marks (circles,
// underlines, strikes, arrows, highlights) are a separate voice and live in
// components/accents.tsx.

export type IconName =
  | "sparkles"
  | "clock"
  | "shield"
  | "eye"
  | "eye-off"
  | "dollar"
  | "zap"
  | "flow"
  | "globe"
  | "file"
  | "search"
  | "owner"
  | "pin"
  | "mail"
  | "chat"
  | "slides"
  | "check"
  | "close"
  | "thumb"
  | "chevron"
  | "star"
  | "play"
  | "pause"
  | "copy"
  | "info"
  | "warning"
  | "danger"
  | "dash"
  | "key"
  | "settings"
  | "inbox"
  | "block"
  | "code"
  | "plus"
  | "home"
  | "more"
  | "list";

const PATHS: Record<IconName, ReactNode> = {
  sparkles: (
    <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3zM19 17l.9 2.1L22 20l-2.1.9L19 23l-.9-2.1L16 20l2.1-.9L19 17z" />
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </>
  ),
  shield: (
    <>
      <path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3v8z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  "eye-off": (
    <>
      <path d="M9.8 5.3C10.5 5.1 11.2 5 12 5c6.5 0 10 7 10 7s-.8 1.6-2.3 3.2" />
      <path d="M14.2 18.7c-.7.2-1.4.3-2.2.3-6.5 0-10-7-10-7s.8-1.6 2.3-3.2" />
      <path d="M14.1 14.1a3 3 0 0 1-4.2-4.2" />
      <path d="m3 3 18 18" />
    </>
  ),
  dollar: (
    <>
      <path d="M12 2v20" />
      <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
    </>
  ),
  zap: <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />,
  flow: (
    <>
      <path d="m22 7-8.5 8.5-5-5L2 17" />
      <path d="M16 7h6v6" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a13 13 0 0 1 0 18a13 13 0 0 1 0-18" />
    </>
  ),
  file: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6M9 13h6M9 17h6" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </>
  ),
  owner: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="m16 11 2 2 4-4" />
    </>
  ),
  pin: (
    <>
      <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z" />
      <circle cx="12" cy="10" r="3" />
    </>
  ),
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3.5 7 8.5 6 8.5-6" />
    </>
  ),
  chat: (
    <path d="M21 11.5a8.4 8.4 0 0 1-11.7 7.8L3 21l1.7-6.3A8.4 8.4 0 1 1 21 11.5z" />
  ),
  slides: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="1.5" />
      <path d="M12 16v3m-3.5 2 3.5-2 3.5 2" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15" r="5" />
      {/* Shaft on the y = 23 − x diagonal; both teeth start on it and run
          perpendicular, which is what reads as a key rather than an arrow. */}
      <path d="m11.6 11.4 9.4-9.4M17 6l3 3M14.5 8.5l3 3" />
    </>
  ),
  settings: (
    <>
      {/* A real cog with rounded lobes, not a circle with spokes — spokes
          read as a sun at 16px, which is where this icon actually lives. */}
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  inbox: (
    <>
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z" />
    </>
  ),
  block: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m5.6 5.6 12.8 12.8" />
    </>
  ),
  check: <path d="m5 13 4 4L19 7" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  dash: <path d="M6 12h12" />,
  thumb: (
    <path d="M7 10v12M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z" />
  ),
  chevron: <path d="m6 9 6 6 6-6" />,
  star: (
    <path d="M12 2.5 14.9 8.7 21.6 9.5 16.8 14.1 18.2 20.8 12 17.3 5.8 20.8 7.2 14.1 2.4 9.5 9.1 8.7 12 2.5Z" />
  ),
  play: <path d="M7 4.5v15l12.5-7.5L7 4.5Z" />,
  pause: (
    <>
      <path d="M7 4.5v15" />
      <path d="M17 4.5v15" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16v-4.5M12 8h.01" />
    </>
  ),
  warning: (
    <>
      <path d="m12 2.5 9.7 17a1.4 1.4 0 0 1-1.2 2.1H3.5a1.4 1.4 0 0 1-1.2-2.1l9.7-17a1.4 1.4 0 0 1 2.4 0Z" />
      <path d="M12 9.5v4.5M12 17.5h.01" />
    </>
  ),
  // An octagon, not a second triangle. `warn` and `danger` differ only in
  // tint, so sharing the warning glyph left the two levels separated by color
  // alone — the octagon is the one road-sign shape that reads as "stop"
  // without needing the color to say it.
  danger: (
    <>
      <path d="M8.6 2.5h6.8L21.5 8.6v6.8L15.4 21.5H8.6L2.5 15.4V8.6L8.6 2.5Z" />
      <path d="M12 7.5v5M12 16h.01" />
    </>
  ),
  code: <path d="m9 18-6-6 6-6M15 6l6 6-6 6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  home: (
    <>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9v11a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1.25" />
      <circle cx="12" cy="12" r="1.25" />
      <circle cx="19" cy="12" r="1.25" />
    </>
  ),
  list: <path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" />,
};

export function Icon({
  name,
  strokeWidth = 2,
  filled = false,
  label,
  className,
  ...props
}: {
  name: IconName;
  /**
   * Makes the icon meaningful rather than decorative — it becomes an image
   * with this as its name. Leave unset when adjacent text already says it,
   * which is the common case and the default.
   */
  label?: string;
  className?: string;
  /** Solid fill instead of outline stroke — used by icons like `star` that
   * need a filled state (e.g. Rating's filled-portion overlay). */
  filled?: boolean;
} & Omit<SVGProps<SVGSVGElement>, "name" | "viewBox" | "fill" | "stroke" | "children">) {
  return (
    <svg
      aria-hidden={label ? undefined : true}
      role={label ? "img" : undefined}
      aria-label={label}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth={filled ? 0 : strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...props}
    >
      {PATHS[name]}
    </svg>
  );
}
