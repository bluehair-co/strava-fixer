/**
 * What you've told the app about your activities: sports you changed, which
 * ones you've marked as added to Strava, and which you've exported. Kept in
 * this browser (localStorage), and can be saved to / loaded from a file as a
 * backup or to move to another computer.
 */

export interface Marks {
  /** Item key → sport key you chose. */
  sports: Record<string, string>;
  /** Item key → date (ISO) you marked it as added to Strava. */
  added: Record<string, string>;
  /** Item key → date (ISO) it was last exported. */
  exported: Record<string, string>;
  /** Item key → date (ISO) you chose to ignore it (hidden from the list). */
  ignored: Record<string, string>;
}

const STORAGE_KEY = "strava-fixer.library.marks.v1";

export const EMPTY_MARKS: Marks = { sports: {}, added: {}, exported: {}, ignored: {} };

export function normaliseMarks(data: unknown): Marks {
  const o = (data && typeof data === "object" ? data : {}) as Partial<Marks>;
  const rec = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, string>) : {});
  return { sports: rec(o.sports), added: rec(o.added), exported: rec(o.exported), ignored: rec(o.ignored) };
}

export function loadMarks(): Marks {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? normaliseMarks(JSON.parse(raw)) : EMPTY_MARKS;
  } catch {
    return EMPTY_MARKS;
  }
}

export function saveMarks(marks: Marks): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(marks));
    return true;
  } catch {
    return false;
  }
}

/** Combines marks from a backup file with the current ones (the file wins where both say something). */
export function mergeMarks(current: Marks, incoming: Marks): Marks {
  return {
    sports: { ...current.sports, ...incoming.sports },
    added: { ...current.added, ...incoming.added },
    exported: { ...current.exported, ...incoming.exported },
    ignored: { ...current.ignored, ...incoming.ignored },
  };
}
