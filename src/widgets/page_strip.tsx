import * as React from 'react';
import {
  AppEvents,
  renderWidget,
  useAPIEventListener,
  useLocalStorageState,
  usePlugin,
  useSyncedStorageState,
  useTrackerPlugin,
} from '@remnote/plugin-sdk';
import * as pdfjs from 'pdfjs-dist';

import { bookmarkKey, normalizeStoredBookmarks, toggleBookmark, type PdfBookmark } from '../lib/bookmarks.ts';
import { indexByPage, jumpTarget, pageOfHighlightData, yOfHighlightData, type HighlightRef } from '../lib/highlights.ts';
import { describeError, log, setDebugLogging } from '../lib/log.ts';
import type { ReactRNPlugin } from '@remnote/plugin-sdk';

/*
 * PROTOTYPE (spike). The first visible cut of the Pages tab: real thumbnails of
 * the PDF in the focused pane, lazily rendered, with page number pills. No
 * bookmarks, no jump yet. The tested build replaces this per the plan.
 */

setDebugLogging(true);

// One page per row, like a PDF viewer's thumbnail strip. Fixed width so a wide
// sidebar never turns the thumbnails into full pages. 150 rather than smaller
// because RemNote's sidebar bottoms out around 375px (its header icons need
// the room), so a slimmer tile only adds empty space either side.
const TILE = 150;
const MAX_IN_FLIGHT = 2;

/** Bumps on navigation, because the tracker does not re-run on its own when the user switches document. */
function useNavTick(): number {
  const [tick, setTick] = React.useState(0);
  const bump = React.useCallback(() => setTick((t) => t + 1), []);
  useAPIEventListener(AppEvents.URLChange, undefined, bump);
  useAPIEventListener(AppEvents.FocusedPaneChange, undefined, bump);
  return tick;
}

type Source = { docId: string; name: string; url: string } | { docId: string | undefined; reason: string };

function useSource(): Source | undefined {
  const tick = useNavTick();
  const last = React.useRef<Source | undefined>(undefined);
  const now = useTrackerPlugin(
    async (plugin): Promise<Source | undefined> => {
      const paneId = await plugin.window.getFocusedPaneId();
      const docId = await plugin.window.getOpenPaneRemId(paneId);
      // Focus inside the sidebar or a Rem can report no document. Not knowing
      // where we are is not a reason to blank the strip, so keep the last one.
      if (!docId) return undefined;
      const rem = await plugin.rem.findOne(docId);
      const url = rem ? await rem.getPowerupProperty('f' as never, 'URL' as never) : undefined;
      if (typeof url !== 'string' || !url) {
        log('DEBUG', 'useSource: focused document has no uploaded file', { docId, source: 'UploadedFile.URL' });
        return { docId, reason: 'Open a PDF to see its pages.' };
      }
      const name = String((await rem!.getPowerupProperty('f' as never, 'Name' as never)) ?? '');
      log('DEBUG', 'useSource: found PDF', { docId, name, source: 'UploadedFile.URL' });
      return { docId, name, url };
    },
    [tick],
  );
  if (now) last.current = now;
  return now ?? last.current;
}

/** Newest request first, so a fast scroll draws what is on screen now. */
class RenderQueue {
  private waiting: Array<{ index: number; job: () => Promise<void> }> = [];
  private inFlight = 0;
  private known = new Set<number>();
  request(index: number, job: () => Promise<void>): void {
    if (this.known.has(index)) return;
    this.known.add(index);
    this.waiting.push({ index, job });
    this.pump();
  }
  cancel(index: number): void {
    // Only a job still waiting can be cancelled; it may be requested again later.
    const before = this.waiting.length;
    this.waiting = this.waiting.filter((w) => w.index !== index);
    if (this.waiting.length !== before) this.known.delete(index);
  }
  private pump(): void {
    while (this.inFlight < MAX_IN_FLIGHT && this.waiting.length) {
      const next = this.waiting.pop()!;
      this.inFlight++;
      next
        .job()
        .catch((err) => log('WARN', 'thumbnail render failed', { page: next.index + 1, ...describeError(err) }))
        .finally(() => {
          this.inFlight--;
          this.pump();
        });
    }
  }
}

/**
 * The user's highlights in this PDF, by page. Read fresh on every click so a
 * highlight made a moment ago is a jump target without reopening anything.
 * getDescendants + hasPowerup('n'), not taggedRem(): the spike found taggedRem
 * returns none at all (docs/spike-findings.md).
 */
async function readHighlightIndex(plugin: ReactRNPlugin, docId: string): Promise<Map<number, HighlightRef>> {
  const pdf = await plugin.rem.findOne(docId);
  const descendants = pdf ? await pdf.getDescendants() : [];
  const refs: HighlightRef[] = [];
  let skipped = 0;
  for (const rem of descendants) {
    if (!(await rem.hasPowerup('n'))) continue;
    const data = String((await rem.getPowerupProperty('n' as never, 'Data' as never)) ?? '');
    const page = pageOfHighlightData(data);
    if (page === null) {
      skipped++;
      continue;
    }
    refs.push({ remId: rem._id, page, y: yOfHighlightData(data) });
  }
  if (skipped) log('WARN', 'readHighlightIndex: highlights with no readable page were skipped', { docId, skipped, source: 'n.Data' });
  const index = indexByPage(refs);
  log('DEBUG', 'readHighlightIndex', { docId, descendants: descendants.length, highlights: refs.length, pages: [...index.keys()], source: 'getDescendants+n.Data' });
  return index;
}

/** Click on a tile: jump through the user's own highlights, or say why not. */
async function jumpToPage(plugin: ReactRNPlugin, docId: string, page: number): Promise<void> {
  try {
    const target = jumpTarget(page, await readHighlightIndex(plugin, docId));
    log('DEBUG', 'jumpToPage', { docId, page, target: target.kind, via: target.kind === 'none' ? null : target.ref, source: 'jumpTarget' });
    if (target.kind === 'none') {
      await plugin.app.toast(`Page ${page}. Highlight something on or before it to jump here.`);
      return;
    }
    const rem = await plugin.rem.findOne(target.ref.remId);
    if (!rem) {
      log('WARN', 'jumpToPage: highlight rem vanished', { docId, page, remId: target.ref.remId });
      await plugin.app.toast(`Page ${page}: that highlight is gone, try again.`);
      return;
    }
    await rem.scrollToReaderHighlight();
    if (target.kind === 'before') {
      const n = target.pagesBelow;
      await plugin.app.toast(`Page ${page}: jumped to page ${target.ref.page}, scroll down ${n} page${n === 1 ? '' : 's'}.`);
    }
  } catch (err) {
    log('ERROR', 'jumpToPage failed', { docId, page, ...describeError(err), source: 'scrollToReaderHighlight' });
    await plugin.app.toast(`Could not jump to page ${page}: ${describeError(err).message}`);
  }
}

function BookmarkIcon(props: { filled: boolean }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path
        d="M6 3h12v18l-6-4.5L6 21z"
        fill={props.filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Tile(props: {
  page: number;
  aspect: number;
  doc: pdfjs.PDFDocumentProxy;
  queue: RenderQueue;
  jumpable: boolean;
  bookmarked: boolean;
  onPick: (page: number) => void;
  onBookmark: (page: number) => void;
}): JSX.Element {
  const { page, aspect, doc, queue, jumpable, bookmarked, onPick, onBookmark } = props;
  const box = React.useRef<HTMLDivElement>(null);
  const canvas = React.useRef<HTMLCanvasElement>(null);

  React.useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) {
          queue.cancel(page);
          return;
        }
        queue.request(page, async () => {
          const pdfPage = await doc.getPage(page);
          const base = pdfPage.getViewport({ scale: 1 });
          // Render at the tile's real width, which follows the sidebar.
          const cssWidth = el.clientWidth || TILE;
          const viewport = pdfPage.getViewport({ scale: (cssWidth * devicePixelRatio) / base.width });
          const c = canvas.current;
          if (!c) return;
          c.width = Math.floor(viewport.width);
          c.height = Math.floor(viewport.height);
          await pdfPage.render({ canvas: c, viewport }).promise;
        });
      },
      { rootMargin: '400px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [doc, page, queue]);

  return (
    <div
      ref={box}
      className="ps-tile"
      style={{ aspectRatio: `1 / ${aspect}` }}
      role="button"
      title={jumpable ? `Jump to page ${page}` : `Page ${page}`}
      onClick={() => onPick(page)}
    >
      <canvas ref={canvas} className="ps-canvas" />
      {jumpable ? <span className="ps-dot" title="One of your highlights is on this page" /> : null}
      <button
        className={`ps-mark${bookmarked ? ' ps-mark--on' : ''}`}
        title={bookmarked ? `Remove bookmark on page ${page}` : `Bookmark page ${page}`}
        aria-pressed={bookmarked}
        onClick={(e) => {
          e.stopPropagation();
          onBookmark(page);
        }}
      >
        <BookmarkIcon filled={bookmarked} />
      </button>
      <span className="ps-pill">{page}</span>
    </div>
  );
}

type View = 'pages' | 'bookmarks';

function PageStrip(): JSX.Element {
  const plugin = usePlugin();
  const source = useSource();
  const [state, setState] = React.useState<
    { status: 'loading' } | { status: 'ready'; doc: pdfjs.PDFDocumentProxy; aspect: number } | { status: 'error'; message: string }
  >({ status: 'loading' });
  const queue = React.useMemo(() => new RenderQueue(), [state]);
  const [view, setView] = useLocalStorageState<View>('strip:view', 'pages');
  const [menuOpen, setMenuOpen] = React.useState(false);

  const url = source && 'url' in source ? source.url : undefined;
  const docId = source && 'url' in source ? source.docId : undefined;

  // Pages that have a highlight, for the "jumps here" dot. useTrackerPlugin
  // re-runs when the rems it read change, so a new highlight lights its tile up.
  const jumpable = useTrackerPlugin(
    async (p) => (docId ? new Set((await readHighlightIndex(p as ReactRNPlugin, docId)).keys()) : new Set<number>()),
    [docId],
  );

  // Bookmarks live in synced plugin storage, one key per document. Never notes.
  const [storedMarks, setStoredMarks] = useSyncedStorageState<unknown>(bookmarkKey(docId ?? 'none'), []);
  const marks = React.useMemo(() => {
    try {
      return normalizeStoredBookmarks(storedMarks, 'pdf') as PdfBookmark[];
    } catch (err) {
      log('ERROR', 'bookmarks unreadable, showing none', { docId, ...describeError(err), source: 'storage.getSynced' });
      return [];
    }
  }, [storedMarks, docId]);
  const marked = React.useMemo(() => new Set(marks.map((m) => m.page)), [marks]);

  const onPick = React.useCallback(
    (page: number) => {
      if (docId) void jumpToPage(plugin as ReactRNPlugin, docId, page);
    },
    [plugin, docId],
  );
  const onBookmark = React.useCallback(
    (page: number) => {
      if (!docId) return;
      const next = toggleBookmark(marks, { page });
      log('DEBUG', 'bookmark toggled', { docId, page, count: next.length, source: 'storage.setSynced' });
      void setStoredMarks(next);
    },
    [docId, marks, setStoredMarks],
  );

  React.useEffect(() => {
    if (!url) return;
    pdfjs.GlobalWorkerOptions.workerSrc = `${plugin.rootURL}pdf.worker.min.mjs`;
    let cancelled = false;
    // pdf.js 6 tears down through the loading task, not the document.
    const task = pdfjs.getDocument({ url });
    setState({ status: 'loading' });
    (async () => {
      try {
        const loaded = await task.promise;
        const first = await loaded.getPage(1);
        const v = first.getViewport({ scale: 1 });
        log('INFO', 'PDF opened for thumbnails', { pages: loaded.numPages, source: 'pdfjs.getDocument' });
        if (!cancelled) setState({ status: 'ready', doc: loaded, aspect: v.height / v.width });
      } catch (err) {
        log('ERROR', 'PDF could not be opened for thumbnails', { ...describeError(err), source: 'pdfjs.getDocument' });
        if (!cancelled) setState({ status: 'error', message: describeError(err).message });
      }
    })();
    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [url, plugin.rootURL]);

  let body: JSX.Element;
  if (!source) body = <p className="ps-note">Open a PDF to see its pages.</p>;
  else if ('reason' in source) body = <p className="ps-note">{source.reason}</p>;
  else if (state.status === 'loading') body = <p className="ps-note">Loading pages...</p>;
  else if (state.status === 'error') body = <p className="ps-note">Could not read this PDF: {state.message}</p>;
  else {
    const ready = state;
    const pages =
      view === 'bookmarks'
        ? marks.map((m) => m.page).filter((p) => p <= ready.doc.numPages)
        : Array.from({ length: ready.doc.numPages }, (_, i) => i + 1);
    body =
      view === 'bookmarks' && pages.length === 0 ? (
        <p className="ps-note">No bookmarks yet. Hover a page and click the bookmark in its corner.</p>
      ) : (
        <div className="ps-list">
          {pages.map((page) => (
            <Tile
              key={page}
              page={page}
              aspect={ready.aspect}
              doc={ready.doc}
              queue={queue}
              jumpable={Boolean(jumpable?.has(page))}
              bookmarked={marked.has(page)}
              onPick={onPick}
              onBookmark={onBookmark}
            />
          ))}
        </div>
      );
  }

  const pick = (v: View) => {
    setMenuOpen(false);
    void setView(v);
  };

  return (
    <div className="ps-root">
      <style>{CSS}</style>
      <div className="ps-header">
        <button className="ps-switch" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)}>
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <rect x="4" y="4" width="6" height="6" rx="1.5" fill="currentColor" />
            <rect x="14" y="4" width="6" height="6" rx="1.5" fill="currentColor" />
            <rect x="4" y="14" width="6" height="6" rx="1.5" fill="currentColor" />
            <rect x="14" y="14" width="6" height="6" rx="1.5" fill="currentColor" />
          </svg>
          <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
            <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
          </svg>
        </button>
        <span className="ps-title">{view === 'bookmarks' ? 'Bookmarks' : 'Pages'}</span>
        {menuOpen ? (
          <div className="ps-menu" role="menu">
            <button role="menuitemradio" aria-checked={view === 'pages'} onClick={() => pick('pages')}>
              Pages
            </button>
            <button role="menuitemradio" aria-checked={view === 'bookmarks'} onClick={() => pick('bookmarks')}>
              Bookmarks{marks.length ? ` (${marks.length})` : ''}
            </button>
          </div>
        ) : null}
      </div>
      {body}
    </div>
  );
}

const CSS = `
.ps-root { height: 100vh; overflow-y: auto; box-sizing: border-box; padding: 0 10px 24px;
  color: var(--rn-clr-content-primary); font: 14px system-ui, sans-serif; }
.ps-header { position: sticky; top: 0; z-index: 2; display: grid; grid-template-columns: 1fr auto 1fr;
  align-items: center; padding: 10px 0; background: var(--rn-clr-background-primary); }
.ps-switch { justify-self: start; display: inline-flex; align-items: center; gap: 4px; padding: 5px 9px;
  border-radius: 999px; border: 1px solid var(--rn-clr-border-opaque, rgba(128,128,128,.5));
  background: transparent; color: inherit; cursor: pointer; }
.ps-switch:hover { background: var(--rn-clr-background--hovered, rgba(128,128,128,.15)); }
.ps-title { font-weight: 600; }
.ps-menu { position: absolute; top: 44px; left: 0; display: flex; flex-direction: column; min-width: 150px;
  padding: 4px; border-radius: 10px; background: var(--rn-clr-background-elevation-10, #2a2a30);
  box-shadow: 0 8px 24px rgba(0,0,0,.35); }
.ps-menu button { text-align: left; padding: 7px 10px; border: 0; border-radius: 7px; background: transparent;
  color: inherit; cursor: pointer; font: inherit; }
.ps-menu button:hover, .ps-menu button[aria-checked="true"] { background: var(--rn-clr-background--hovered, rgba(128,128,128,.18)); }
.ps-note { opacity: .75; text-align: center; margin: 24px 8px; }
.ps-list { display: flex; flex-direction: column; align-items: center; gap: 14px; padding-top: 6px; }
.ps-tile { position: relative; width: ${TILE}px; flex: none; border-radius: 8px; background: #fff; overflow: hidden;
  box-shadow: 0 1px 4px rgba(0,0,0,.35); cursor: pointer; transition: box-shadow 120ms ease; }
.ps-tile:hover { box-shadow: 0 0 0 3px var(--rn-clr-background-accent, #b49cf5); }
.ps-canvas { width: 100%; height: 100%; display: block; }
.ps-dot { position: absolute; top: 7px; left: 7px; width: 8px; height: 8px; border-radius: 50%;
  background: var(--rn-clr-background-accent, #b49cf5); box-shadow: 0 0 0 2px #fff; }
.ps-mark { position: absolute; top: 2px; right: 2px; display: grid; place-items: center; width: 32px; height: 32px;
  padding: 0; border: 0; border-radius: 6px; background: rgba(255,255,255,.85); color: #5b5566;
  cursor: pointer; opacity: 0; transition: opacity 120ms ease; }
.ps-tile:hover .ps-mark, .ps-mark:focus-visible { opacity: .9; }
.ps-mark--on { opacity: 1; color: #d6456b; }
.ps-pill { position: absolute; left: 50%; bottom: 6px; transform: translateX(-50%);
  min-width: 26px; padding: 1px 8px; border-radius: 999px; text-align: center; font-size: 12px;
  background: rgba(30,30,36,.85); color: #fff; }
`;

renderWidget(PageStrip);
