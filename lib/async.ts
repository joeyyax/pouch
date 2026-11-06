/** `work` over `items`, at most `limit` at a time, results in order. */
export async function mapBounded<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]!);
    }
  });
  await Promise.all(runners);
  return results;
}

/** `work` over `items`, at most `limit` at a time. */
export async function eachBounded<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  await mapBounded(items, limit, work);
}
