/**
 * The brand's colors, checked as numbers: every token is inside sRGB, and the
 * text and edge pairs the kit actually draws clear WCAG.
 *
 * Reads the kit defaults (tokens.css's `.surface-brand` scope) plus
 * src/app/brand.css. A project that copies the starter can point BRAND at its
 * own file.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "..", "..", "app");
const TOKENS = readFileSync(join(SRC, "styles", "tokens.css"), "utf8");
const BRAND = readFileSync(join(SRC, "brand.css"), "utf8");

type Oklch = { l: number; c: number; h: number; a: number };
type Scope = Record<string, Oklch>;

// --- Parsing ------------------------------------------------------------

/** Body of the first rule whose selector matches, brace-balanced. */
function block(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`no ${selector} block`);
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(css.indexOf("{", start) + 1, i);
  }
  throw new Error(`unbalanced ${selector} block`);
}

/** Custom property declarations, comments stripped, values unresolved. */
function declarations(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  const clean = body.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of clean.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}

const OKLCH = /^oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+)(%?)\s*)?\)$/;
const VAR = /^var\((--[\w-]+)\)$/;
const MIX_WHITE = /^color-mix\(in oklch, white ([\d.]+)%, var\((--[\w-]+)\)\)$/;

/** Resolves oklch literals, var() and the `color-mix(in oklch, white N%, …)` the kit uses. */
function resolve(raw: Record<string, string>, inherited: Scope = {}): Scope {
  const out: Scope = { ...inherited };
  const value = (name: string, seen: string[] = []): Oklch | undefined => {
    if (seen.includes(name)) throw new Error(`cycle: ${[...seen, name].join(" -> ")}`);
    const v = raw[name];
    if (v === undefined) return inherited[name];
    let m = v.match(OKLCH);
    if (m) {
      const alpha = m[4] === undefined ? 1 : Number(m[4]) / (m[5] ? 100 : 1);
      return { l: Number(m[1]) / 100, c: Number(m[2]), h: Number(m[3]), a: alpha };
    }
    if ((m = v.match(VAR))) return value(m[1]!, [...seen, name]);
    if ((m = v.match(MIX_WHITE))) {
      const base = value(m[2]!, [...seen, name]);
      if (!base) return undefined;
      // White has no hue, so the mix keeps the other color's.
      const p = Number(m[1]) / 100;
      return { l: p + (1 - p) * base.l, c: (1 - p) * base.c, h: base.h, a: 1 };
    }
    return undefined;
  };
  for (const name of Object.keys(raw)) {
    const v = value(name);
    if (v) out[name] = v;
  }
  return out;
}

const light = resolve(declarations(block(BRAND, ":root")));
const dark = resolve(declarations(block(BRAND, ".dark")), light);
const surfaceBrand = declarations(block(TOKENS, ".surface-brand"));
const SCOPES: Record<string, Scope> = {
  light,
  dark,
  "brand on light": resolve(surfaceBrand, light),
  "brand on dark": resolve(surfaceBrand, dark),
};

// --- Oklch -> sRGB ------------------------------------------------------

function linearSrgb({ l: L, c: C, h }: Oklch): [number, number, number] {
  const rad = (h * Math.PI) / 180;
  const a = C * Math.cos(rad);
  const b = C * Math.sin(rad);
  const l_ = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

const inGamut = (t: Oklch) => linearSrgb(t).every((v) => v >= -0.001 && v <= 1.001);

const encode = (v: number) => {
  const c = Math.min(1, Math.max(0, v));
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
};
const decode = (s: number) => (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4);

/** Gamma-encoded sRGB channels — what the compositor actually blends. */
const srgb = (t: Oklch): number[] => linearSrgb(t).map(encode);

/** `over` composited onto painted channels, in gamma space like the browser. */
const composite = (over: Oklch, under: number[]) =>
  srgb(over).map((v, i) => v * over.a + under[i]! * (1 - over.a));

const luminanceOf = (channels: number[]) =>
  channels.map(decode).reduce((acc, v, i) => acc + [0.2126, 0.7152, 0.0722][i]! * v, 0);

function contrast(fg: Oklch, bg: Oklch): number {
  const ground = srgb(bg);
  const lf = luminanceOf(composite(fg, ground));
  const lb = luminanceOf(ground);
  const [hi, lo] = lf > lb ? [lf, lb] : [lb, lf];
  return (hi + 0.05) / (lo + 0.05);
}

// --- The pairs the kit draws --------------------------------------------

/** [text, ground] at 4.5:1. */
const TEXT: [string, string][] = [
  ["--foreground", "--background"],
  ["--foreground", "--card"],
  ["--card-foreground", "--card"],
  ["--foreground-soft", "--background"],
  ["--foreground-soft", "--card"],
  ["--muted-foreground", "--background"],
  ["--muted-foreground", "--card"],
  ["--muted-foreground", "--muted"],
  ["--tertiary", "--background"],
  ["--tertiary", "--card"],
  ["--tertiary", "--secondary"],
  ["--secondary-foreground", "--secondary"],
  ["--accent-foreground", "--accent"],
  ["--primary", "--background"],
  ["--primary-foreground", "--primary"],
  ["--primary-strong", "--background"],
  ["--primary-strong", "--card"],
  ["--primary-strong", "--accent"],
  ["--danger", "--danger-soft"],
  ["--warning", "--warning-soft"],
  ["--success-ink", "--success-soft"],
  ["--info-ink", "--info-soft"],
];

/** Scopes that re-declare only the role tokens; the status ramp isn't drawn there. */
const SURFACE_PAIRS = new Set([
  "--foreground|--background",
  "--card-foreground|--card",
  "--foreground-soft|--background",
  "--muted-foreground|--background",
  "--tertiary|--background",
  "--tertiary|--secondary",
  "--secondary-foreground|--secondary",
  "--accent-foreground|--accent",
  "--primary-foreground|--primary",
]);

/** [edge, ground] at 3:1 — a focus ring has to be seen. */
const EDGE: [string, string][] = [
  ["--ring", "--background"],
  ["--ring", "--card"],
];

describe("brand color tokens", () => {
  for (const [scopeName, scope] of Object.entries(SCOPES)) {
    // The surface scopes are color-mix results the browser computes, not declared colors.
    it.skipIf(scopeName.startsWith("brand"))(`${scopeName}: every color is inside sRGB`, () => {
      const out = Object.entries(scope)
        .filter(([, t]) => !inGamut(t))
        .map(([name, t]) => `${name} oklch(${(t.l * 100).toFixed(1)}% ${t.c} ${t.h})`);
      expect(out).toEqual([]);
    });

    const surface = scopeName.startsWith("brand");
    const pairs = surface ? TEXT.filter(([f, b]) => SURFACE_PAIRS.has(`${f}|${b}`)) : TEXT;
    it(`${scopeName}: text pairs clear 4.5:1`, () => {
      const fails = pairs
        .filter(([f, b]) => scope[f] && scope[b])
        .map(([f, b]) => [f, b, contrast(scope[f]!, scope[b]!)] as const)
        .filter(([, , r]) => r < 4.5)
        .map(([f, b, r]) => `${f} on ${b}: ${r.toFixed(2)}`);
      expect(fails).toEqual([]);
    });

    it(`${scopeName}: the focus ring clears 3:1`, () => {
      const fails = EDGE.filter(([f, b]) => scope[f] && scope[b])
        .map(([f, b]) => [f, b, contrast(scope[f]!, scope[b]!)] as const)
        .filter(([, , r]) => r < 3)
        .map(([f, b, r]) => `${f} on ${b}: ${r.toFixed(2)}`);
      expect(fails).toEqual([]);
    });
  }

  it("resolves the pairs it checks", () => {
    const missing = TEXT.flat().filter((n) => !n.startsWith("--info") && !light[n]);
    expect(missing).toEqual([]);
  });
});
