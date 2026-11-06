/**
 * The body as the recipient saw it. Sandboxed with no scripts, no same-origin and a
 * `default-src 'none'` policy inside the document, so the dashboard never fetches a
 * tracking pixel on the operator's behalf. Inline `data:` images show, since they fetch
 * nothing. `images` lifts the rest for a layout preview, where the operator is looking at
 * their own frame rather than a recipient's mail.
 */
import { escapeHtml } from "@/lib/format/html";

export function BodyFrame({
  html,
  text,
  title,
  images = false,
  className = "h-72",
}: {
  /** Rendered as markup. */
  html?: string | null;
  /** Rendered as escaped, pre-wrapped text. Used when there's no html part. */
  text?: string | null;
  title: string;
  images?: boolean;
  className?: string;
}) {
  const policy = `default-src 'none'; style-src 'unsafe-inline'; img-src ${images ? "https: data:" : "data:"}`;

  const content =
    html ??
    `<pre>${escapeHtml(text ?? "")}</pre>`;

  const doc = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${policy}">
<style>body{margin:0;padding:20px;background:#fff;color:#121a40;font:15px/1.6 ui-sans-serif,system-ui,sans-serif}pre{margin:0;white-space:pre-wrap;font:inherit}img{max-width:100%}</style>
</head><body>${content}</body></html>`;

  return (
    <iframe
      title={`${title} — message body`}
      sandbox=""
      srcDoc={doc}
      className={`squircle w-full rounded-xl border border-border bg-white ${className}`}
    />
  );
}
