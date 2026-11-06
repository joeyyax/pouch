/**
 * The complete XHTML 1.0 / HTML 4 named character reference set (252 names): the five XML
 * entities, Latin-1 Supplement, the Symbol font entities (Greek letters, math, arrows, card
 * suits) and the Special entities (curly quotes, dashes, dagger, euro, and the like).
 *
 * This is deliberately not the full HTML5 named-reference table, which runs past 2000 names
 * by adding MathML/legacy-Netscape entities no transactional email template uses. Anything
 * outside this set falls back below rather than surviving as literal source.
 */
const NAMED_ENTITIES: Record<string, number> = {
  quot: 0x22,
  amp: 0x26,
  apos: 0x27,
  lt: 0x3c,
  gt: 0x3e,

  // Latin-1 Supplement
  nbsp: 0xa0,
  iexcl: 0xa1,
  cent: 0xa2,
  pound: 0xa3,
  curren: 0xa4,
  yen: 0xa5,
  brvbar: 0xa6,
  sect: 0xa7,
  uml: 0xa8,
  copy: 0xa9,
  ordf: 0xaa,
  laquo: 0xab,
  not: 0xac,
  shy: 0xad,
  reg: 0xae,
  macr: 0xaf,
  deg: 0xb0,
  plusmn: 0xb1,
  sup2: 0xb2,
  sup3: 0xb3,
  acute: 0xb4,
  micro: 0xb5,
  para: 0xb6,
  middot: 0xb7,
  cedil: 0xb8,
  sup1: 0xb9,
  ordm: 0xba,
  raquo: 0xbb,
  frac14: 0xbc,
  frac12: 0xbd,
  frac34: 0xbe,
  iquest: 0xbf,
  Agrave: 0xc0,
  Aacute: 0xc1,
  Acirc: 0xc2,
  Atilde: 0xc3,
  Auml: 0xc4,
  Aring: 0xc5,
  AElig: 0xc6,
  Ccedil: 0xc7,
  Egrave: 0xc8,
  Eacute: 0xc9,
  Ecirc: 0xca,
  Euml: 0xcb,
  Igrave: 0xcc,
  Iacute: 0xcd,
  Icirc: 0xce,
  Iuml: 0xcf,
  ETH: 0xd0,
  Ntilde: 0xd1,
  Ograve: 0xd2,
  Oacute: 0xd3,
  Ocirc: 0xd4,
  Otilde: 0xd5,
  Ouml: 0xd6,
  times: 0xd7,
  Oslash: 0xd8,
  Ugrave: 0xd9,
  Uacute: 0xda,
  Ucirc: 0xdb,
  Uuml: 0xdc,
  Yacute: 0xdd,
  THORN: 0xde,
  szlig: 0xdf,
  agrave: 0xe0,
  aacute: 0xe1,
  acirc: 0xe2,
  atilde: 0xe3,
  auml: 0xe4,
  aring: 0xe5,
  aelig: 0xe6,
  ccedil: 0xe7,
  egrave: 0xe8,
  eacute: 0xe9,
  ecirc: 0xea,
  euml: 0xeb,
  igrave: 0xec,
  iacute: 0xed,
  icirc: 0xee,
  iuml: 0xef,
  eth: 0xf0,
  ntilde: 0xf1,
  ograve: 0xf2,
  oacute: 0xf3,
  ocirc: 0xf4,
  otilde: 0xf5,
  ouml: 0xf6,
  divide: 0xf7,
  oslash: 0xf8,
  ugrave: 0xf9,
  uacute: 0xfa,
  ucirc: 0xfb,
  uuml: 0xfc,
  yacute: 0xfd,
  thorn: 0xfe,
  yuml: 0xff,

  // Latin Extended-A / spacing modifiers used by the Special set
  OElig: 0x152,
  oelig: 0x153,
  Scaron: 0x160,
  scaron: 0x161,
  Yuml: 0x178,
  fnof: 0x192,
  circ: 0x2c6,
  tilde: 0x2dc,

  // Greek
  Alpha: 0x391,
  Beta: 0x392,
  Gamma: 0x393,
  Delta: 0x394,
  Epsilon: 0x395,
  Zeta: 0x396,
  Eta: 0x397,
  Theta: 0x398,
  Iota: 0x399,
  Kappa: 0x39a,
  Lambda: 0x39b,
  Mu: 0x39c,
  Nu: 0x39d,
  Xi: 0x39e,
  Omicron: 0x39f,
  Pi: 0x3a0,
  Rho: 0x3a1,
  Sigma: 0x3a3,
  Tau: 0x3a4,
  Upsilon: 0x3a5,
  Phi: 0x3a6,
  Chi: 0x3a7,
  Psi: 0x3a8,
  Omega: 0x3a9,
  alpha: 0x3b1,
  beta: 0x3b2,
  gamma: 0x3b3,
  delta: 0x3b4,
  epsilon: 0x3b5,
  zeta: 0x3b6,
  eta: 0x3b7,
  theta: 0x3b8,
  iota: 0x3b9,
  kappa: 0x3ba,
  lambda: 0x3bb,
  mu: 0x3bc,
  nu: 0x3bd,
  xi: 0x3be,
  omicron: 0x3bf,
  pi: 0x3c0,
  rho: 0x3c1,
  sigmaf: 0x3c2,
  sigma: 0x3c3,
  tau: 0x3c4,
  upsilon: 0x3c5,
  phi: 0x3c6,
  chi: 0x3c7,
  psi: 0x3c8,
  omega: 0x3c9,
  thetasym: 0x3d1,
  upsih: 0x3d2,
  piv: 0x3d6,

  // General Punctuation
  ensp: 0x2002,
  emsp: 0x2003,
  thinsp: 0x2009,
  zwnj: 0x200c,
  zwj: 0x200d,
  lrm: 0x200e,
  rlm: 0x200f,
  ndash: 0x2013,
  mdash: 0x2014,
  lsquo: 0x2018,
  rsquo: 0x2019,
  sbquo: 0x201a,
  ldquo: 0x201c,
  rdquo: 0x201d,
  bdquo: 0x201e,
  dagger: 0x2020,
  Dagger: 0x2021,
  bull: 0x2022,
  hellip: 0x2026,
  permil: 0x2030,
  prime: 0x2032,
  Prime: 0x2033,
  lsaquo: 0x2039,
  rsaquo: 0x203a,
  oline: 0x203e,
  frasl: 0x2044,
  euro: 0x20ac,

  // Letterlike Symbols
  weierp: 0x2118,
  image: 0x2111,
  real: 0x211c,
  trade: 0x2122,
  alefsym: 0x2135,

  // Arrows
  larr: 0x2190,
  uarr: 0x2191,
  rarr: 0x2192,
  darr: 0x2193,
  harr: 0x2194,
  crarr: 0x21b5,
  lArr: 0x21d0,
  uArr: 0x21d1,
  rArr: 0x21d2,
  dArr: 0x21d3,
  hArr: 0x21d4,

  // Mathematical Operators
  forall: 0x2200,
  part: 0x2202,
  exist: 0x2203,
  empty: 0x2205,
  nabla: 0x2207,
  isin: 0x2208,
  notin: 0x2209,
  ni: 0x220b,
  prod: 0x220f,
  sum: 0x2211,
  minus: 0x2212,
  lowast: 0x2217,
  radic: 0x221a,
  prop: 0x221d,
  infin: 0x221e,
  ang: 0x2220,
  and: 0x2227,
  or: 0x2228,
  cap: 0x2229,
  cup: 0x222a,
  int: 0x222b,
  there4: 0x2234,
  sim: 0x223c,
  cong: 0x2245,
  asymp: 0x2248,
  ne: 0x2260,
  equiv: 0x2261,
  le: 0x2264,
  ge: 0x2265,
  sub: 0x2282,
  sup: 0x2283,
  nsub: 0x2284,
  sube: 0x2286,
  supe: 0x2287,
  oplus: 0x2295,
  otimes: 0x2297,
  perp: 0x22a5,
  sdot: 0x22c5,

  // Miscellaneous Technical
  lceil: 0x2308,
  rceil: 0x2309,
  lfloor: 0x230a,
  rfloor: 0x230b,
  lang: 0x2329,
  rang: 0x232a,

  // Geometric Shapes / Dingbats
  loz: 0x25ca,
  spades: 0x2660,
  clubs: 0x2663,
  hearts: 0x2665,
  diams: 0x2666,
};

// A named reference starts with a letter but can carry digits after it: sup1, frac12,
// there4 are all in NAMED_ENTITIES and would otherwise never match.
const ENTITY = /&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi;

const MAX_CODE_POINT = 0x10ffff;
const SURROGATE_MIN = 0xd800;
const SURROGATE_MAX = 0xdfff;

/**
 * Whether a parsed numeric reference is safe to hand to `String.fromCodePoint`, which throws
 * for anything above U+10FFFF. A lone surrogate (U+D800-U+DFFF) is in range but isn't a real
 * character either, so it's treated the same as out-of-range: this runs on caller-supplied
 * html inside message acceptance, and a malformed reference must degrade, never crash the send.
 */
function isValidCodePoint(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= MAX_CODE_POINT && (value < SURROGATE_MIN || value > SURROGATE_MAX);
}

/**
 * Decodes an entity. The text part says what the html part renders: a browser leaves an
 * undefined named reference exactly as written ("AT&T;" stays "AT&T;", not "ATT"), so a name
 * outside `NAMED_ENTITIES`, or a numeric reference that isn't a valid code point, returns the
 * whole matched text unchanged rather than guessing at a rewrite or throwing.
 */
function decodeEntities(input: string): string {
  return input.replace(ENTITY, (match, entity: string) => {
    if (entity[0] === "#") {
      const codePoint =
        entity[1]?.toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return isValidCodePoint(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    const codePoint = entity in NAMED_ENTITIES ? NAMED_ENTITIES[entity] : NAMED_ENTITIES[entity.toLowerCase()];
    return codePoint !== undefined ? String.fromCodePoint(codePoint) : match;
  });
}

function stripTags(input: string): string {
  return input.replace(/<[^>]*>/g, "");
}

const HEAD_STYLE_SCRIPT = /<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi;
const ANCHOR = /<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
const BR = /<br\s*\/?>/gi;
const LI_OPEN = /<li\b[^>]*>/gi;
const LI_CLOSE = /<\/li>/gi;
// Table-based layout is the common case in transactional html, not an edge case: a cell ends
// a column, not a paragraph, so it gets a single space rather than the blank line a <tr> gets.
const CELL_CLOSE = /<\/(?:td|th)>/gi;
const BLOCK_TAGS = "p|div|h[1-6]|blockquote|section|article|header|footer|tr|table|thead|tbody|tfoot|ul|ol|hr";
const BLOCK_OPEN = new RegExp(`<(?:${BLOCK_TAGS})\\b[^>]*>`, "gi");
const BLOCK_CLOSE = new RegExp(`</(?:${BLOCK_TAGS})>`, "gi");

/**
 * Derives a plain-text alternative from an HTML email body. Small and dependency-free:
 * block elements become line breaks, links render as their text followed by their URL,
 * `<li>` becomes a bullet, a table cell separates from the next with a space rather than a
 * paragraph break, and `<style>`/`<script>`/`<head>` contribute nothing.
 */
export function htmlToText(html: string): string {
  let out = html.replace(HEAD_STYLE_SCRIPT, "");
  // Whitespace between tags is insignificant in HTML, same as a browser would treat it.
  // Collapsing it first keeps a pretty-printed template from turning into blank lines below.
  out = out.replace(/\s+/g, " ");

  out = out.replace(ANCHOR, (_match, _quote: string, href: string, inner: string) => {
    const label = stripTags(inner).replace(/\s+/g, " ").trim();
    const url = href.trim();
    return label && label !== url ? `${label} ${url}` : url;
  });

  out = out.replace(BR, "\n");
  out = out.replace(LI_OPEN, "\n- ");
  out = out.replace(LI_CLOSE, "");
  out = out.replace(CELL_CLOSE, " ");
  out = out.replace(BLOCK_OPEN, "\n\n");
  out = out.replace(BLOCK_CLOSE, "\n\n");
  out = stripTags(out);
  out = decodeEntities(out);

  out = out
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n");

  return out.replace(/\n{3,}/g, "\n\n").trim();
}
