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

Edit the SQLite file directly with any sqlite client. Schema:

    cards(id INTEGER PK, front TEXT, back TEXT, notes TEXT, tags TEXT)

Quick one-liner using Python:

    python3 -c "
    import sqlite3
    db = sqlite3.connect('cards/compsci.db')
    db.execute(
        'INSERT INTO cards (front, back, notes, tags) VALUES (?, ?, ?, ?)',
        ('question text', 'answer text', 'optional notes', 'optional,tags'),
    )
    db.commit()
    "

Then commit and push the updated `.db`. Existing SR progress is keyed by
`<deck>:<id>`, so adding new rows leaves prior progress intact — but reusing
or renumbering ids will silently re-bind them.

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
