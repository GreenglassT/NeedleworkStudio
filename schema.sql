-- DMC Thread Inventory Database Schema

CREATE TABLE IF NOT EXISTS threads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    number TEXT NOT NULL,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    hex_color TEXT,
    status TEXT DEFAULT 'dont_own',
    notes TEXT DEFAULT '',
    skein_qty REAL DEFAULT 0,     -- fractional skeins (e.g. 1.5 = one and a half)
    brand TEXT NOT NULL DEFAULT 'DMC'
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_threads_brand_number ON threads(brand, number);
CREATE INDEX IF NOT EXISTS idx_threads_number ON threads(number);
CREATE INDEX IF NOT EXISTS idx_threads_name ON threads(name);
CREATE INDEX IF NOT EXISTS idx_threads_category ON threads(category);
CREATE INDEX IF NOT EXISTS idx_threads_status ON threads(status);
CREATE INDEX IF NOT EXISTS idx_threads_brand ON threads(brand);

-- Per-user thread status (inventory isolation)
CREATE TABLE IF NOT EXISTS user_thread_status (
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    status    TEXT DEFAULT 'dont_own',
    notes     TEXT DEFAULT '',
    skein_qty REAL DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, thread_id)
);

CREATE INDEX IF NOT EXISTS idx_uts_user ON user_thread_status(user_id);
CREATE INDEX IF NOT EXISTS idx_uts_status ON user_thread_status(user_id, status);

-- Users table for authentication
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    is_active INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Saved cross-stitch patterns
CREATE TABLE IF NOT EXISTS saved_patterns (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    slug        TEXT    UNIQUE NOT NULL,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT    NOT NULL DEFAULT 'Untitled',
    grid_w      INTEGER NOT NULL,
    grid_h      INTEGER NOT NULL,
    color_count INTEGER NOT NULL,
    grid_data   TEXT    NOT NULL,   -- JSON array of DMC numbers
    legend_data TEXT    NOT NULL,   -- JSON array of legend objects
    thumbnail   TEXT,               -- base-64 PNG data URI (~5–15 KB)
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    progress_data  TEXT DEFAULT NULL,  -- JSON: {"completed_dmcs": [...]}
    project_status TEXT DEFAULT 'not_started',  -- not_started | in_progress | completed
    part_stitches_data TEXT DEFAULT '[]',  -- JSON array: half/quarter/three-quarter stitches
    backstitches_data  TEXT DEFAULT '[]',  -- JSON array: backstitch line segments
    knots_data         TEXT DEFAULT '[]',  -- JSON array: French knots
    brand              TEXT NOT NULL DEFAULT 'DMC'  -- 'DMC' | 'Anchor'
);

CREATE INDEX IF NOT EXISTS idx_sp_user ON saved_patterns(user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sp_slug ON saved_patterns(slug);

-- Pattern tags (user-defined labels for organizing patterns)
CREATE TABLE IF NOT EXISTS pattern_tags (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    color      TEXT DEFAULT NULL,  -- 'red','orange','gold','green','blue','purple','pink','gray'
    UNIQUE(user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_ptags_user ON pattern_tags(user_id);

CREATE TABLE IF NOT EXISTS pattern_tag_map (
    tag_id     INTEGER NOT NULL REFERENCES pattern_tags(id) ON DELETE CASCADE,
    pattern_id INTEGER NOT NULL REFERENCES saved_patterns(id) ON DELETE CASCADE,
    PRIMARY KEY (tag_id, pattern_id)
);

CREATE INDEX IF NOT EXISTS idx_ptm_pattern ON pattern_tag_map(pattern_id);

-- API tokens for sync authentication
CREATE TABLE IF NOT EXISTS api_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token TEXT UNIQUE NOT NULL,
    name TEXT DEFAULT 'Desktop Sync',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_api_tokens_token ON api_tokens(token);
CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);

-- Sync log for tracking hard deletes across sync
CREATE TABLE IF NOT EXISTS sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL,
    entity_key TEXT NOT NULL,
    action TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sync_log_user_ts ON sync_log(user_id, timestamp);
