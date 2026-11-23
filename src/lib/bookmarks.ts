/**
 * Page bookmarks, kept in the plugin's synced storage and never in the user's
 * notes. One key per document, so a document's bookmarks follow it across
 * devices and nothing else reads them.
 */

export type DocKind = 'pdf' | 'html';
export type PdfBookmark = { page: number };
export type HtmlBookmark = { headingIndex: number; text: string };
export type Bookmark = PdfBookmark | HtmlBookmark;

export function bookmarkKey(docRemId: string): string {
  return `bookmarks:${docRemId}`;
}

function isPdf(b: Bookmark): b is PdfBookmark {
  return 'page' in b;
}

function order(b: Bookmark): number {
  return isPdf(b) ? b.page : b.headingIndex;
}

function sameBookmark(a: Bookmark, b: Bookmark): boolean {
  if (isPdf(a) && isPdf(b)) return a.page === b.page;
  if (!isPdf(a) && !isPdf(b)) return a.headingIndex === b.headingIndex && a.text === b.text;
  return false;
}

/**
 * What synced storage handed back, as a bookmark list.
 *
 * `{}`, undefined and null all mean "never set": RemNote returns `{}` for an
 * unknown key. Anything else that is not an array of objects is a real
 * corruption and throws, so it surfaces instead of silently wiping the list.
 * Individual entries that fail validation are dropped.
 */
export function normalizeStoredBookmarks(raw: unknown, kind: DocKind): Bookmark[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    if (typeof raw === 'object' && Object.keys(raw as object).length === 0) return [];
    throw new Error(`Stored ${kind} bookmarks are corrupt: expected an array, found ${typeof raw}`);
  }
  if (raw.some((e) => typeof e !== 'object' || e === null)) {
    throw new Error(`Stored ${kind} bookmarks are corrupt: expected objects in the list`);
  }
  const valid = raw.filter((e: Record<string, unknown>) =>
    kind === 'pdf'
      ? Number.isInteger(e.page) && (e.page as number) > 0
      : Number.isInteger(e.headingIndex) && (e.headingIndex as number) >= 0 && typeof e.text === 'string',
  ) as Bookmark[];
  return valid
    .map((e) => (isPdf(e) ? { page: e.page } : { headingIndex: e.headingIndex, text: e.text }))
    .sort((a, b) => order(a) - order(b));
}

/** Add the bookmark, or take it away if it is already there. */
export function toggleBookmark(list: Bookmark[], b: Bookmark): Bookmark[] {
  const without = list.filter((e) => !sameBookmark(e, b));
  const next = without.length === list.length ? [...list, b] : without;
  return next.sort((x, y) => order(x) - order(y));
}
