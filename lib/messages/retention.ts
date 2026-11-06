/** When a message body stops being readable, from the organization's retention setting. */
export function bodyKeptUntil(createdAt: Date, retentionDays: number): Date {
  return new Date(createdAt.getTime() + retentionDays * 24 * 60 * 60 * 1000);
}
