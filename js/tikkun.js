import { tokenize, toScroll } from './hebrew.js';
import { wrapStretchHtml } from './justify.js';

export const TIKKUN_DATA_URL = 'data/tikkun-torah-245.json';
export const TIKKUN_PAGE_WIDTH = 550;

const BOOK_NUMBER = {
  Genesis: 1,
  Exodus: 2,
  Leviticus: 3,
  Numbers: 4,
  Deuteronomy: 5,
};

let tikkunPromise = null;

export function loadTikkunData() {
  if (!tikkunPromise) {
    tikkunPromise = fetch(TIKKUN_DATA_URL).then((response) => {
      if (!response.ok) throw new Error(`Tikkun data returned ${response.status}`);
      return response.json();
    });
  }
  return tikkunPromise;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function refKey(ref) {
  return ref ? `${ref.book}:${ref.chapter}:${ref.verse}` : '';
}

function readingVerseRef(reading, verse) {
  const book = BOOK_NUMBER[reading && reading.book && reading.book.en];
  const chapter = verse.c || reading.chapter;
  const number = verse.v || verse.n;
  if (!book || !chapter || !number) return null;
  return { book, chapter, verse: number };
}

// tikkun.io stores ketiv/qere annotations with #, [] and {} markers. The bare
// STA"M view needs the written (ketiv) letters, without the annotation marks.
function writtenText(value) {
  return String(value || '')
    .replace(/#\(פ\)/g, '')
    .replace(/\((׆)\)#/g, '$1 ')
    .replace(/#\((׆)\)/g, ' $1')
    .split(/\s+/)
    .map((joined) => joined
      .split('־')
      .map((word) => {
        const parts = word.split('#');
        return parts.length > 1 ? parts.slice(1).join('') : parts[0];
      })
      .join('־'))
    .join(' ')
    .replace(/[\[\]{}]/g, '');
}

function sourceWords(value) {
  return tokenize(writtenText(value));
}

function localVerseMap(reading) {
  const map = new Map();
  (reading.verses || []).forEach((verse) => {
    const ref = readingVerseRef(reading, verse);
    if (!ref) return;
    map.set(refKey(ref), {
      n: verse.n,
      words: tokenize(verse.text).map((word) => toScroll(word)),
    });
  });
  return map;
}

function annotatePages(data, reading) {
  const local = localVerseMap(reading);
  const sourceIndexes = new Map();
  let currentRef = null;
  let atVerseBoundary = false;

  return (data.pages || []).map((page) => {
    const words = [];
    const lines = (page.lines || []).map((line, lineIndex) => {
      const starts = (line.verses || []).map((ref) => ({ ...ref }));
      const beginVerse = () => {
        currentRef = starts.shift() || null;
        atVerseBoundary = false;
      };

      const text = (line.text || []).map((column) => column.map((fragment) => {
        const fragmentWords = sourceWords(fragment).map((raw) => {
          if (starts.length) {
            const next = local.get(refKey(starts[0]));
            const beginsKnownVerse = next && next.words[0] === toScroll(raw);
            // Verse metadata identifies the line, not the exact word offset.
            // Match the next verse's known first word so a continuation at the
            // start of a line is not accidentally assigned to that next verse.
            if (!currentRef || (atVerseBoundary && beginsKnownVerse) || (!next && atVerseBoundary)) beginVerse();
          }
          const key = refKey(currentRef);
          const sourceIndex = sourceIndexes.get(key) || 0;
          sourceIndexes.set(key, sourceIndex + 1);
          const match = local.get(key);
          const word = {
            raw,
            text: toScroll(raw),
            verse: match ? match.n : null,
            widx: match && sourceIndex < match.words.length ? sourceIndex : null,
            exact: !!(match && match.words[sourceIndex] === toScroll(raw)),
          };
          words.push(word);
          // A sof pasuk normally precedes the next verse marker. In the
          // Decalogue's special upper/lower cantillation, however, extra sof
          // marks occur inside one numbered verse; wait for explicit metadata
          // before advancing rather than treating every mark as a new verse.
          if (raw.includes('\u05C3')) atVerseBoundary = true;
          return word;
        });
        return { words: fragmentWords, setuma: column.length > 1 };
      }));
      return { ...line, lineIndex, text, words: text.flatMap((column) => column.flatMap((fragment) => fragment.words)) };
    });
    return { number: page.number, lines, words };
  });
}

// Dual-column render calls annotatePages twice per click (bare STA"M, then
// pointed with renderWord). Walking every page of the corpus is the expensive
// part and does not depend on selectedVerse or renderWord, so remember the
// result by the identity of the tikkun payload and the reading doc. loadData
// assigns a new reading object; the tikkun JSON is reused across readings,
// which is why both keys are needed.
const _annotatedPages = new WeakMap(); // data → WeakMap(reading → pages)

function annotatedPages(data, reading) {
  let byReading = _annotatedPages.get(data);
  if (!byReading) {
    byReading = new WeakMap();
    _annotatedPages.set(data, byReading);
  }
  let pages = byReading.get(reading);
  if (!pages) {
    pages = annotatePages(data, reading);
    byReading.set(reading, pages);
  }
  return pages;
}

// The STA"M column's own glyph content and class list are computed here from
// the word's mapping to the reading; a caller can override just the glyph
// content (e.g. to substitute the pointed/coloured form) and add its own
// classes/attributes via options.renderWord, without having to reimplement
// the mapping-derived classes (ctx / out-of-range / sel / range-start).
function wordHtml(word, options) {
  const classes = ['scroll-word'];
  const attrs = [];
  const mapped = word.verse != null && word.widx != null;
  const inContext = mapped && word.verse >= options.contextStart && word.verse <= options.contextEnd;
  const inFocus = mapped && word.verse >= options.focusStart && word.verse <= options.focusEnd;

  if (mapped) {
    classes.push('sw');
    attrs.push(`data-verse="${word.verse}"`, `data-widx="${word.widx}"`);
    if (options.selectedVerse === word.verse) classes.push('sel');
    if (word.verse === options.focusStart && word.widx === 0) classes.push('range-start');
  }
  if (!inFocus) classes.push('ctx');
  if (!inContext) classes.push('out-of-range');
  if (mapped && !word.exact) classes.push('text-variant');

  // Default STA"M content wraps stretchable letters so the post-layout
  // justifier can elongate them. A custom renderWord (pointed column) is
  // responsible for doing the same inside its own HTML.
  let content = wrapStretchHtml(word.text);
  if (options.renderWord) {
    const custom = options.renderWord(word) || {};
    if (custom.html != null) content = custom.html;
    if (custom.classes) classes.push(...custom.classes);
    if (custom.attrs) attrs.push(...custom.attrs);
  }

  return `<span class="${classes.join(' ')}" ${attrs.join(' ')}>${content}</span>`;
}

function lineHtml(line, options) {
  const columns = line.text.map((column) => {
    const fragments = column.map((fragment) => {
      // No literal spaces between the word spans: the line is a flex row and the
      // inter-word spacing is the fragment's fixed gap (see .scroll-line-fragment).
      // Leftover width is absorbed after layout by elongating .stretch letters
      // (js/justify.js), the way a sofer fills a column — not by space-between.
      const words = fragment.words.map((word) => wordHtml(word, options)).join('');
      return `<span class="scroll-line-fragment${fragment.setuma ? ' setuma' : ''}">${words}</span>`;
    }).join('');
    return `<span class="scroll-line-column">${fragments}</span>`;
  }).join('');
  return `<div class="scroll-line${line.isPetucha ? ' petucha' : ''}" data-line="${line.lineIndex + 1}">${columns}</div>`;
}

// Empty lines keep the same 1.62em row height as a painted page, so a stub
// occupies the same scroll space as the real column. A long annual (or a long
// triennial third) can be dozens of Davidovich pages; painting every word of
// every page — twice in dual view — is what used to stall the pane.
function stubLineHtml(line) {
  return `<div class="scroll-line${line.isPetucha ? ' petucha' : ''}" data-line="${line.lineIndex + 1}"></div>`;
}

function pageInRange(page, options) {
  return page.words.some((word) =>
    word.verse != null &&
    word.verse >= options.contextStart &&
    word.verse <= options.contextEnd);
}

export function visibleTikkunPages(data, reading, options) {
  if (!data || !reading || !options) return [];
  return annotatedPages(data, reading).filter((page) => pageInRange(page, options));
}

// The page that should be on screen for a pasuk: the one that holds its first
// mapped word, falling back to the first in-range page so an unselected column
// still has somewhere to start.
export function tikkunPageForVerse(data, reading, options, verseN) {
  const pages = visibleTikkunPages(data, reading, options);
  if (!pages.length) return null;
  if (verseN == null) return pages[0];
  return pages.find((page) => page.words.some((word) =>
    word.verse === verseN && word.widx === 0))
    || pages.find((page) => page.words.some((word) => word.verse === verseN))
    || pages[0];
}

function pageShellHtml(page, inner, stub) {
  return `
    <div class="scroll-page-shell" data-page="${page.number}"${stub ? ' data-stub="1"' : ''}>
      <section class="scroll-page" aria-label="Tikkun column ${page.number}"${stub ? ' aria-hidden="true"' : ''}>
        <span class="scroll-page-number">עמוד ${page.number}</span>
        <div class="scroll-lines">
          ${inner}
        </div>
      </section>
    </div>
  `;
}

function renderPageHtml(page, options, stub) {
  const inner = stub
    ? page.lines.map(stubLineHtml).join('')
    : page.lines.map((line) => lineHtml(line, options)).join('');
  return pageShellHtml(page, inner, stub);
}

function hydrateSetFrom(options) {
  if (!options || options.hydratePages == null) return null;
  return new Set(options.hydratePages);
}

// One page, either fully painted or a height-matched stub. Used to swap a
// placeholder for real glyphs (or the reverse) without rebuilding the column.
export function renderTikkunPageHtml(data, reading, options, pageNumber) {
  if (!data || !reading || pageNumber == null) return null;
  const page = visibleTikkunPages(data, reading, options)
    .find((p) => p.number === pageNumber);
  if (!page) return null;
  return renderPageHtml(page, options, !!options.stub);
}

export function renderTikkunPages(data, reading, options) {
  if (!data || !reading) return null;
  const visiblePages = visibleTikkunPages(data, reading, options);
  if (!visiblePages.length) return null;

  const hydrate = hydrateSetFrom(options);
  const html = visiblePages.map((page) => {
    const stub = !!(hydrate && !hydrate.has(page.number));
    return renderPageHtml(page, options, stub);
  }).join('');

  const extraClass = options.columnClass ? ` ${escapeHtml(options.columnClass)}` : '';
  const id = options.columnId ? ` id="${escapeHtml(options.columnId)}"` : '';
  return {
    html: `<div class="scroll-column tikkun-column${extraClass}"${id}>${html}</div>`,
    pages: visiblePages.length,
    pageNumbers: visiblePages.map((page) => page.number),
    source: data.source,
  };
}
