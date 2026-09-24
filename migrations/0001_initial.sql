CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    password TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires INTEGER NOT NULL
  );

CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires);

CREATE TABLE IF NOT EXISTS entries (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    body TEXT NOT NULL,
    version INTEGER NOT NULL,
    PRIMARY KEY(user_id, day)
  );

CREATE TABLE IF NOT EXISTS limits (
    key TEXT PRIMARY KEY,
    count INTEGER NOT NULL,
    expires INTEGER NOT NULL
  );

CREATE INDEX IF NOT EXISTS limits_expiry ON limits(expires);
