/** The element at `index`, or a failure naming the gap instead of a read off the end. */
export function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`expected an element at index ${index}, got ${items.length}`);
  return item;
}
