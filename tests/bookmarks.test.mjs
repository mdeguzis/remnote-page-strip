import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bookmarkKey, normalizeStoredBookmarks, toggleBookmark } from '../src/lib/bookmarks.ts';

/*
 * RemNote's synced storage returns an empty OBJECT for a key it has never seen,
 * not undefined (found the hard way in In The Margins). That has to read as
 * "no bookmarks yet", or the panel calls every fresh document corrupt.
 */

test('an unset key comes back as {} and that means empty', () => {
  assert.deepEqual(normalizeStoredBookmarks({}, 'pdf'), []);
});

test('undefined and null mean empty', () => {
  assert.deepEqual(normalizeStoredBookmarks(undefined, 'pdf'), []);
  assert.deepEqual(normalizeStoredBookmarks(null, 'html'), []);
});

test('a stored list round trips, sorted by page', () => {
  assert.deepEqual(normalizeStoredBookmarks([{ page: 9 }, { page: 2 }], 'pdf'), [{ page: 2 }, { page: 9 }]);
});

test('a real corruption throws and names the kind, rather than reading as empty', () => {
  assert.throws(() => normalizeStoredBookmarks(['x', 3], 'pdf'), /pdf bookmarks/);
  assert.throws(() => normalizeStoredBookmarks('nope', 'html'), /html bookmarks/);
});

test('pdf entries without a positive whole page are dropped', () => {
  assert.deepEqual(normalizeStoredBookmarks([{ page: 0 }, { page: 1.5 }, { page: 3 }], 'pdf'), [{ page: 3 }]);
});

test('toggle adds, then removes', () => {
  const once = toggleBookmark([], { page: 4 });
  assert.deepEqual(once, [{ page: 4 }]);
  assert.deepEqual(toggleBookmark(once, { page: 4 }), []);
});

test('toggle keeps page order', () => {
  assert.deepEqual(toggleBookmark(toggleBookmark([], { page: 9 }), { page: 2 }), [{ page: 2 }, { page: 9 }]);
});

test('html toggle matches on heading index AND text', () => {
  const list = [{ headingIndex: 1, text: 'Intro' }];
  assert.deepEqual(toggleBookmark(list, { headingIndex: 1, text: 'Intro' }), []);
  assert.equal(toggleBookmark(list, { headingIndex: 1, text: 'Other' }).length, 2);
});

test('keys are per document', () => {
  assert.equal(bookmarkKey('abc'), 'bookmarks:abc');
});
