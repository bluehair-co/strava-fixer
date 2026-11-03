/** Pulls the activity id out of a Strava link like strava.com/activities/123 (or a bare id). */
export function activityIdFromLink(text: string): string | null {
  const match = /strava\.com\/activities\/(\d+)/.exec(text) ?? /^\s*(\d{6,})\s*$/.exec(text);
  return match ? match[1] : null;
}
