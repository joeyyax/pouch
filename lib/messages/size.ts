/** The most a provider takes, body and decoded attachments together: Mailpace's 30 MB, and SES's 40 MB once base64 is counted. */
export const MAX_MESSAGE_MB = 30;

/** Decoded size of a base64 string, without allocating the buffer. */
export function base64Bytes(content: string): number {
  const padding = content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((content.length * 3) / 4) - padding);
}

/** UTF-8 bytes of the html and text parts. A missing part counts 0. */
export function bodyBytes(html: string | null, text: string | null): number {
  return Buffer.byteLength(html ?? "", "utf8") + Buffer.byteLength(text ?? "", "utf8");
}
