/**
 * Which page each of the user's PDF highlights is on, and where a click on a
 * page tile should land.
 *
 * RemNote does not grant this plugin native mode and the SDK cannot scroll the
 * reader to a page, so the ONLY way to move the reader is
 * `highlightRem.scrollToReaderHighlight()`. Jumps therefore go through the
 * user's own highlights. The plugin never creates one: no knowledge base
 * writes, by the owner's decision. See docs/spike-findings.md.
 */

export type HighlightRef = { remId: string; page: number; y: number };

export type JumpTarget =
  | { kind: 'exact'; ref: HighlightRef }
  | { kind: 'before'; ref: HighlightRef; pagesBelow: number }
  | { kind: 'none' };

function positivePage(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * The 1-based page of a highlight, from the `n` powerup's Data slot.
 *
 * The slot holds react-pdf-highlighter JSON. `position.pageNumber` is the
 * documented field; `position.boundingRect.pageNumber` carries the same value
 * and is used only if the first is missing. Returns null rather than guessing
 * when neither is a positive integer, so a malformed highlight is skipped
 * instead of sending the reader to page 0.
 */
export function pageOfHighlightData(data: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  const position = (parsed as { position?: { pageNumber?: unknown; boundingRect?: { pageNumber?: unknown } } })?.position;
  return positivePage(position?.pageNumber) ?? positivePage(position?.boundingRect?.pageNumber);
}

/** The vertical start of a highlight, for picking the topmost one on a page. */
export function yOfHighlightData(data: string): number {
  try {
    const y = (JSON.parse(data) as { position?: { boundingRect?: { y1?: unknown } } })?.position?.boundingRect?.y1;
    return typeof y === 'number' ? y : 0;
  } catch {
    return 0;
  }
}

/** One highlight per page: the topmost, so a jump lands near the top of the page. */
export function indexByPage(refs: HighlightRef[]): Map<number, HighlightRef> {
  const index = new Map<number, HighlightRef>();
  for (const ref of refs) {
    const held = index.get(ref.page);
    if (!held || ref.y < held.y) index.set(ref.page, ref);
  }
  return index;
}

/**
 * Where a click on `page` should go.
 *
 * Exact when the page has a highlight. Otherwise the nearest highlighted page
 * BEFORE it, because the reader scrolls down from there and the user can keep
 * going; a page after it would overshoot. None when nothing precedes it.
 */
export function jumpTarget(page: number, index: Map<number, HighlightRef>): JumpTarget {
  const here = index.get(page);
  if (here) return { kind: 'exact', ref: here };
  let best: HighlightRef | undefined;
  for (const ref of index.values()) {
    if (ref.page < page && (!best || ref.page > best.page)) best = ref;
  }
  return best ? { kind: 'before', ref: best, pagesBelow: page - best.page } : { kind: 'none' };
}
