/** The dashboard's theme tokens (app/brand.css) as hex, for surfaces that can't read CSS variables: hosted pages and mail. */
export const PALETTE = {
  light: {
    background: "#f6f7f9",
    card: "#ffffff",
    foreground: "#121a40",
    soft: "#4c5165",
    muted: "#63697f",
    border: "#e8e7f0",
    primary: "#463faa",
    onPrimary: "#ffffff",
    success: "#0b7a46",
    successSoft: "#e3f5ea",
    warning: "#b0430a",
    warningSoft: "#ffece0",
    danger: "#b0303c",
    dangerSoft: "#ffe4dd",
  },
  dark: {
    background: "#0b0d17",
    card: "#131623",
    foreground: "#eef0fb",
    soft: "#8b91ad",
    muted: "#7e84a3",
    border: "#232741",
    primary: "#8081ea",
    onPrimary: "#0b0d17",
    success: "#46d68f",
    successSoft: "#0c3722",
    warning: "#ffa462",
    warningSoft: "#412714",
    danger: "#ff7d87",
    dangerSoft: "#41211c",
  },
} as const;

export const FONT_STACK = `ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif`;

function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** White or ink, whichever reads better on a `#rrggbb` fill. */
export function textOn(fill: string): string {
  return contrast(fill, "#ffffff") >= contrast(fill, PALETTE.light.foreground) ? "#ffffff" : PALETTE.light.foreground;
}
