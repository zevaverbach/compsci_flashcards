// Flashcards engine — vanilla JS, sql.js for SQLite, localStorage for SR state.
//
// Configuration is read from `window.DECKS` (set in index.html), an array of
// .db URLs. Each .db must have a `cards` table with columns:
//   id INTEGER PK, front TEXT, back TEXT, notes TEXT, tags TEXT
//
// Spaced-repetition state lives in localStorage under STORAGE_KEY, keyed by
// `<deck>:<id>`, so editing the .db preserves progress for unchanged ids.

const STORAGE_KEY        = 'flashcards_sr_v1';
const THEME_KEY          = 'flashcards_theme';
const THEME_CYCLE        = ['auto', 'light', 'dark'];
const DB_CACHE_NAME      = 'flashcards_db_cache';
const DB_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SQL_JS_BASE        = 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.11.0/';
const AGAIN_DELAY_MS     = 60 * 1000;
const HARD_FACTOR        = 1.2;
const EASY_BONUS         = 1.3;
const DAY_MS             = 24 * 60 * 60 * 1000;

let cards       = [];   // [{key, deck, id, front, back, notes, tags}]
let progress    = {};   // {key: {ease, interval, reps, due, lapses, lastReviewed}}
let currentCard = null;
let revealed    = false;

// ---------- IndexedDB cache for the .db blobs ----------

function openCacheDB() {
    return new Promise((res, rej) => {
        const r = indexedDB.open(DB_CACHE_NAME, 1);
        r.onupgradeneeded = () => r.result.createObjectStore('files');
        r.onsuccess = () => res(r.result);
        r.onerror   = () => rej(r.error);
    });
}

async function getCachedDB(url) {
    const db = await openCacheDB();
    return new Promise((res, rej) => {
        const tx = db.transaction('files', 'readonly');
        const r  = tx.objectStore('files').get(url);
        r.onsuccess = () => res(r.result || null);
        r.onerror   = () => rej(r.error);
    });
}

async function setCachedDB(url, bytes) {
    const db = await openCacheDB();
    return new Promise((res, rej) => {
        const tx = db.transaction('files', 'readwrite');
        tx.objectStore('files').put({ bytes, cachedAt: Date.now() }, url);
        tx.oncomplete = () => res();
        tx.onerror    = () => rej(tx.error);
    });
}

function withTimeout(p, ms) {
    return Promise.race([
        p,
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))
    ]);
}

// ---------- Deck loading ----------

async function fetchDeck(SQL, url) {
    let bytes  = null;
    let cached = null;
    try { cached = await withTimeout(getCachedDB(url), 1500); } catch (e) {}

    const stale = !cached || (Date.now() - cached.cachedAt) > DB_CACHE_MAX_AGE_MS;
    if (cached && !stale) {
        bytes = cached.bytes;
    } else {
        try {
            const res = await fetch(url, { cache: 'no-cache' });
            if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
            bytes = new Uint8Array(await res.arrayBuffer());
            try { await withTimeout(setCachedDB(url, bytes), 1500); } catch (e) {}
        } catch (err) {
            if (cached) { bytes = cached.bytes; }
            else        { throw err; }
        }
    }

    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const db = new SQL.Database(u8);
    const rows = db.exec('SELECT id, front, back, notes, tags FROM cards ORDER BY id');
    db.close();

    if (!rows.length) return [];
    const deck = url.split('/').pop().replace(/\.db$/, '');
    return rows[0].values.map(([id, front, back, notes, tags]) => ({
        key:   `${deck}:${id}`,
        deck,
        id,
        front,
        back,
        notes: notes || '',
        tags:  tags  || ''
    }));
}

async function loadDecks() {
    const SQL   = await initSqlJs({ locateFile: f => SQL_JS_BASE + f });
    const decks = (typeof window.DECKS !== 'undefined') ? window.DECKS : ['cards/compsci.db'];
    const all   = await Promise.all(decks.map(d => fetchDeck(SQL, d)));
    return all.flat();
}

// ---------- SR state ----------

function loadProgress() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }
    catch { return {}; }
}

function saveProgress() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
}

function newState() {
    return { ease: 2.5, interval: 0, reps: 0, due: 0, lapses: 0, lastReviewed: 0 };
}

function stateOf(card) {
    return progress[card.key] || newState();
}

// SM-2-flavoured: grade is 0 (Again), 3 (Hard), 4 (Good), 5 (Easy).
function applyGrade(card, grade) {
    const s   = { ...stateOf(card) };
    const now = Date.now();

    if (grade < 3) {
        s.reps     = 0;
        s.lapses  += 1;
        s.interval = 0;
        s.due      = now + AGAIN_DELAY_MS;
    } else {
        if      (s.reps === 0) s.interval = 1;
        else if (s.reps === 1) s.interval = 6;
        else if (grade === 3)  s.interval = Math.max(1, Math.round(s.interval * HARD_FACTOR));
        else                   s.interval = Math.max(1, Math.round(s.interval * s.ease * (grade === 5 ? EASY_BONUS : 1)));
        s.reps += 1;
        s.due   = now + s.interval * DAY_MS;
    }

    const q = grade;
    s.ease = Math.max(1.3, s.ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
    s.lastReviewed = now;

    progress[card.key] = s;
    saveProgress();
}

// ---------- Scheduling ----------

function pickNextCard() {
    const now = Date.now();
    const dueReviews = cards
        .filter(c => progress[c.key] && progress[c.key].due <= now)
        .sort((a, b) => progress[a.key].due - progress[b.key].due);
    if (dueReviews.length) return dueReviews[0];

    const fresh = cards.filter(c => !progress[c.key]);
    if (fresh.length) return fresh[Math.floor(Math.random() * fresh.length)];

    return null;
}

function nextDueAt() {
    let next = Infinity;
    for (const c of cards) {
        const s = progress[c.key];
        if (s && s.due < next) next = s.due;
    }
    return Number.isFinite(next) ? next : null;
}

// ---------- UI ----------

function el(id) { return document.getElementById(id); }

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
}

function render() {
    currentCard = pickNextCard();
    revealed    = false;

    const stage = el('stage');
    if (!currentCard) {
        const next = nextDueAt();
        const wait = next ? new Date(next).toLocaleString() : 'nothing scheduled';
        stage.innerHTML = `<div class="empty">No cards due.<br>Next review: ${escapeHtml(wait)}</div>`;
        updateStats();
        return;
    }

    const c   = currentCard;
    const isNew = !progress[c.key];
    stage.innerHTML = `
        <div class="meta">[${escapeHtml(c.deck)}] #${c.id}${isNew ? ' • new' : ''}${c.tags ? ' • ' + escapeHtml(c.tags) : ''}</div>
        <div class="front">${escapeHtml(c.front)}</div>
        <textarea id="answerInput" rows="6" placeholder="type your answer, then ctrl+enter to reveal" autofocus></textarea>
        <div class="actions"><button id="revealBtn">Show Answer (ctrl+enter)</button></div>
        <div id="answerArea"></div>
    `;
    const inp = el('answerInput');
    inp.focus();
    inp.addEventListener('keydown', e => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); reveal(); }
    });
    el('revealBtn').onclick = reveal;
    updateStats();
}

function reveal() {
    if (revealed || !currentCard) return;
    revealed = true;
    const c = currentCard;
    const userAnswer = (el('answerInput') || {}).value || '';
    el('answerArea').innerHTML = `
        ${userAnswer ? `<div class="user-answer"><pre>${escapeHtml(userAnswer)}</pre></div>` : ''}
        <div class="back"><pre>${escapeHtml(c.back)}</pre></div>
        ${c.notes ? `<div class="notes">${escapeHtml(c.notes)}</div>` : ''}
        <div class="grade">
            <button data-grade="0">Again [1]</button>
            <button data-grade="3">Hard  [2]</button>
            <button data-grade="4">Good  [3]</button>
            <button data-grade="5">Easy  [4]</button>
        </div>
    `;
    el('answerArea').querySelectorAll('button[data-grade]').forEach(b => {
        b.onclick = () => grade(parseInt(b.dataset.grade, 10));
    });
}

function grade(g) {
    if (!currentCard) return;
    applyGrade(currentCard, g);
    render();
}

function updateStats() {
    const total    = cards.length;
    const studied  = cards.filter(c => progress[c.key]).length;
    const now      = Date.now();
    const dueNow   = cards.filter(c => progress[c.key] && progress[c.key].due <= now).length;
    const fresh    = total - studied;
    el('stats').textContent = `${total} cards · ${studied} studied · ${dueNow} due · ${fresh} new`;
}

document.addEventListener('keydown', e => {
    if (!revealed) return;
    if (e.target && e.target.tagName === 'TEXTAREA') return;
    const map = { '1': 0, '2': 3, '3': 4, '4': 5 };
    if (e.key in map) { e.preventDefault(); grade(map[e.key]); }
});

async function reset() {
    if (!confirm('Reset all spaced-repetition progress?')) return;
    progress = {};
    localStorage.removeItem(STORAGE_KEY);
    render();
}

// ---------- Theme ----------

function getTheme() {
    const t = localStorage.getItem(THEME_KEY);
    return THEME_CYCLE.includes(t) ? t : 'auto';
}

function resolveDark(theme) {
    if (theme === 'dark')  return true;
    if (theme === 'light') return false;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function applyTheme(t) {
    if (t === 'auto') localStorage.removeItem(THEME_KEY);
    else              localStorage.setItem(THEME_KEY, t);
    const dark = resolveDark(t);
    const html = document.documentElement;
    html.classList.remove('light-mode', 'dark-mode');
    html.classList.add(dark ? 'dark-mode' : 'light-mode');
    const btn = el('themeBtn');
    if (btn) btn.textContent = `theme: ${t}`;
}

function cycleTheme() {
    const cur  = getTheme();
    const next = THEME_CYCLE[(THEME_CYCLE.indexOf(cur) + 1) % THEME_CYCLE.length];
    applyTheme(next);
}

// React to OS theme flips while in auto mode.
if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)')
        .addEventListener('change', () => { if (getTheme() === 'auto') applyTheme('auto'); });
}

// ---------- Boot ----------

async function boot() {
    applyTheme(getTheme());
    el('themeBtn').onclick = cycleTheme;
    el('stage').innerHTML = '<div class="loading">loading cards…</div>';
    try {
        cards    = await loadDecks();
        progress = loadProgress();
        el('resetBtn').onclick = reset;
        render();
    } catch (err) {
        el('stage').innerHTML = `<div class="error">failed to load: ${escapeHtml(err.message)}</div>`;
        console.error(err);
    }
}

boot();
