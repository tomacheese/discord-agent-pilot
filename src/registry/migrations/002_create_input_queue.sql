CREATE TABLE input_queue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  source      TEXT NOT NULL,
  body        TEXT NOT NULL,
  state       TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
