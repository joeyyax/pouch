/** Turns an async generator of text or bytes into a web ReadableStream, one chunk at a time. */
export function toByteStream(source: AsyncGenerator<string | Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await source.next();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(typeof value === "string" ? encoder.encode(value) : value);
    },
    async cancel() {
      await source.return?.(undefined);
    },
  });
}
