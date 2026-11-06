/**
 * The one layout Pouch's own mail renders through: brand header, heading, short body, one
 * button with its URL as fallback text, and a footer saying why the reader got it. Tables and
 * inline light colors so every client renders it; dark colors override from the `<style>` block.
 */
import type { CSSProperties, FC, ReactElement, ReactNode } from "react";
import { isValidElement } from "react";
import { render } from "@react-email/render";
import { Body, Head, Heading, Html, Img, Link, Preview, Text } from "react-email";
import { baseUrl } from "@/lib/api/urls";
import { brand } from "@/lib/brand";
import { FONT_STACK, PALETTE } from "@/lib/brand-palette";
import { escapeHtml } from "@/lib/format/html";

declare module "react" {
  interface TdHTMLAttributes<T> extends HTMLAttributes<T> {
    bgcolor?: string;
  }
}

export interface SystemMailSection {
  title: string;
  lines: string[];
}

export type MailTone = "good" | "warn" | "bad" | "neutral";

export interface MailStat {
  label: string;
  value: string;
  /** A short line under the value, such as the change from last time. Colored by `tone`. */
  detail?: string;
  tone?: MailTone;
  href?: string;
  /** The change from last time: an arrow colored by `tone`, then `text`. */
  change?: { direction: "up" | "down" | "flat"; text: string; tone: MailTone };
}

export type MailBlock =
  | { kind: "stats"; stats: MailStat[] }
  /** A bar chart drawn with table cells, so it renders with images off. */
  | { kind: "bars"; title: string; bars: { label: string; value: number }[]; caption?: string; href?: string }
  /** `tones` colors cells by index; a column header row shows only when some column is named. */
  | { kind: "table"; title: string; columns: string[]; rows: { cells: string[]; tones?: (MailTone | undefined)[]; href?: string }[] }
  | { kind: "list"; title: string; items: { text: string; tone: MailTone; href?: string }[] }
  /** One line in a tile, marked by `tone`. */
  | { kind: "callout"; tone: MailTone; text: string };

export interface SystemMailBody {
  heading: string;
  /** The inbox preview line, hidden in the body. Defaults to the first paragraph. */
  preheader?: string;
  paragraphs: string[];
  /** Rendered after the paragraphs, in order. */
  blocks?: MailBlock[];
  /** Label and value pairs, shown as a small table. */
  facts?: [string, string][];
  sections?: SystemMailSection[];
  action?: { label: string; url: string };
  /** Under the button: how long the link lasts, what happens next. */
  note?: string;
  /** Why the reader got this, in the footer. */
  reason: string;
  footerLink?: { label: string; url: string };
}

export interface RenderedMail {
  html: string;
  text: string;
}

const { light, dark } = PALETTE;
const FONT = FONT_STACK.replace(/"/g, "'");

const STYLE = `
body{margin:0;padding:0;-webkit-text-size-adjust:100%;text-size-adjust:100%}
@media (max-width:600px){.pm-card{padding:24px !important}.pm-outer{padding:24px 12px !important}}
@media (prefers-color-scheme:dark){
.pm-bg{background:${dark.background} !important}
.pm-card{background:${dark.card} !important;border-color:${dark.border} !important}
.pm-fg{color:${dark.foreground} !important}
.pm-soft{color:${dark.soft} !important}
.pm-muted{color:${dark.muted} !important}
.pm-rule{border-color:${dark.border} !important}
.pm-logo{display:none !important}
.pm-logo-dark{display:block !important}
.pm-btn{background:${dark.primary} !important}
.pm-btn a{color:${dark.onPrimary} !important}
.pm-link{color:${dark.primary} !important}
.pm-tile{background:${dark.background} !important;border-color:${dark.border} !important}
.pm-bar{background:${dark.primary} !important}
.pm-base{background:${dark.border} !important}
.pm-good{color:${dark.success} !important}
.pm-warn{color:${dark.warning} !important}
.pm-bad{color:${dark.danger} !important}
.pm-mark-good{background:${dark.success} !important}
.pm-mark-neutral{background:${dark.muted} !important}
.pm-mark-warn{color:${dark.warning} !important}
.pm-mark-bad{background:${dark.danger} !important;color:${dark.card} !important}
}
[data-ogsc] .pm-fg{color:${dark.foreground} !important}
[data-ogsc] .pm-soft{color:${dark.soft} !important}
[data-ogsc] .pm-muted{color:${dark.muted} !important}
[data-ogsc] .pm-link{color:${dark.primary} !important}
[data-ogsc] .pm-logo{display:none !important}
[data-ogsc] .pm-logo-dark{display:block !important}
`;

const text = (size: number, color: string, extra: CSSProperties = {}): CSSProperties => ({
  margin: 0,
  fontFamily: FONT,
  fontSize: `${size}px`,
  lineHeight: 1.55,
  color,
  ...extra,
});

const SPACER: CSSProperties = { fontSize: 0, lineHeight: 0 };
const NBSP = " ";

/** The mark is a PNG pair from `public/mail/`, since most clients don't render SVG. The dark one swaps in from the `<style>` block. */
const MARK_IMAGE: CSSProperties = { width: "26px", height: "20px" };

/** Layout tables: no spacing, no semantics. */
function Table({ children, ...props }: { children: ReactNode; width?: string; style?: CSSProperties; className?: string; bgcolor?: string }) {
  return (
    <table role="presentation" cellPadding={0} cellSpacing={0} {...props}>
      <tbody>{children}</tbody>
    </table>
  );
}

/** Raw markup for what JSX can't express: Outlook's conditional comments. */
function Raw({ html }: { html: string }) {
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}

const TONE_COLOR: Record<MailTone, string> = { good: light.success, warn: light.warning, bad: light.danger, neutral: light.muted };
const TONE_TEXT: Record<MailTone, string> = { good: "ok", warn: "!", bad: "!!", neutral: "-" };

/** Links take the text's own color; only links inside running text are underlined. */
function Linked({ href, color, className, inline = false, children }: { href?: string; color: string; className: string; inline?: boolean; children: string }) {
  if (!href) return <>{children}</>;
  const decoration: CSSProperties = inline ? { textDecoration: "underline", textDecorationColor: light.border, textUnderlineOffset: "3px" } : { textDecoration: "none" };
  return (
    <Link className={className} href={href} style={{ color, ...decoration }}>
      {children}
    </Link>
  );
}

function BlockTitle({ title, href }: { title: string; href?: string }) {
  return (
    <p className="pm-fg" style={text(15, light.foreground, { margin: "0 0 10px", fontWeight: 600 })}>
      <Linked href={href} color={light.foreground} className="pm-fg">
        {title}
      </Linked>
    </p>
  );
}

/** The dashboard's status marks (components/ui/status-dot.tsx): a dot when fine, a triangle to watch, a circled "!" for an issue. */
function Mark({ tone }: { tone: MailTone }) {
  const box: CSSProperties = { display: "inline-block", verticalAlign: "middle", fontSize: 0, lineHeight: 0 };
  if (tone === "warn") {
    return (
      <span className="pm-mark-warn" style={{ display: "inline-block", verticalAlign: "middle", width: "12px", textAlign: "center", fontFamily: "Arial,sans-serif", fontSize: "11px", lineHeight: "12px", color: light.warning }}>
        ▲
      </span>
    );
  }
  if (tone === "bad") {
    return (
      <span
        className="pm-mark-bad"
        style={{ display: "inline-block", verticalAlign: "middle", width: "12px", height: "12px", borderRadius: "6px", background: light.danger, color: "#ffffff", textAlign: "center", fontFamily: "Arial,sans-serif", fontSize: "9px", fontWeight: 700, lineHeight: "12px" }}
      >
        !
      </span>
    );
  }
  const fill = tone === "good" ? light.success : light.border;
  return (
    <span style={{ ...box, width: "12px", height: "12px", textAlign: "center" }}>
      <span className={`pm-mark-${tone}`} style={{ ...box, width: "6px", height: "6px", marginTop: "3px", borderRadius: "3px", background: fill }}>
        {NBSP}
      </span>
    </span>
  );
}

const ARROW = { up: "↑", down: "↓", flat: "→" } as const;

function Paragraph({ children }: { children: string }) {
  return (
    <Text className="pm-soft" style={text(16, light.soft, { margin: "0 0 16px" })}>
      {children}
    </Text>
  );
}

function Facts({ facts }: { facts: [string, string][] }) {
  const rule = `1px solid ${light.border}`;
  return (
    <Table width="100%" style={{ margin: "0 0 16px" }}>
      {facts.map(([label, value], index) => (
        <tr key={index}>
          <td className="pm-muted pm-rule" style={text(14, light.muted, { padding: "8px 16px 8px 0", borderTop: rule, verticalAlign: "top", whiteSpace: "nowrap" })}>
            {label}
          </td>
          <td className="pm-fg pm-rule" style={text(14, light.foreground, { padding: "8px 0", borderTop: rule, wordBreak: "break-word" })}>
            {value}
          </td>
        </tr>
      ))}
    </Table>
  );
}

function SectionBlock({ section }: { section: SystemMailSection }) {
  return (
    <div style={{ margin: "0 0 16px" }}>
      <p className="pm-fg" style={text(15, light.foreground, { fontWeight: 600 })}>
        {section.title}
      </p>
      {section.lines.map((line, index) => (
        <p key={index} className="pm-soft" style={text(15, light.soft, { margin: "4px 0 0" })}>
          {line}
        </p>
      ))}
    </div>
  );
}

function StatTile({ stat }: { stat: MailStat }) {
  const tone = stat.tone ?? "neutral";
  const toneClass = (value: MailTone) => `pm-${value === "neutral" ? "muted" : value}`;
  return (
    <td className="pm-tile" valign="top" bgcolor={light.background} style={{ width: "50%", padding: "14px 16px", background: light.background, border: `1px solid ${light.border}`, borderRadius: "12px" }}>
      <p className="pm-muted" style={text(13, light.muted)}>
        {tone === "neutral" ? (
          stat.label
        ) : (
          <>
            <Mark tone={tone} />
            {`${NBSP}${stat.label}`}
          </>
        )}
      </p>
      <p className="pm-fg" style={text(24, light.foreground, { fontWeight: 600, lineHeight: 1.25, margin: "2px 0 0" })}>
        <Linked href={stat.href} color={light.foreground} className="pm-fg">
          {stat.value}
        </Linked>
      </p>
      {stat.change ? (
        <p className="pm-soft" style={text(13, light.soft, { margin: "2px 0 0" })}>
          <span className={toneClass(stat.change.tone)} style={{ color: TONE_COLOR[stat.change.tone], fontWeight: 700 }}>
            {ARROW[stat.change.direction]}
          </span>
          {` ${stat.change.text}`}
        </p>
      ) : null}
      {stat.detail ? (
        <p className={toneClass(tone)} style={text(13, TONE_COLOR[tone], { margin: "2px 0 0" })}>
          {stat.detail}
        </p>
      ) : null}
    </td>
  );
}

function Stats({ stats }: { stats: MailStat[] }) {
  const rows: MailStat[][] = [];
  for (let i = 0; i < stats.length; i += 2) rows.push(stats.slice(i, i + 2));
  return (
    <Table width="100%" style={{ margin: "0 0 20px", borderCollapse: "separate", borderSpacing: "0 8px" }}>
      {rows.map((pair, index) => (
        <tr key={index}>
          <StatTile stat={pair[0]!} />
          <td style={{ width: "8px", fontSize: 0 }}>{NBSP}</td>
          {pair[1] ? <StatTile stat={pair[1]} /> : <td style={{ width: "50%" }}>{NBSP}</td>}
        </tr>
      ))}
    </Table>
  );
}

const BAR_HEIGHT = 72;

function Bars({ block }: { block: Extract<MailBlock, { kind: "bars" }> }) {
  const max = Math.max(1, ...block.bars.map((bar) => bar.value));
  const first = block.bars[0]?.label ?? "";
  const last = block.bars[block.bars.length - 1]?.label ?? "";
  return (
    <div style={{ margin: "0 0 24px" }}>
      <BlockTitle title={block.title} href={block.href} />
      <Table width="100%" style={{ tableLayout: "fixed" }}>
        <tr>
          {block.bars.map((bar, index) => {
            const height = bar.value > 0 ? Math.max(3, Math.round((bar.value / max) * BAR_HEIGHT)) : 0;
            return (
              <td key={index} valign="bottom" title={`${bar.label}: ${bar.value}`} style={{ height: `${BAR_HEIGHT}px`, padding: "0 1px", ...SPACER }}>
                {height > 0 ? (
                  <div className="pm-bar" style={{ height: `${height}px`, background: light.primary, borderRadius: "3px 3px 0 0", ...SPACER }}>
                    {NBSP}
                  </div>
                ) : null}
              </td>
            );
          })}
        </tr>
        <tr>
          <td className="pm-base" colSpan={block.bars.length} height="1" bgcolor={light.border} style={{ height: "1px", background: light.border, ...SPACER }}>
            {NBSP}
          </td>
        </tr>
        <tr>
          <td colSpan={block.bars.length} style={{ padding: "6px 0 0" }}>
            <Table width="100%">
              <tr>
                <td className="pm-muted" style={text(12, light.muted)}>
                  {first}
                </td>
                <td className="pm-muted" align="right" style={text(12, light.muted)}>
                  {last}
                </td>
              </tr>
            </Table>
          </td>
        </tr>
      </Table>
      {block.caption ? (
        <p className="pm-muted" style={text(13, light.muted, { margin: "8px 0 0" })}>
          {block.caption}
        </p>
      ) : null}
    </div>
  );
}

function DataTable({ block }: { block: Extract<MailBlock, { kind: "table" }> }) {
  const align = (index: number) => (index === 0 ? "left" : "right");
  const pad = (index: number) => (index === 0 ? "0" : "12px");
  return (
    <div style={{ margin: "0 0 24px" }}>
      <BlockTitle title={block.title} />
      <Table width="100%">
        {block.columns.some(Boolean) ? (
          <tr>
            {block.columns.map((column, index) => (
              <td key={index} className="pm-muted" align={align(index)} style={text(12, light.muted, { padding: `0 0 6px ${pad(index)}`, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em" })}>
                {column}
              </td>
            ))}
          </tr>
        ) : null}
        {block.rows.map((row, rowIndex) => (
          <tr key={rowIndex}>
            {row.cells.map((value, index) => {
              const tone = row.tones?.[index];
              const toned = tone !== undefined && tone !== "neutral";
              const color = toned ? TONE_COLOR[tone] : light.foreground;
              const className = toned ? `pm-${tone}` : "pm-fg";
              const marked = tone === "warn" || tone === "bad";
              const href = index === 0 ? row.href : undefined;
              return (
                <td key={index} className={`${className} pm-rule`} align={align(index)} style={text(14, color, { padding: `8px 0 8px ${pad(index)}`, borderTop: `1px solid ${light.border}`, whiteSpace: "nowrap" })}>
                  {marked ? <Mark tone={tone} /> : null}
                  {href ? (
                    <>
                      {marked ? NBSP : null}
                      <Linked href={href} color={color} className={className}>
                        {value}
                      </Linked>
                    </>
                  ) : (
                    `${marked ? NBSP : ""}${value}`
                  )}
                </td>
              );
            })}
          </tr>
        ))}
      </Table>
    </div>
  );
}

function List({ block }: { block: Extract<MailBlock, { kind: "list" }> }) {
  return (
    <div style={{ margin: "0 0 24px" }}>
      <BlockTitle title={block.title} />
      <Table>
        {block.items.map((item, index) => (
          <tr key={index}>
            <td valign="middle" width="12" style={{ width: "12px", padding: "4px 10px 4px 0", ...SPACER }}>
              <Mark tone={item.tone} />
            </td>
            <td className="pm-soft" valign="middle" style={text(15, light.soft, { padding: "4px 0" })}>
              <Linked href={item.href} color={light.soft} className="pm-soft" inline>
                {item.text}
              </Linked>
            </td>
          </tr>
        ))}
      </Table>
    </div>
  );
}

function Callout({ block }: { block: Extract<MailBlock, { kind: "callout" }> }) {
  return (
    <Table width="100%" style={{ margin: "0 0 20px" }}>
      <tr>
        <td className="pm-tile" bgcolor={light.background} style={{ padding: "14px 16px", background: light.background, border: `1px solid ${light.border}`, borderRadius: "12px" }}>
          <Table>
            <tr>
              <td valign="middle" width="12" style={{ width: "12px", padding: "0 10px 0 0", ...SPACER }}>
                <Mark tone={block.tone} />
              </td>
              <td className="pm-fg" valign="middle" style={text(15, light.foreground)}>
                {block.text}
              </td>
            </tr>
          </Table>
        </td>
      </tr>
    </Table>
  );
}

function Block({ block }: { block: MailBlock }) {
  switch (block.kind) {
    case "callout":
      return <Callout block={block} />;
    case "stats":
      return <Stats stats={block.stats} />;
    case "bars":
      return <Bars block={block} />;
    case "table":
      return <DataTable block={block} />;
    case "list":
      return <List block={block} />;
  }
}

/** A pill everywhere but Outlook, which gets the same pill drawn in VML. */
function ActionButton({ action }: { action: { label: string; url: string } }) {
  const href = escapeHtml(action.url);
  const label = escapeHtml(action.label);
  return (
    <>
      <Raw
        html={`<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${href}" style="height:48px;v-text-anchor:middle;width:260px" arcsize="50%" stroke="f" fillcolor="${light.primary}"><w:anchorlock/><center style="color:#ffffff;font-family:Arial,sans-serif;font-size:16px;font-weight:bold">${label}</center></v:roundrect><![endif]--><!--[if !mso]><!-->`}
      />
      <Table style={{ margin: "8px 0 0" }}>
        <tr>
          <td className="pm-btn" bgcolor={light.primary} style={{ borderRadius: "999px", background: light.primary }}>
            <Link
              href={action.url}
              style={{ display: "inline-block", padding: "14px 28px", fontFamily: FONT, fontSize: "16px", fontWeight: 600, lineHeight: "20px", color: light.onPrimary, textDecoration: "none", borderRadius: "999px" }}
            >
              {action.label}
            </Link>
          </td>
        </tr>
      </Table>
      <Raw html="<!--<![endif]-->" />
      <p className="pm-muted" style={text(13, light.muted, { margin: "16px 0 0" })}>
        Or open this link:
        <br />
        <Link className="pm-link" href={action.url} style={{ color: light.primary, textDecoration: "underline", wordBreak: "break-all" }}>
          {action.url}
        </Link>
      </p>
    </>
  );
}

/** The layout every system email renders through. */
export const SystemMail: FC<SystemMailBody> = (body) => (
  <Html lang="en">
    <Head>
      <meta name="viewport" content="width=device-width,initial-scale=1" />
      <meta name="color-scheme" content="light dark" />
      <meta name="supported-color-schemes" content="light dark" />
      <title>{body.heading}</title>
      <style dangerouslySetInnerHTML={{ __html: STYLE }} />
    </Head>
    <Body className="pm-bg" style={{ margin: 0, padding: 0, background: light.background }}>
      <Preview useTitleTag={false} style={{ display: "none", maxHeight: 0, overflow: "hidden", msoHide: "all" } as CSSProperties}>
        {body.preheader ?? body.paragraphs[0] ?? body.heading}
      </Preview>
      <Table width="100%" className="pm-bg" bgcolor={light.background} style={{ background: light.background }}>
        <tr>
          <td align="center" className="pm-outer" style={{ padding: "40px 16px" }}>
            <Table width="100%" style={{ maxWidth: "560px", borderCollapse: "separate" }}>
              <tr>
                <td style={{ padding: "0 4px 20px" }}>
                  <Table>
                    <tr>
                      <td width="26" valign="middle" style={{ width: "26px", ...SPACER }}>
                        <Img className="pm-logo" src={`${baseUrl()}/mail/mark.png`} width="26" height="20" alt={brand.name} style={MARK_IMAGE} />
                        <Img className="pm-logo-dark" src={`${baseUrl()}/mail/mark-dark.png`} width="26" height="20" alt={brand.name} style={{ ...MARK_IMAGE, display: "none", msoHide: "all" } as CSSProperties} />
                      </td>
                      <td className="pm-fg" style={{ paddingLeft: "10px", fontFamily: FONT, fontSize: "16px", fontWeight: 600, lineHeight: "18px", color: light.foreground }}>
                        {brand.name}
                      </td>
                    </tr>
                  </Table>
                </td>
              </tr>
              <tr>
                <td className="pm-card" bgcolor={light.card} style={{ background: light.card, border: `1px solid ${light.border}`, borderRadius: "16px", padding: "32px" }}>
                  <Heading as="h1" className="pm-fg" style={text(22, light.foreground, { margin: "0 0 16px", fontWeight: 600, lineHeight: 1.3 })}>
                    {body.heading}
                  </Heading>
                  {body.paragraphs.map((value, index) => (
                    <Paragraph key={index}>{value}</Paragraph>
                  ))}
                  {(body.blocks ?? []).map((block, index) => (
                    <Block key={index} block={block} />
                  ))}
                  {body.facts?.length ? <Facts facts={body.facts} /> : null}
                  {(body.sections ?? []).map((section, index) => (
                    <SectionBlock key={index} section={section} />
                  ))}
                  {body.action ? <ActionButton action={body.action} /> : null}
                  {body.note ? (
                    <p className="pm-muted" style={text(13, light.muted, { margin: "12px 0 0" })}>
                      {body.note}
                    </p>
                  ) : null}
                </td>
              </tr>
              <tr>
                <td className="pm-muted" style={text(13, light.muted, { padding: "20px 4px 0", lineHeight: 1.5 })}>
                  {body.reason}
                  {body.footerLink ? (
                    <>
                      <br />
                      <Link className="pm-link" href={body.footerLink.url} style={{ color: light.muted, textDecoration: "underline" }}>
                        {body.footerLink.label}
                      </Link>
                    </>
                  ) : null}
                </td>
              </tr>
            </Table>
          </td>
        </tr>
      </Table>
    </Body>
  </Html>
);

function blockText(block: MailBlock): string {
  switch (block.kind) {
    case "stats":
      return block.stats
        .map((stat) => {
          const notes = [stat.change ? `${ARROW[stat.change.direction]} ${stat.change.text}` : null, stat.detail].filter(Boolean);
          return `${stat.label}: ${stat.value}${notes.length ? ` (${notes.join(", ")})` : ""}`;
        })
        .join("\n");
    case "bars": {
      const peak = block.bars.reduce((best, bar) => (bar.value > best.value ? bar : best), block.bars[0] ?? { label: "", value: 0 });
      return [block.title, ...(block.caption ? [block.caption] : []), ...(peak.value > 0 ? [`Busiest: ${peak.label} (${peak.value})`] : [])].join("\n");
    }
    case "table": {
      const line = (row: (typeof block.rows)[number]) =>
        row.cells.map((value, index) => (index === 0 ? value : block.columns[index] ? `${block.columns[index]} ${value}` : value)).join(block.columns.some(Boolean) ? ", " : ": ");
      return [block.title, ...block.rows.map((row) => `${line(row)}${row.href ? `\n    ${row.href}` : ""}`)].join("\n");
    }
    case "callout":
      return `[${TONE_TEXT[block.tone]}] ${block.text}`;
    case "list":
      return [block.title, ...block.items.map((item) => `[${TONE_TEXT[item.tone]}] ${item.text}${item.href ? `\n    ${item.href}` : ""}`)].join("\n");
  }
}

/** The plain-text part, from the same props the layout renders. */
export function systemMailText(body: SystemMailBody): string {
  const blocks = [body.heading, ...(body.preheader ? [body.preheader] : []), ...body.paragraphs, ...(body.blocks ?? []).map(blockText)];
  if (body.facts?.length) blocks.push(body.facts.map(([label, value]) => `${label}: ${value}`).join("\n"));
  for (const item of body.sections ?? []) blocks.push([item.title, ...item.lines].join("\n"));
  if (body.action) blocks.push(`${body.action.label}:\n${body.action.url}`);
  if (body.note) blocks.push(body.note);
  blocks.push(["--", body.reason, ...(body.footerLink ? [`${body.footerLink.label}: ${body.footerLink.url}`] : [])].join("\n"));
  return blocks.join("\n\n");
}

/** The layout's props behind an email: each wrapping component is called until it reaches `SystemMail`. */
function bodyOf(email: ReactElement): SystemMailBody {
  let node: unknown = email;
  while (isValidElement(node) && node.type !== SystemMail && typeof node.type === "function") {
    node = (node.type as FC<unknown>)(node.props);
  }
  if (!isValidElement(node) || node.type !== SystemMail) throw new Error("A system email has to render SystemMail.");
  return node.props as SystemMailBody;
}

/** Both parts of one system email. */
export async function renderSystemMail(email: ReactElement): Promise<RenderedMail> {
  return { html: await render(email), text: systemMailText(bodyOf(email)) };
}
