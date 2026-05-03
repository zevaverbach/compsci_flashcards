# compsci_flashcards

Minimal vanilla-JS spaced-repetition flashcards. Card content lives in SQLite
files committed to the repo; spaced-repetition state lives in the browser's
`localStorage`.

## Layout

    index.html      shell, lists which decks to load
    app.js          loader (sql.js + IndexedDB cache) + SR engine + UI
    styles.css      bare monospace styling
    cards/*.db      SQLite decks fetched at runtime

## Run locally

`fetch()` won't work over `file://`, so serve the directory:

    python3 -m http.server 8000
    # open http://localhost:8000

## Adding cards

Each deck is a SQLite file in `cards/`. Schema:

    cards(id INTEGER PRIMARY KEY,
          front TEXT,    -- prompt
          back  TEXT,    -- canonical answer
          notes TEXT,    -- optional explanation, shown after reveal
          tags  TEXT)    -- optional, free-form

`id` is a stable handle: spaced-repetition progress is keyed by
`<deck>:<id>`, so adding new rows leaves prior progress intact. **Don't
renumber or reuse ids** — that will silently re-bind progress to different
content.

### Insert one

Pick the next id (`MAX(id) + 1`) and add a row. Easiest is a single Python
invocation:

    python3 - <<'PY'
    import sqlite3
    db = sqlite3.connect('cards/compsci.db')
    next_id = (db.execute('SELECT COALESCE(MAX(id), 0) + 1 FROM cards').fetchone()[0])
    db.execute(
        'INSERT INTO cards (id, front, back, notes, tags) VALUES (?, ?, ?, ?, ?)',
        (next_id, 'question text', 'answer text', 'optional notes', 'optional,tags'),
    )
    db.commit()
    print('inserted id', next_id)
    PY

Or with the `sqlite3` CLI:

    sqlite3 cards/compsci.db \
      "INSERT INTO cards (front, back, notes, tags) VALUES (
         'question text', 'answer text', 'optional notes', 'optional,tags');"

### Browse / edit / delete

    sqlite3 cards/compsci.db "SELECT id, front FROM cards ORDER BY id;"
    sqlite3 cards/compsci.db "UPDATE cards SET back='new answer' WHERE id=3;"
    sqlite3 cards/compsci.db "DELETE FROM cards WHERE id=3;"

After any change, commit the updated `.db` and push. Clients will pick up
the new content the next time their IndexedDB cache for that file expires
(7 days) or on hard-reload.

## Adding a new deck

1. Create `cards/<name>.db` with the schema above.
2. Append its path to `window.DECKS` in `index.html`.

## Spaced repetition

SM-2 flavoured. Grades are Again / Hard / Good / Easy (keys 1-4 after
revealing). State per card: `{ease, interval, reps, due, lapses, lastReviewed}`,
stored in `localStorage` under `flashcards_sr_v1`. The "reset" button in the
header wipes it.

## Caching

The browser keeps each `.db` in IndexedDB for 7 days. Re-pushing a `.db`
beyond that window invalidates automatically; before, users will see stale
content until the cache expires (or they hard-reload).
