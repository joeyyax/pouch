export type TrackData = Record<string, string | number | boolean | null | undefined>;

export function track(event: string, data?: TrackData) {
  if (process.env.NODE_ENV !== "production") {
    console.debug(`[track] ${event}`, data ?? {});
  }
}
