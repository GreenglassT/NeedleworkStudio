#!/usr/bin/env python3
"""Flask web application for DMC thread inventory management."""

import sys
import sqlite3
import os
import json
import uuid
import base64
import re
import math
import io
import time
import shutil
import zipfile
import logging
import secrets
import string
import hashlib
from datetime import datetime, timedelta

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s'
)

# PyInstaller frozen-mode: resolve paths from the temp bundle directory
if getattr(sys, 'frozen', False):
    _BUNDLE_DIR = sys._MEIPASS
else:
    _BUNDLE_DIR = os.path.dirname(os.path.abspath(__file__))

# Fix for colormath compatibility with numpy >= 2.0
import numpy as np
if not hasattr(np, 'asscalar'):
    np.asscalar = lambda a: a.item()

from urllib.parse import urlparse
from flask import Flask, render_template, request, jsonify, redirect, url_for, session, send_file, send_from_directory, g
from flask_login import LoginManager, UserMixin, login_user, logout_user, login_required, current_user
from flask_wtf.csrf import CSRFProtect
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from werkzeug.middleware.proxy_fix import ProxyFix
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from colormath.color_objects import sRGBColor, LabColor
from colormath.color_conversions import convert_color
from colormath.color_diff import delta_e_cie2000
from PIL import Image, ImageEnhance, ImageDraw
Image.MAX_IMAGE_PIXELS = 50_000_000  # 50 MP cap — prevents decompression bombs

# ── Upload / payload size limits ──────────────────────────────
MAX_PDF_SIZE = 25 * 1024 * 1024        # 25 MB
MAX_IMAGE_SIZE = 10 * 1024 * 1024      # 10 MB
MAX_PATTERN_DATA = 2 * 1024 * 1024     # 2 MB (grid + legend JSON)
MAX_PATTERN_FULL = 4 * 1024 * 1024     # 4 MB (full pattern update)
MAX_THUMBNAIL = 500_000                # 500 KB (base64 thumbnail)
MAX_PROGRESS_DATA = 256 * 1024         # 256 KB

import pdfplumber
import pypdfium2 as pdfium

app = Flask(__name__,
            template_folder=os.path.join(_BUNDLE_DIR, 'templates'),
            static_folder=os.path.join(_BUNDLE_DIR, 'static'))

# Desktop mode — set DESKTOP_MODE=1 to auto-login without credentials
DESKTOP_MODE = os.environ.get('DESKTOP_MODE', '').lower() in ('1', 'true')

# Data directory — configurable for desktop packaging (Electron userData)
# Defaults to app directory for web/server deployment
DATA_DIR = os.environ.get('NEEDLEWORK_DATA_DIR', _BUNDLE_DIR)

# Pre-computed thread palette in LAB space, populated once at startup
_PALETTE_LAB = {}  # {thread_id: {'lab': LabColor, 'hex': str, 'name': str, 'category': str, 'brand': str, 'number': str}}


def _get_secret_key():
    if os.environ.get('SECRET_KEY'):
        return os.environ['SECRET_KEY']
    key_file = os.path.join(DATA_DIR, '.secret_key')
    if os.path.exists(key_file):
        with open(key_file) as f:
            return f.read().strip()
    os.makedirs(DATA_DIR, exist_ok=True)
    key = os.urandom(32).hex()
    with open(key_file, 'w') as f:
        f.write(key)
    os.chmod(key_file, 0o600)
    return key


app.config['SECRET_KEY'] = _get_secret_key()
_https_enabled = os.environ.get('HTTPS', 'false').lower() == 'true' and not DESKTOP_MODE
app.config['REMEMBER_COOKIE_DURATION'] = timedelta(days=30)
app.config['REMEMBER_COOKIE_HTTPONLY'] = True
app.config['REMEMBER_COOKIE_SECURE'] = _https_enabled
app.config['REMEMBER_COOKIE_SAMESITE'] = 'Strict'
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SECURE'] = _https_enabled
app.config['SESSION_COOKIE_SAMESITE'] = 'Strict'
app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(hours=12)
app.config['SESSION_REFRESH_EACH_REQUEST'] = True
app.config['MAX_CONTENT_LENGTH'] = MAX_PDF_SIZE  # match largest upload limit

# Trust X-Forwarded-For from reverse proxy (Nginx) for correct rate-limit keying
if not DESKTOP_MODE:
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

# CSRF protection — validates X-CSRFToken header on all state-changing requests
csrf = CSRFProtect(app)

# Rate limiting — in-process memory store requires single-worker mode
# (gunicorn -w 1 --threads 4) for limits to be effective across requests.
limiter = Limiter(get_remote_address, app=app, storage_uri="memory://",
                  enabled=not DESKTOP_MODE)

DB_PATH = os.path.join(DATA_DIR, 'dmc_threads.db')
UPLOADS_DIR = os.path.join(DATA_DIR, 'uploads')
os.makedirs(UPLOADS_DIR, exist_ok=True)
MIN_DISK_FREE_MB = 100  # refuse uploads if <100 MB free


def _check_disk_space():
    """Return True if sufficient disk space is available for uploads."""
    try:
        usage = shutil.disk_usage(UPLOADS_DIR)
        return usage.free > MIN_DISK_FREE_MB * 1024 * 1024
    except OSError:
        return True  # allow if can't check


# Initialize Flask-Login
login_manager = LoginManager()
login_manager.init_app(app)
login_manager.login_view = 'login'
login_manager.login_message = 'Please log in to access this page.'


@login_manager.unauthorized_handler
def unauthorized():
    """Return 401 JSON for fetch/AJAX requests, redirect otherwise."""
    if request.is_json or request.headers.get('X-Requested-With') == 'fetch':
        return jsonify({'error': 'Session expired. Please log in again.'}), 401
    return redirect(url_for('login', next=request.path))


@app.errorhandler(400)
def csrf_error(e):
    """Return 400 JSON for CSRF failures on fetch requests."""
    if request.is_json or request.headers.get('X-Requested-With') == 'fetch':
        return jsonify({'error': 'Invalid or missing CSRF token. Please reload the page.'}), 400
    return e


@app.errorhandler(404)
def not_found(e):
    if request.is_json or request.headers.get('X-Requested-With') == 'fetch':
        return jsonify({'error': 'Not found.'}), 404
    return render_template('error.html', code=404, message="Page not found",
                           detail="The page you're looking for doesn't exist or has been moved."), 404


@app.errorhandler(429)
def rate_limited(e):
    if request.is_json or request.headers.get('X-Requested-With') == 'fetch':
        return jsonify({'error': 'Too many attempts. Please wait a minute and try again.'}), 429
    return render_template('error.html', code=429, message="Too many requests",
                           detail="You've made too many attempts. Please wait a minute and try again."), 429


@app.errorhandler(500)
def server_error(e):
    if request.is_json or request.headers.get('X-Requested-With') == 'fetch':
        return jsonify({'error': 'Internal server error.'}), 500
    return render_template('error.html', code=500, message="Something went wrong",
                           detail="An unexpected error occurred. Please try again later."), 500


# Static file caching — CSS/JS/images get 1-week cache, busted by ?v=<mtime>
_static_mtime_cache = {}  # filename -> mtime string


@app.after_request
def add_security_headers(response):
    # Cache static assets for 1 week (busted by ?v=<mtime>);
    # HTML pages must always revalidate so deploys take effect immediately
    if request.path.startswith('/static/'):
        response.headers['Cache-Control'] = 'public, max-age=604800'
    else:
        response.headers['Cache-Control'] = 'no-cache'

    # Security headers
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['Referrer-Policy'] = 'strict-origin-when-cross-origin'
    response.headers['Permissions-Policy'] = 'camera=(), microphone=(), geolocation=()'

    if _https_enabled:
        response.headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains'

    # Content Security Policy
    response.headers['Content-Security-Policy'] = "; ".join([
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "font-src 'self'",
        "img-src 'self' data: blob:",
        "connect-src 'self'",
        "frame-ancestors 'none'",
    ])

    # Strip server version header to prevent information disclosure
    response.headers.pop('Server', None)

    return response


def _versioned_url_for(endpoint, **values):
    """Override url_for to append ?v=<mtime> for static files."""
    if endpoint == 'static':
        filename = values.get('filename', '')
        if filename:
            # In debug mode, always check mtime; in production, cache it
            if app.debug or filename not in _static_mtime_cache:
                filepath = os.path.join(app.static_folder, filename)
                try:
                    _static_mtime_cache[filename] = str(int(os.path.getmtime(filepath)))
                except OSError:
                    _static_mtime_cache[filename] = '0'
            values['v'] = _static_mtime_cache[filename]
    return url_for(endpoint, **values)


@app.context_processor
def override_url_for():
    return dict(url_for=_versioned_url_for)


@app.route('/robots.txt')
def robots_txt():
    """Disallow all crawling — everything is behind login."""
    return "User-agent: *\nDisallow: /\n", 200, {'Content-Type': 'text/plain'}


@app.route('/manifest.json')
def manifest_json():
    return send_from_directory(app.static_folder, 'manifest.json',
                               mimetype='application/manifest+json')


# Initialize password hasher
ph = PasswordHasher()
_dummy_hash = ph.hash('timing-attack-dummy')  # constant-time login for non-existent users


class User(UserMixin):
    """User model for Flask-Login."""

    def __init__(self, id, username, email, is_active=True):
        self.id = id
        self.username = username
        self.email = email
        self._is_active = is_active

    @property
    def is_active(self):
        return self._is_active

    @staticmethod
    def get_by_id(user_id):
        """Retrieve user by ID."""
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("SELECT id, username, email, is_active FROM users WHERE id = ?", (user_id,))
        row = cursor.fetchone()

        if row:
            return User(row['id'], row['username'], row['email'], bool(row['is_active']))
        return None

    @staticmethod
    def get_by_username(username):
        """Retrieve user by username."""
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("SELECT id, username, email, password_hash, is_active FROM users WHERE username = ?", (username,))
        row = cursor.fetchone()
        return row

    @staticmethod
    def verify_password(stored_hash, password):
        """Verify password against stored hash. Returns (valid, new_hash_or_None)."""
        try:
            ph.verify(stored_hash, password)
            new_hash = ph.hash(password) if ph.check_needs_rehash(stored_hash) else None
            return True, new_hash
        except VerifyMismatchError:
            return False, None

    @staticmethod
    def update_last_login(user_id):
        """Update last login timestamp."""
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?", (user_id,))
        conn.commit()


@login_manager.user_loader
def load_user(user_id):
    """Load user by ID for Flask-Login."""
    return User.get_by_id(int(user_id))


# --- Desktop mode: auto-login for single-user desktop packaging ---
_desktop_user_id = None  # set during startup if DESKTOP_MODE is active


def _ensure_desktop_user():
    """Create a default local user if none exist. Returns the user ID."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    row = conn.execute("SELECT id FROM users LIMIT 1").fetchone()
    if row:
        user_id = row['id']
    else:
        password = secrets.token_urlsafe(32)
        password_hash = ph.hash(password)
        cur = conn.execute(
            "INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)",
            ('Desktop User', 'desktop@local', password_hash)
        )
        conn.commit()
        user_id = cur.lastrowid
        logging.info("Desktop mode: created default user (id=%d)", user_id)
    conn.close()
    return user_id


@app.before_request
def _desktop_auto_login():
    """In desktop mode, auto-login the desktop user on every request."""
    if not DESKTOP_MODE or _desktop_user_id is None:
        return
    if current_user.is_authenticated:
        return
    user = User.get_by_id(_desktop_user_id)
    if user:
        login_user(user, remember=True)
        session.permanent = True


@app.context_processor
def _inject_desktop_mode():
    return dict(desktop_mode=DESKTOP_MODE)


@app.context_processor
def _inject_user_prefs():
    if current_user.is_authenticated:
        return dict(user_prefs=_get_user_prefs(current_user.id))
    return dict(user_prefs={})


# --- API token authentication for sync ---
from functools import wraps


def api_token_required(f):
    """Decorator that authenticates via Bearer token instead of session/CSRF."""
    @wraps(f)
    def decorated(*args, **kwargs):
        auth = request.headers.get('Authorization', '')
        if not auth.startswith('Bearer '):
            return jsonify({'error': 'Missing or invalid Authorization header'}), 401
        token = auth[7:]
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        conn = get_db()
        row = conn.execute(
            "SELECT t.id, t.user_id, u.username, u.email, u.is_active "
            "FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token = ?",
            (token_hash,)).fetchone()
        if not row:
            return jsonify({'error': 'Invalid API token'}), 401
        if not row['is_active']:
            return jsonify({'error': 'Account disabled'}), 403
        # Update last_used_at
        conn.execute("UPDATE api_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?", (row['id'],))
        conn.commit()
        # Set up user context for the request
        user = User(row['user_id'], row['username'], row['email'])
        login_user(user, remember=False)
        g.api_token_id = row['id']
        return f(*args, **kwargs)
    return decorated


def get_db():
    """Get database connection (one per request, auto-closed by teardown)."""
    if 'db' not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
    return g.db


def _get_db_direct():
    """Get a standalone DB connection for use outside request context (startup)."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


@app.teardown_appcontext
def close_db(exception):
    db = g.pop('db', None)
    if db is not None:
        db.close()


_SLUG_CHARS = string.ascii_letters + string.digits  # 62 chars (a-z, A-Z, 0-9)


def _generate_slug(length=8):
    """Generate a random URL-safe slug for pattern URLs."""
    return ''.join(secrets.choice(_SLUG_CHARS) for _ in range(length))


def _ensure_saved_patterns_table():
    conn = _get_db_direct()
    conn.execute("""CREATE TABLE IF NOT EXISTS saved_patterns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL DEFAULT 'Untitled',
        grid_w INTEGER NOT NULL, grid_h INTEGER NOT NULL,
        color_count INTEGER NOT NULL,
        grid_data TEXT NOT NULL, legend_data TEXT NOT NULL,
        thumbnail TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)""")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sp_user ON saved_patterns(user_id, created_at DESC)")
    # Migrate: add source_image_path and generation_settings if missing
    cur = conn.execute("PRAGMA table_info(saved_patterns)")
    existing = {row['name'] for row in cur.fetchall()}
    if 'source_image_path' not in existing:
        conn.execute("ALTER TABLE saved_patterns ADD COLUMN source_image_path TEXT")
    if 'generation_settings' not in existing:
        conn.execute("ALTER TABLE saved_patterns ADD COLUMN generation_settings TEXT")
    if 'progress_data' not in existing:
        conn.execute("ALTER TABLE saved_patterns ADD COLUMN progress_data TEXT DEFAULT NULL")
    if 'project_status' not in existing:
        conn.execute("ALTER TABLE saved_patterns ADD COLUMN project_status TEXT DEFAULT 'not_started'")
    if 'part_stitches_data' not in existing:
        conn.execute("ALTER TABLE saved_patterns ADD COLUMN part_stitches_data TEXT DEFAULT '[]'")
    if 'backstitches_data' not in existing:
        conn.execute("ALTER TABLE saved_patterns ADD COLUMN backstitches_data TEXT DEFAULT '[]'")
    if 'knots_data' not in existing:
        conn.execute("ALTER TABLE saved_patterns ADD COLUMN knots_data TEXT DEFAULT '[]'")
    if 'beads_data' not in existing:
        conn.execute("ALTER TABLE saved_patterns ADD COLUMN beads_data TEXT DEFAULT '[]'")
    if 'slug' not in existing:
        conn.execute("ALTER TABLE saved_patterns ADD COLUMN slug TEXT")
        # Backfill existing patterns with random slugs
        rows = conn.execute("SELECT id FROM saved_patterns WHERE slug IS NULL").fetchall()
        for row in rows:
            for _retry in range(10):
                slug = _generate_slug()
                try:
                    conn.execute("UPDATE saved_patterns SET slug = ? WHERE id = ?",
                                 (slug, row['id']))
                    break
                except sqlite3.IntegrityError:
                    continue  # slug collision, retry
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_sp_slug ON saved_patterns(slug)")
    if 'fabric_color' not in existing:
        conn.execute("ALTER TABLE saved_patterns ADD COLUMN fabric_color TEXT DEFAULT '#F5F0E8'")
    if 'notes' not in existing:
        conn.execute("ALTER TABLE saved_patterns ADD COLUMN notes TEXT DEFAULT ''")
    # --- Pattern tags ---
    conn.execute("""CREATE TABLE IF NOT EXISTS pattern_tags (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        color      TEXT DEFAULT NULL,
        UNIQUE(user_id, name))""")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_ptags_user ON pattern_tags(user_id)")
    conn.execute("""CREATE TABLE IF NOT EXISTS pattern_tag_map (
        tag_id     INTEGER NOT NULL REFERENCES pattern_tags(id) ON DELETE CASCADE,
        pattern_id INTEGER NOT NULL REFERENCES saved_patterns(id) ON DELETE CASCADE,
        PRIMARY KEY (tag_id, pattern_id))""")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_ptm_pattern ON pattern_tag_map(pattern_id)")
    conn.commit()
    conn.close()


def _ensure_threads_columns():
    conn = _get_db_direct()
    cols = {r['name'] for r in conn.execute("PRAGMA table_info(threads)").fetchall()}
    if 'skein_qty' not in cols:
        conn.execute("ALTER TABLE threads ADD COLUMN skein_qty INTEGER DEFAULT 0")
        conn.commit()
    if 'brand' not in cols:
        conn.execute("ALTER TABLE threads ADD COLUMN brand TEXT NOT NULL DEFAULT 'DMC'")
        conn.commit()

    # Check for lingering UNIQUE constraint on number alone (sqlite_autoindex).
    # SQLite auto-indexes from column UNIQUE constraints can't be dropped, so we
    # must recreate the table without it.
    has_auto_unique = any(
        r[1].startswith('sqlite_autoindex_threads')
        for r in conn.execute("PRAGMA index_list(threads)").fetchall()
    )
    if has_auto_unique:
        app.logger.info("Rebuilding threads table to remove column-level UNIQUE on number")
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS threads_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                number TEXT NOT NULL,
                name TEXT NOT NULL,
                category TEXT NOT NULL,
                hex_color TEXT,
                status TEXT DEFAULT 'dont_own',
                notes TEXT DEFAULT '',
                skein_qty REAL DEFAULT 0,
                brand TEXT NOT NULL DEFAULT 'DMC'
            );
            INSERT INTO threads_new SELECT id, number, name, category, hex_color, status, notes, skein_qty, brand FROM threads;
            DROP TABLE threads;
            ALTER TABLE threads_new RENAME TO threads;
        """)
        conn.commit()

    # Ensure indexes exist
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_threads_brand_number ON threads(brand, number)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_threads_brand ON threads(brand)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_threads_number ON threads(number)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_threads_name ON threads(name)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_threads_category ON threads(category)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_threads_status ON threads(status)")
    conn.commit()

    # Seed Anchor threads if not present
    count = conn.execute("SELECT COUNT(*) FROM threads WHERE brand = 'Anchor'").fetchone()[0]
    if count < 400:
        _seed_anchor_threads(conn)
    conn.close()


def _seed_anchor_threads(conn):
    """Insert Anchor thread data into an existing database."""
    from anchor_threads import ANCHOR_THREADS
    inserted = 0
    for number, name, hex_color in ANCHOR_THREADS:
        try:
            conn.execute(
                "INSERT INTO threads (number, name, category, hex_color, brand) VALUES (?, ?, 'Standard', ?, 'Anchor')",
                (number, name, hex_color)
            )
            inserted += 1
        except Exception:
            pass  # skip duplicates
    conn.commit()
    app.logger.info("Seeded %d Anchor threads", inserted)


def _migrate_user_preferences():
    """Add preferences column to users table if missing."""
    conn = _get_db_direct()
    cols = {r['name'] for r in conn.execute("PRAGMA table_info(users)").fetchall()}
    if 'preferences' not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN preferences TEXT DEFAULT '{}'")
        conn.commit()
        app.logger.info("Added preferences column to users table")
    conn.close()


def _pdf_parse_cover(page):
    """Return (grid_w, grid_h, title) from cover page."""
    text = page.extract_text() or ''
    m = re.search(r'Design size:\s*(\d+)\s*[×xX]\s*(\d+)', text)
    if not m:
        raise ValueError("Could not find design dimensions")
    w, h = int(m.group(1)), int(m.group(2))
    if w < 1 or h < 1 or w > 10000 or h > 10000:
        raise ValueError(f"Grid dimensions out of range: {w}×{h}")
    lines = [l.strip() for l in text.split('\n') if l.strip()]
    title = lines[0] if lines else 'Imported Pattern'
    return w, h, title


def _pdf_parse_legend(page):
    """Return list of {dmc, brand, name, legend_count} from legend page text.

    Supports DMC (``DMC 310 Black 245``) and Anchor (``Anchor 1 White 245``
    or ``ANC 1 White 245``) legend formats.
    """
    text = page.extract_text() or ''
    entries = []
    seen = set()
    for line in text.split('\n'):
        stripped = line.strip()
        # DMC: "DMC 310 Black 245"
        m = re.search(r'DMC\s+(\S+)\s+([\w\s\-\.\/]+?)\s+(\d+)\s*$', stripped)
        if m:
            brand, number = 'DMC', m.group(1).strip()
            name, count = m.group(2).strip(), int(m.group(3))
        else:
            # Anchor: "Anchor 1 White 245" or "ANC 1 White 245"
            m = re.search(r'(?:Anchor|ANC)\s+(\d+)\s+([\w\s\-\.\/]+?)\s+(\d+)\s*$',
                          stripped, re.IGNORECASE)
            if m:
                brand, number = 'Anchor', m.group(1).strip()
                name, count = m.group(2).strip(), int(m.group(3))
            else:
                continue
        key = f'{brand}:{number}'
        if key not in seen:
            entries.append({'dmc': number, 'brand': brand, 'name': name, 'legend_count': count})
            seen.add(key)
    return entries


def _pdf_grid_offset(pl_page, x_vals, top_vals, x_rank, y_rank, cell_w_pt, grid_w, grid_h):
    """
    Use ruler tick labels on a grid page to find col_start / row_start —
    the absolute (1-indexed) grid column/row that corresponds to rank 0 in
    x_vals / top_vals.

    Column ticks live in the TOP MARGIN (above the stitch area).
    Row ticks live in the LEFT MARGIN (left of the stitch area).
    We collect all matching ticks and take the mode so one stray number
    (e.g. a footer page-number digit) cannot corrupt the result.

    Rank is computed via floor-division of the tick's position relative to the
    grid origin, so it is correct regardless of whether the tick label sits at
    the top, centre, or bottom of its cell.

    Returns (col_start, row_start).  Falls back to 1 if no ticks are found.
    """
    if not x_vals or not top_vals:
        return 1, 1, False, False

    words     = pl_page.extract_words()
    grid_left = x_vals[0]
    grid_top  = top_vals[0]
    # Vertical pitch may differ from image width (cells can be taller than wide).
    row_pitch = (top_vals[1] - top_vals[0]) if len(top_vals) >= 2 else cell_w_pt

    col_offsets = []
    row_offsets = []

    for w in words:
        try:
            n = int(w['text'])
        except ValueError:
            continue
        if not (1 <= n <= max(grid_w, grid_h)):
            continue

        wx = (w['x0'] + w['x1']) / 2
        wy = (w['top'] + w['bottom']) / 2

        # Column tick: in the top margin, label sits at the LEFT edge of its
        # column.  Floor-division maps that correctly to rank n-1.
        if n <= grid_w and w['bottom'] <= grid_top + 2.5 * cell_w_pt:
            rel_x = wx - grid_left
            if rel_x >= 0:
                rank = min(int(rel_x / cell_w_pt), len(x_vals) - 1)
                col_offsets.append(n - rank)

        # Row tick: the PDF places the label at the horizontal grid LINE
        # *after* the labelled row (i.e. at the top edge of the next row in
        # pdfplumber coordinates).  That makes rel_y = n * row_pitch, so
        # ceil(rel_y/row_pitch)-1 maps "line after row n" → rank n-1 correctly.
        # Using row_pitch (not cell_w_pt) is critical when rows are taller than wide.
        if n <= grid_h and w['x1'] <= grid_left + 2.5 * cell_w_pt:
            rel_y = wy - grid_top
            if rel_y >= 0:
                rank = min(max(0, math.ceil(rel_y / row_pitch) - 1), len(top_vals) - 1)
                row_offsets.append(n - rank)

    def _mode(lst):
        """Return the most common value; ties broken by first occurrence."""
        if not lst:
            return 1
        best, best_n = lst[0], 0
        counts = {}
        for v in lst:
            counts[v] = counts.get(v, 0) + 1
            if counts[v] > best_n:
                best, best_n = v, counts[v]
        return best

    return _mode(col_offsets), _mode(row_offsets), bool(col_offsets), bool(row_offsets)


# ── Shared validation / serialization helpers ────────────────────

def _validate_grid_dims(grid_w, grid_h):
    """Validate grid dimensions. Return (True, None) or (False, error_message)."""
    if not isinstance(grid_w, int) or isinstance(grid_w, bool) or \
       not isinstance(grid_h, int) or isinstance(grid_h, bool):
        return False, 'grid_w and grid_h must be integers'
    if grid_w < 1 or grid_h < 1 or grid_w > 500 or grid_h > 500:
        return False, 'Grid dimensions out of range (1-500)'
    return True, None


def _lookup_threads_by_number(conn, user_id, brand, numbers, extra_fields=()):
    """Look up threads by brand + number list with per-user status.

    Always returns: number, hex_color, name, category, status.
    Pass extra_fields=('id', 'skein_qty') for additional columns.
    Returns dict keyed by thread number.
    """
    if not numbers:
        return {}
    base_cols = ['t.number', 't.hex_color', 't.name', 't.category',
                 "COALESCE(u.status, 'dont_own') AS status"]
    if 'id' in extra_fields:
        base_cols.insert(0, 't.id')
    if 'skein_qty' in extra_fields:
        base_cols.append("COALESCE(u.skein_qty, 0) AS skein_qty")
    ph = ','.join('?' * len(numbers))
    rows = conn.execute(
        f"""SELECT {', '.join(base_cols)}
            FROM threads t
            LEFT JOIN user_thread_status u ON u.thread_id = t.id AND u.user_id = ?
            WHERE t.brand = ? AND t.number IN ({ph})""",
        [user_id, brand] + list(numbers)
    ).fetchall()
    return {r['number']: r for r in rows}


def _insert_pattern_with_slug(cursor, **kwargs):
    """Insert a saved pattern with auto-generated slug, retrying on collision.

    Returns the slug on success, or None after 5 failed attempts.
    """
    for _attempt in range(5):
        slug = _generate_slug()
        try:
            cursor.execute(
                """INSERT INTO saved_patterns
                       (slug, user_id, name, grid_w, grid_h, color_count, grid_data, legend_data,
                        thumbnail, source_image_path, generation_settings,
                        part_stitches_data, backstitches_data, knots_data, beads_data, brand, fabric_color)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (slug, kwargs['user_id'], kwargs['name'], kwargs['grid_w'], kwargs['grid_h'],
                 kwargs['color_count'], kwargs['grid_json'], kwargs['legend_json'],
                 kwargs.get('thumbnail'), kwargs.get('source_image_path'),
                 kwargs.get('gen_settings_json'),
                 kwargs['ps_json'], kwargs['bs_json'], kwargs['kn_json'], kwargs['bd_json'],
                 kwargs.get('brand', 'DMC'), kwargs.get('fabric_color', '#F5F0E8'))
            )
            return slug
        except sqlite3.IntegrityError:
            continue
    return None


def _serialize_stitch_layers(data):
    """Serialize part_stitches/backstitches/knots/beads from request data.
    Handles lists (serialize), strings (pass through), or None (default '[]').
    Returns (ps_json, bs_json, kn_json, bd_json)."""
    def _ser(v):
        if isinstance(v, list): return json.dumps(v)
        if isinstance(v, str):  return v
        return '[]'
    ps = data.get('part_stitches') or data.get('part_stitches_data')
    bs = data.get('backstitches') or data.get('backstitches_data')
    kn = data.get('knots') or data.get('knots_data')
    bd = data.get('beads') or data.get('beads_data')
    return _ser(ps), _ser(bs), _ser(kn), _ser(bd)


def _parse_progress_data(pd_json):
    """Parse progress_data JSON string, return safe dict with counts."""
    try:
        pd = json.loads(pd_json) if pd_json else {}
        return {
            'completed_count': len(pd.get('completed_dmcs', [])),
            'stitched_cell_count': len(pd.get('stitched_cells', [])),
            'accumulated_seconds': pd.get('accumulated_seconds', 0),
        }
    except (json.JSONDecodeError, KeyError, TypeError):
        return {'completed_count': 0, 'stitched_cell_count': 0, 'accumulated_seconds': 0}


def _import_pdf_pattern(pdf_bytes):
    """
    Main orchestrator. Returns:
    {
      'title': str,
      'grid_w': int, 'grid_h': int,
      'grid': [dmc_str_or_BG, ...],  # length = grid_w * grid_h, row-major
      'legend': [{dmc, name, hex, count, status, category}, ...]
    }
    """
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as plumber_pdf:
        pdfium_doc = pdfium.PdfDocument(pdf_bytes)
        try:
            return _import_pdf_body(plumber_pdf, pdfium_doc)
        finally:
            pdfium_doc.close()


def _import_pdf_body(plumber_pdf, pdfium_doc):
    """Inner logic for PDF pattern import — called with managed resources."""
    # -- Cover --
    grid_w, grid_h, title = _pdf_parse_cover(plumber_pdf.pages[0])

    # -- Legend (last page) --
    legend_entries = _pdf_parse_legend(plumber_pdf.pages[-1])
    if not legend_entries:
        raise ValueError("No thread entries found in legend (expected DMC or Anchor)")

    # Build color reference from app's thread database (with per-user status)
    db = get_db()
    uid = current_user.id
    # Query threads for each brand present in the legend
    _thread_info = {}
    for brand in {e['brand'] for e in legend_entries}:
        brand_numbers = [e['dmc'] for e in legend_entries if e['brand'] == brand]
        _thread_info.update(_lookup_threads_by_number(db, uid, brand, brand_numbers))
    dmc_hex = {}
    for e in legend_entries:
        row = _thread_info.get(e['dmc'])
        dmc_hex[e['dmc']] = (row['hex_color'].lstrip('#') if row and row['hex_color'] else 'cccccc')
    dmc_rgb = {dmc: tuple(int(h[i:i+2], 16) for i in (0,2,4)) for dmc, h in dmc_hex.items()}

    # -- Grid page(s): all pages between cover and legend --
    SCALE = 4.0
    BUFFER  = 4
    work_w  = grid_w + 2 * BUFFER
    work_h  = grid_h + 2 * BUFFER
    result  = ['BG'] * (work_w * work_h)
    grid_pages = list(range(1, len(plumber_pdf.pages) - 1))

    # ── Phase 1: collect rank maps and group cells by PDF image name ──────────
    # In these PDFs every cell of the same DMC color reuses the identical
    # image resource (I1, I2, …).  We use the name as a key instead of trying
    # to match sampled pixel colors — much more reliable.
    page_info   = {}   # page_idx → positioning data
    img_by_name = {}   # image_name → [(page_idx, img), ...]

    for page_idx in grid_pages:
        pl_page = plumber_pdf.pages[page_idx]
        imgs    = pl_page.images
        if not imgs:
            continue

        # Only use named images (stitch cells) for rank maps and cell size.
        # Unnamed images are decorative elements (logos, borders, etc.) that
        # would otherwise inflate ranks and shift all stitch rows off by one.
        named_imgs = [img for img in imgs if img.get('name', '')]
        if not named_imgs:
            continue

        page_h_pt = pl_page.height
        cell_w_pt = float(named_imgs[0]['x1'] - named_imgs[0]['x0'])
        CELL_PX   = max(1, round(cell_w_pt * SCALE))

        x_vals   = sorted(set(round(img['x0'],          1) for img in named_imgs))
        top_vals = sorted(set(round(page_h_pt - img['y1'], 1) for img in named_imgs))
        x_rank   = {v: i for i, v in enumerate(x_vals)}
        y_rank   = {v: i for i, v in enumerate(top_vals)}

        col_start, row_start, col_reliable, row_reliable = _pdf_grid_offset(
            pl_page, x_vals, top_vals, x_rank, y_rank, cell_w_pt, grid_w, grid_h
        )

        page_info[page_idx] = dict(
            page_h_pt=page_h_pt, cell_w_pt=cell_w_pt, CELL_PX=CELL_PX,
            x_rank=x_rank, y_rank=y_rank,
            col_start=col_start, row_start=row_start,
            col_reliable=col_reliable, row_reliable=row_reliable,
        )

        app.logger.debug(
            "PDF page %d: %d cells, %d cols (x %.0f–%.0f), %d rows, "
            "col_start=%d row_start=%d",
            page_idx, len(named_imgs), len(x_vals), x_vals[0], x_vals[-1],
            len(top_vals), col_start, row_start,
        )

        for img in imgs:
            name = img.get('name', '')
            if name:
                img_by_name.setdefault(name, []).append((page_idx, img))

    # ── Phase 1.5: determine page layout from physical stitch-cell coordinates ──
    # The PDF lays pages out in row-major order and all pages share the same
    # PDF-coordinate grid origin (grid_left_x, grid_top_y).  We can therefore
    # compute every stitch's absolute grid position purely from its physical
    # x/y coordinate — no ruler-label parsing required.
    #
    # CRITICAL: y_rank alone cannot give the correct row offset.  When a page's
    # top rows are all background (no stitches), y_rank[0] maps to a y position
    # several rows below the grid top, so "row_start + y_rank_index" places every
    # cell in that column too high, producing blank bands in the output.  The fix
    # is to compute the row offset as round((y - grid_top_y) / cell_size), which
    # gives the correct absolute row regardless of how sparse the top rows are.
    # The same position-based formula is used in Phase 3 for both col and row.

    sorted_page_list = [p for p in grid_pages if p in page_info]

    if sorted_page_list:
        # Shared grid origin: the minimum x and y coordinate seen across any
        # named stitch cell on any grid page (= the top-left margin of the grid).
        grid_left_x = min(min(pi['x_rank'].keys()) for pi in page_info.values())
        grid_top_y  = min(min(pi['y_rank'].keys()) for pi in page_info.values())

        # Physical column and row spans per page, derived from the coordinate
        # range — NOT from len(x_rank)/len(y_rank), which only counts occupied
        # positions and would under-count pages whose top/side rows are empty.
        for page_idx in sorted_page_list:
            pi  = page_info[page_idx]
            cw  = pi['cell_w_pt']
            pi['n_cols']      = round((max(pi['x_rank'].keys()) - grid_left_x) / cw) + 1
            pi['n_rows']      = round((max(pi['y_rank'].keys()) - grid_top_y)  / cw) + 1
            pi['grid_left_x'] = grid_left_x   # stored so Phase 3 can use them
            pi['grid_top_y']  = grid_top_y

        # Detect pages_per_row: accumulate physical column spans until ≥ grid_w.
        cumulative_w = 0
        pages_per_row = len(sorted_page_list)
        for i, page_idx in enumerate(sorted_page_list):
            cumulative_w += page_info[page_idx]['n_cols']
            if cumulative_w >= grid_w:
                pages_per_row = i + 1
                break

        app.logger.info(
            "PDF import: grid %d×%d, %d grid pages → pages_per_row=%d "
            "(col-span sum=%d, origin x=%.1f y=%.1f)",
            grid_w, grid_h, len(sorted_page_list), pages_per_row,
            cumulative_w, grid_left_x, grid_top_y,
        )

        # Build 1-based col_start for each column position (first-row pages).
        col_starts = []
        acc = 0
        for k in range(min(pages_per_row, len(sorted_page_list))):
            col_starts.append(acc + 1)
            acc += page_info[sorted_page_list[k]]['n_cols']

        # Build 1-based row_start for each row using the leftmost page of that row.
        # n_rows gives the full physical height of the row tier, not just the
        # number of rows that happen to have stitches in the leftmost column.
        total_rows = (len(sorted_page_list) + pages_per_row - 1) // pages_per_row
        row_starts = []
        acc = 0
        for r in range(total_rows):
            row_starts.append(acc + 1)
            first_in_row = sorted_page_list[r * pages_per_row]
            acc += page_info[first_in_row]['n_rows']

        # Assign col_start / row_start to every page.
        for i, page_idx in enumerate(sorted_page_list):
            pi    = page_info[page_idx]
            col_p = i % pages_per_row
            row_n = i // pages_per_row
            pi['col_start'] = col_starts[col_p]
            pi['row_start'] = row_starts[row_n]
            app.logger.info(
                "  page %d → row %d col %d: col_start=%d row_start=%d "
                "(%d physical cols, %d physical rows)",
                page_idx, row_n, col_p,
                pi['col_start'], pi['row_start'],
                pi['n_cols'], pi['n_rows'],
            )

    # ── Phase 2: map each image name to a DMC number ──────────────────────────
    # Primary: match by stitch count (legend_count from the PDF legend page).
    # The counts are exact integers and are often unique per color.
    # Fallback for ties: render one representative cell and compare its sampled
    # RGB against the DB hex values of the tied candidates only.
    legend_by_count = {}
    for e in legend_entries:
        legend_by_count.setdefault(e['legend_count'], []).append(e)

    name_to_dmc  = {}
    # Tie groups: count → [names] when multiple images share the same cell count
    tie_groups   = {}   # count → [name, ...]

    for name, cells in img_by_name.items():
        cnt        = len(cells)
        candidates = legend_by_count.get(cnt, [])
        if len(candidates) == 1:
            name_to_dmc[name] = candidates[0]['dmc']
        else:
            tie_groups.setdefault(cnt, []).append(name)

    if tie_groups:
        rendered = {}   # page_idx → numpy array (rendered once per page)

        def _sample_name(name):
            """Sample the background colour of one representative cell."""
            page_idx, rep_img = img_by_name[name][0]
            if page_idx not in rendered:
                rendered[page_idx] = np.array(
                    pdfium_doc[page_idx].render(scale=SCALE).to_pil())
            arr     = rendered[page_idx]
            pi      = page_info[page_idx]
            top_pt  = pi['page_h_pt'] - rep_img['y1']
            px      = round(rep_img['x0'] * SCALE)
            py      = round(top_pt        * SCALE)
            CELL_PX = pi['CELL_PX']
            border  = []
            for dy in [2, 3, CELL_PX - 4, CELL_PX - 3]:
                for dx in [2, 3, CELL_PX - 4, CELL_PX - 3]:
                    r, c2 = py + dy, px + dx
                    if 0 <= r < arr.shape[0] and 0 <= c2 < arr.shape[1]:
                        border.append(arr[r, c2, :3])
            if not border:
                return None
            return tuple(int(x) for x in np.array(border, dtype=float).mean(axis=0))

        for cnt, names in tie_groups.items():
            candidates = legend_by_count.get(cnt, legend_entries)

            # Build all (distance, name, dmc) pairs
            pairs = []
            for name in names:
                sampled = _sample_name(name)
                if sampled is None:
                    continue
                for e in candidates:
                    ref  = dmc_rgb.get(e['dmc'], (128, 128, 128))
                    dist = math.sqrt(sum((a - b) ** 2 for a, b in zip(sampled, ref)))
                    pairs.append((dist, name, e['dmc']))

            # Greedy 1-to-1 assignment: nearest pair first, no re-use
            pairs.sort()
            used_names = set()
            used_dmcs  = set()
            for dist, name, dmc in pairs:
                if name not in used_names and dmc not in used_dmcs:
                    name_to_dmc[name] = dmc
                    used_names.add(name)
                    used_dmcs.add(dmc)

    # ── Phase 3: populate result grid using image-name → DMC lookup ───────────
    # No per-cell pixel matching — just a dict lookup, exact and fast.
    for page_idx in grid_pages:
        if page_idx not in page_info:
            continue
        pi      = page_info[page_idx]
        pl_page = plumber_pdf.pages[page_idx]

        for img in pl_page.images:
            name = img.get('name', '')
            dmc  = name_to_dmc.get(name)
            if not dmc:
                continue

            x_key = round(img['x0'],                   1)
            y_key = round(pi['page_h_pt'] - img['y1'], 1)
            if x_key not in pi['x_rank'] or y_key not in pi['y_rank']:
                continue

            col = pi['col_start'] + round((x_key - pi['grid_left_x']) / pi['cell_w_pt'])
            row = pi['row_start'] + round((y_key - pi['grid_top_y'])  / pi['cell_w_pt'])

            wc = col - 1 + BUFFER   # 0-based index in working grid
            wr = row - 1 + BUFFER
            if 0 <= wc < work_w and 0 <= wr < work_h:
                result[wr * work_w + wc] = dmc

    # Crop working buffer to actual content bounds, anchored at the first
    # occupied row/column.  Uses the smaller of declared vs actual dimensions
    # to handle PDFs with oversized cover-page metadata (e.g. Hawaii Hello Kitty).
    occupied = [
        (r, c)
        for r in range(work_h)
        for c in range(work_w)
        if result[r * work_w + c] != 'BG'
    ]
    if occupied:
        min_r = min(r for r, c in occupied)
        min_c = min(c for r, c in occupied)
        max_r = max(r for r, c in occupied)
        max_c = max(c for r, c in occupied)
        actual_h = max_r - min_r + 1
        actual_w = max_c - min_c + 1
        crop_h = min(grid_h, actual_h)
        crop_w = min(grid_w, actual_w)
    else:
        min_r, min_c = BUFFER, BUFFER
        crop_h, crop_w = grid_h, grid_w

    result = [
        result[(min_r + r) * work_w + (min_c + c)]
        for r in range(crop_h)
        for c in range(crop_w)
    ]
    grid_w = crop_w
    grid_h = crop_h

    # Build legend data (only colors that appear in grid), sorted by stitch count
    legend_data = []
    for e in legend_entries:
        stitches = result.count(e['dmc'])
        if stitches == 0:
            continue
        db_row = _thread_info.get(e['dmc'])
        legend_data.append({
            'dmc':      e['dmc'],
            'name':     e['name'],
            'hex':      '#' + dmc_hex.get(e['dmc'], 'cccccc'),
            'stitches': stitches,
            'status':   db_row['status']   if db_row else 'dont_own',
            'category': db_row['category'] if db_row else '',
        })
    legend_data.sort(key=lambda x: -x['stitches'])

    # Assign symbols (same order as _generate_cross_stitch_pattern)
    for i, entry in enumerate(legend_data):
        entry['symbol'] = _PATTERN_SYMBOLS[i % len(_PATTERN_SYMBOLS)]

    return {
        'title':   title,
        'grid_w':  grid_w,
        'grid_h':  grid_h,
        'grid':    result,
        'legend':  legend_data,
    }


def _cleanup_orphaned_images():
    """Delete image files in uploads/ not referenced by any saved pattern and older than 7 days."""
    if not os.path.isdir(UPLOADS_DIR):
        return
    conn = _get_db_direct()
    cursor = conn.cursor()
    cursor.execute("SELECT source_image_path FROM saved_patterns WHERE source_image_path IS NOT NULL")
    referenced = {row['source_image_path'] for row in cursor.fetchall()}
    conn.close()
    cutoff = time.time() - 7 * 86400
    for fname in os.listdir(UPLOADS_DIR):
        if fname.startswith('.'):
            continue
        fpath = os.path.join(UPLOADS_DIR, fname)
        if fpath not in referenced and os.path.getmtime(fpath) < cutoff:
            try:
                os.remove(fpath)
            except FileNotFoundError:
                pass


def hex_to_lab(hex_color):
    """Convert hex color to LAB color space for CIEDE2000 calculation."""
    if not hex_color or len(hex_color) != 7:
        return None
    try:
        hex_clean = hex_color.lstrip('#')
        r = int(hex_clean[0:2], 16) / 255.0
        g = int(hex_clean[2:4], 16) / 255.0
        b = int(hex_clean[4:6], 16) / 255.0
        rgb = sRGBColor(r, g, b)
        return convert_color(rgb, LabColor)
    except (ValueError, IndexError):
        return None


def calculate_ciede2000(lab1, lab2):
    """Calculate CIEDE2000 color difference between two LAB colors."""
    if lab1 is None or lab2 is None:
        return float('inf')
    return delta_e_cie2000(lab1, lab2)


def _build_palette_lab():
    """Build the global thread palette in LAB space once at startup."""
    global _PALETTE_LAB
    conn = _get_db_direct()
    cursor = conn.cursor()
    cursor.execute("SELECT id, number, name, hex_color, category, brand FROM threads WHERE hex_color IS NOT NULL AND hex_color != ''")
    rows = cursor.fetchall()
    conn.close()
    for row in rows:
        lab = hex_to_lab(row['hex_color'])
        if lab is not None:
            _PALETTE_LAB[row['id']] = {
                'lab': lab,
                'hex': row['hex_color'],
                'name': row['name'],
                'category': row['category'],
                'brand': row['brand'],
                'number': row['number'],
            }


def _match_rgb_to_dmc(r, g, b):
    """Find the nearest DMC thread for an (r, g, b) tuple using CIEDE2000.
    Only matches against DMC threads (used by image-to-pattern)."""
    rgb = sRGBColor(r / 255.0, g / 255.0, b / 255.0)
    target_lab = convert_color(rgb, LabColor)
    best_id = None
    best_delta = float('inf')
    for tid, entry in _PALETTE_LAB.items():
        if entry['brand'] != 'DMC':
            continue
        d = delta_e_cie2000(target_lab, entry['lab'])
        if d < best_delta:
            best_delta = d
            best_id = tid
    if best_id is not None:
        info = _PALETTE_LAB[best_id]
        return info['number'], info
    return None, None


_PATTERN_SYMBOLS = "+×#@*!=?%&~^$●■▲◆★§¶†‡±÷◎⊕⊗≠√∞⊞⬡¤※"
_SYMBOLS_VERSION = "3"  # increment when _PATTERN_SYMBOLS changes

# --- User preferences ---
_DEFAULT_PREFS = {
    'dmc-theme':            'system',
    'dmc-gridlines':        True,
    'dmc-symbols':          True,
    'dmc-legend-sort':      'number',
    'dmc-viewMode':         'chart',
    'dmc-ed-mirror':        'off',
    'dmc-ed-brush':         1,
    'dmc-calc-strands':     2,
    'dmc-calc-skein-len':   8.7,
    'dmc-calc-efficiency':  'average',
    'dmc-calc-fabric-count': 14,
    'inventoryBrand':       'DMC',
    'gallery-density':      4,
}

_PREF_VALIDATORS = {
    'dmc-theme':            lambda v: v in ('light', 'dark', 'system'),
    'dmc-gridlines':        lambda v: isinstance(v, bool),
    'dmc-symbols':          lambda v: isinstance(v, bool),
    'dmc-legend-sort':      lambda v: v in ('number', 'stitches'),
    'dmc-viewMode':         lambda v: v in ('chart', 'thread'),
    'dmc-ed-mirror':        lambda v: v in ('off', 'horizontal', 'vertical', 'both'),
    'dmc-ed-brush':         lambda v: v in (1, 2, 3, 5, 9),
    'dmc-calc-strands':     lambda v: v in (1, 2, 3, 4),
    'dmc-calc-skein-len':   lambda v: isinstance(v, (int, float)) and 0.1 <= v <= 100,
    'dmc-calc-efficiency':  lambda v: v in ('inefficient', 'average', 'efficient'),
    'dmc-calc-fabric-count': lambda v: v in (6, 8, 11, 14, 16, 18, 20, 22, 25, 28, 32),
    'inventoryBrand':       lambda v: v in ('DMC', 'Anchor', ''),
    'gallery-density':      lambda v: isinstance(v, int) and 2 <= v <= 8,
}


def _get_user_prefs(user_id):
    """Fetch user preferences merged with defaults."""
    conn = get_db()
    row = conn.execute("SELECT preferences FROM users WHERE id = ?", (user_id,)).fetchone()
    stored = {}
    if row and row['preferences']:
        try:
            stored = json.loads(row['preferences'])
        except (json.JSONDecodeError, TypeError):
            pass
    return {**_DEFAULT_PREFS, **stored}


def _generate_cross_stitch_pattern(img_bytes, grid_w, grid_h, num_colors, dither, contrast, brightness, palette_filter='standard', pixel_art=False, crop=None, crop_shape='rect', palette_brand='DMC'):
    """Convert image bytes to a cross-stitch pattern dict."""
    img = Image.open(io.BytesIO(img_bytes)).convert('RGB')

    if crop:
        cw, ch = img.size
        left   = round(crop[0] * cw)
        top    = round(crop[1] * ch)
        right  = round(crop[2] * cw)
        bottom = round(crop[3] * ch)
        img = img.crop((left, top, right, bottom))

    shape_mask = None
    if crop_shape in ('circle', 'ellipse'):
        # Apply elliptical mask — corners become white; keep mask for BG tagging
        shape_mask = Image.new('L', img.size, 0)
        draw = ImageDraw.Draw(shape_mask)
        draw.ellipse((0, 0, img.size[0], img.size[1]), fill=255)
        white_bg = Image.new('RGB', img.size, (255, 255, 255))
        white_bg.paste(img, mask=shape_mask)
        img.close()
        img = white_bg

    if contrast != 1.0:
        old = img
        img = ImageEnhance.Contrast(img).enhance(contrast)
        if old is not img:
            old.close()
    if brightness != 1.0:
        old = img
        img = ImageEnhance.Brightness(img).enhance(brightness)
        if old is not img:
            old.close()

    resample = Image.NEAREST if pixel_art else Image.LANCZOS
    img = img.resize((grid_w, grid_h), resample)
    if shape_mask is not None:
        shape_mask = shape_mask.resize((grid_w, grid_h), Image.NEAREST)
        mask_array = np.array(shape_mask)  # 0 = outside, 255 = inside
        shape_mask.close()

    # Build filtered palette view
    if palette_filter == 'standard':
        active_palette = {k: v for k, v in _PALETTE_LAB.items() if v['brand'] == palette_brand and v['category'] == 'Standard'}
    elif palette_filter == 'special':
        active_palette = {k: v for k, v in _PALETTE_LAB.items() if v['brand'] == palette_brand and v['category'] != 'Standard'}
    else:
        active_palette = {k: v for k, v in _PALETTE_LAB.items() if v['brand'] == palette_brand}

    quantized = img.quantize(colors=num_colors, dither=Image.Dither.FLOYDSTEINBERG if dither else Image.Dither.NONE)
    palette_raw = quantized.getpalette()  # flat [r,g,b,r,g,b,...]
    actual_colors = len(palette_raw) // 3  # may be fewer than num_colors

    # Map each palette index to its nearest thread in active_palette
    palette_map = {}  # palette_index -> thread_number
    for i in range(actual_colors):
        pr = palette_raw[i * 3]
        pg = palette_raw[i * 3 + 1]
        pb = palette_raw[i * 3 + 2]
        rgb = sRGBColor(pr / 255.0, pg / 255.0, pb / 255.0)
        target_lab = convert_color(rgb, LabColor)
        best_number = None
        best_delta = float('inf')
        for tid, entry in active_palette.items():
            d = delta_e_cie2000(target_lab, entry['lab'])
            if d < best_delta:
                best_delta = d
                best_number = entry['number']
        if best_number is not None:
            palette_map[i] = best_number

    # Build grid as flat list of thread numbers
    pixel_array = np.array(quantized)  # shape (grid_h, grid_w), values are palette indices
    quantized.close()
    grid = []
    for r, row in enumerate(pixel_array):
        for c, idx in enumerate(row):
            if shape_mask is not None and mask_array[r, c] == 0:
                grid.append('BG')
            else:
                grid.append(palette_map.get(int(idx), '?'))

    # Count stitches per thread (skip BG cells)
    stitch_counts = {}
    for num in grid:
        if num == 'BG':
            continue
        stitch_counts[num] = stitch_counts.get(num, 0) + 1

    # Assign symbols to unique threads (sorted by stitch count descending)
    sorted_threads = sorted(stitch_counts.keys(), key=lambda n: -stitch_counts[n])
    symbol_map = {}
    for i, num in enumerate(sorted_threads):
        symbol_map[num] = _PATTERN_SYMBOLS[i % len(_PATTERN_SYMBOLS)]

    # Cross-reference inventory (with per-user status)
    conn = get_db()
    uid = current_user.id
    thread_lookup = _lookup_threads_by_number(conn, uid, palette_brand, sorted_threads)
    legend = []
    for num in sorted_threads:
        row = thread_lookup.get(num)
        legend.append({
            'dmc': num,
            'name': row['name'] if row else '',
            'hex': row['hex_color'] if row else '#888888',
            'symbol': symbol_map[num],
            'stitches': stitch_counts[num],
            'status': row['status'] if row else 'not_found',
            'category': row['category'] if row else 'Standard',
        })

    img.close()

    return {
        'grid': grid,
        'grid_w': grid_w,
        'grid_h': grid_h,
        'legend': legend,
    }


@app.route('/login', methods=['GET', 'POST'])
@limiter.limit("5 per minute", methods=["POST"])
def login():
    """Handle user login."""
    if current_user.is_authenticated:
        return redirect(url_for('home'))

    error = None

    if request.method == 'POST':
        wants_json = request.is_json or request.headers.get('X-Requested-With') == 'fetch'

        if wants_json:
            data = request.get_json(force=True, silent=True) or {}
            username = data.get('username', '').strip()
            password = data.get('password', '')
            remember = bool(data.get('remember', False))
        else:
            username = request.form.get('username', '').strip()
            password = request.form.get('password', '')
            remember = bool(request.form.get('remember', False))

        if not username or not password:
            error = 'Username and password are required.'
            if wants_json:
                return jsonify({'error': error}), 400
        else:
            user_data = User.get_by_username(username)

            # Constant-time: always run Argon2 verification to prevent timing leaks
            if user_data:
                is_valid, rehash = User.verify_password(user_data['password_hash'], password)
            else:
                try:
                    ph.verify(_dummy_hash, password)
                except Exception:
                    pass
                is_valid, rehash = False, None

            if is_valid and user_data:
                if not user_data['is_active']:
                    error = 'This account has been disabled.'
                    if wants_json:
                        return jsonify({'error': error}), 403
                else:
                    # Upgrade hash if Argon2 parameters have changed
                    if rehash:
                        conn = get_db()
                        conn.execute("UPDATE users SET password_hash = ? WHERE id = ?",
                                     (rehash, user_data['id']))
                        conn.commit()
                    user = User(user_data['id'], user_data['username'], user_data['email'])
                    session.clear()
                    login_user(user, remember=remember)
                    session.permanent = True
                    User.update_last_login(user.id)

                    next_page = request.args.get('next')
                    parsed = urlparse(next_page) if next_page else None
                    redirect_url = next_page if (parsed and not parsed.netloc and not parsed.scheme and next_page.startswith('/')) else url_for('home')

                    if wants_json:
                        return jsonify({'redirect': redirect_url})
                    return redirect(redirect_url)
            else:
                error = 'Invalid username or password.'
                if wants_json:
                    return jsonify({'error': error}), 401

    return render_template('login.html', error=error)


@app.route('/logout', methods=['POST'])
@login_required
def logout():
    """Handle user logout."""
    if DESKTOP_MODE:
        return redirect(url_for('home'))
    # Clean up session-uploaded image if it wasn't saved to a pattern
    img_path = session.get('upload_image_path')
    if img_path and os.path.isfile(img_path):
        conn = get_db()
        ref_count = conn.execute(
            "SELECT COUNT(*) FROM saved_patterns WHERE source_image_path = ?",
            (img_path,)).fetchone()[0]
        if ref_count == 0:
            try:
                os.remove(img_path)
            except OSError:
                pass
    logout_user()
    return redirect(url_for('login'))


@app.route('/inventory')
@login_required
def inventory():
    """Thread inventory page."""
    return render_template('index.html')


@app.route('/')
@login_required
def home():
    """Dashboard homepage."""
    return render_template('home.html')


@app.route('/calculator')
@login_required
def calculator():
    """Redirect old calculator URL to Project Materials Calculator page."""
    return redirect('/pattern-calculator?mode=fabric')


@app.route('/skein-calculator')
@login_required
def skein_calculator():
    """Redirect old skein-calculator URL to Project Materials Calculator page."""
    return redirect('/pattern-calculator?mode=stitch')


@app.route('/api/threads')
@login_required
@limiter.limit("60 per minute")
def get_threads():
    """Get all threads with optional filtering."""
    conn = get_db()
    cursor = conn.cursor()
    uid = current_user.id

    # Get query parameters
    search = request.args.get('search', '').strip()
    category = request.args.get('category', '')
    status = request.args.get('status', '')  # 'own', 'need', 'dont_own'
    brand = request.args.get('brand', '')    # 'DMC', 'Anchor', or '' for all

    # Build query — LEFT JOIN per-user status
    query = """SELECT t.id, t.number, t.name, t.category, t.hex_color, t.brand,
                      COALESCE(u.status, 'dont_own') AS status,
                      COALESCE(u.notes, '') AS notes,
                      COALESCE(u.skein_qty, 0) AS skein_qty
               FROM threads t
               LEFT JOIN user_thread_status u ON u.thread_id = t.id AND u.user_id = ?
               WHERE 1=1"""
    params = [uid]

    if brand:
        query += " AND t.brand = ?"
        params.append(brand)

    if search:
        query += " AND (t.number LIKE ? OR t.name LIKE ?)"
        search_term = f"%{search}%"
        params.extend([search_term, search_term])

    if category:
        query += " AND t.category = ?"
        params.append(category)

    if status in ['own', 'need', 'dont_own']:
        query += " AND COALESCE(u.status, 'dont_own') = ?"
        params.append(status)

    # Sort: brand first, then brand-specific ordering
    # DMC: B5200/White/Ecru/Blanc first, then numeric, then alpha
    # Anchor: purely numeric
    query += """ ORDER BY t.brand,
        CASE
            WHEN t.brand = 'DMC' AND t.number = 'B5200' THEN 0
            WHEN t.brand = 'DMC' AND t.number = 'White' THEN 1
            WHEN t.brand = 'DMC' AND t.number = 'Ecru' THEN 2
            WHEN t.brand = 'DMC' AND t.number = 'Blanc' THEN 3
            WHEN t.number GLOB '[0-9]*' THEN 4
            ELSE 5
        END,
        CASE
            WHEN t.number GLOB '[0-9]*' THEN CAST(t.number AS INTEGER)
            ELSE t.number
        END"""

    cursor.execute(query, params)
    threads = [dict(row) for row in cursor.fetchall()]

    return jsonify(threads)


@app.route('/api/threads/<int:thread_id>', methods=['PATCH'])
@limiter.limit("60 per minute")
@login_required
def update_thread(thread_id):
    """Update a thread's user-specific status, notes, or skein_qty."""
    data = request.get_json(silent=True)
    if not data:
        return jsonify({'error': 'Request body must be JSON'}), 400

    conn = get_db()
    cursor = conn.cursor()
    uid = current_user.id

    # Verify thread exists
    cursor.execute("SELECT id FROM threads WHERE id = ?", (thread_id,))
    if not cursor.fetchone():
        return jsonify({'error': 'Thread not found'}), 404

    # Validate incoming fields
    new_status = None
    new_notes = None
    new_qty = None

    if 'status' in data:
        valid_statuses = ('own', 'need', 'dont_own')
        if data['status'] not in valid_statuses:
            return jsonify({'error': f'Invalid status. Must be one of: {", ".join(valid_statuses)}'}), 400
        new_status = data['status']

    if 'notes' in data:
        new_notes = str(data['notes'] or '')[:500]

    if 'skein_qty' in data:
        try:
            qty = round(float(data['skein_qty']), 2)
        except (ValueError, TypeError):
            return jsonify({'error': 'skein_qty must be a number'}), 400
        if qty < 0 or not math.isfinite(qty):
            return jsonify({'error': 'skein_qty must be a non-negative number'}), 400
        new_qty = qty

    if new_status is not None or new_notes is not None or new_qty is not None:
        # UPSERT into user_thread_status
        cursor.execute(
            "SELECT status, notes, skein_qty FROM user_thread_status WHERE user_id = ? AND thread_id = ?",
            (uid, thread_id)
        )
        existing = cursor.fetchone()
        if existing:
            updates = []
            params = []
            if new_status is not None:
                updates.append("status = ?")
                params.append(new_status)
            if new_notes is not None:
                updates.append("notes = ?")
                params.append(new_notes)
            if new_qty is not None:
                updates.append("skein_qty = ?")
                params.append(new_qty)
            updates.append("updated_at = CURRENT_TIMESTAMP")
            params.extend([uid, thread_id])
            cursor.execute(
                f"UPDATE user_thread_status SET {', '.join(updates)} WHERE user_id = ? AND thread_id = ?",
                params
            )
        else:
            cursor.execute(
                "INSERT INTO user_thread_status (user_id, thread_id, status, notes, skein_qty, updated_at) "
                "VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)",
                (uid, thread_id,
                 new_status if new_status is not None else 'dont_own',
                 new_notes if new_notes is not None else '',
                 new_qty if new_qty is not None else 0)
            )
        conn.commit()

    # Return thread with user-specific status
    cursor.execute(
        """SELECT t.id, t.number, t.name, t.category, t.hex_color, t.brand,
                  COALESCE(u.status, 'dont_own') AS status,
                  COALESCE(u.notes, '') AS notes,
                  COALESCE(u.skein_qty, 0) AS skein_qty
           FROM threads t
           LEFT JOIN user_thread_status u ON u.thread_id = t.id AND u.user_id = ?
           WHERE t.id = ?""",
        (uid, thread_id)
    )
    thread = dict(cursor.fetchone())

    return jsonify(thread)


@app.route('/api/categories')
@limiter.limit("30 per minute")
@login_required
def get_categories():
    """Get all unique categories."""
    conn = get_db()
    cursor = conn.cursor()
    brand = request.args.get('brand', '')
    if brand:
        cursor.execute("SELECT DISTINCT category FROM threads WHERE brand = ? ORDER BY category", (brand,))
    else:
        cursor.execute("SELECT DISTINCT category FROM threads ORDER BY category")
    categories = [row[0] for row in cursor.fetchall()]
    return jsonify(categories)


@app.route('/api/stats')
@limiter.limit("30 per minute")
@login_required
def get_stats():
    """Get inventory statistics (per-user)."""
    conn = get_db()
    uid = current_user.id
    brand = request.args.get('brand', '')
    if brand:
        row = conn.execute("""
            SELECT COUNT(*) AS total,
                   SUM(CASE WHEN COALESCE(u.status, 'dont_own') = 'own' THEN 1 ELSE 0 END) AS owned,
                   SUM(CASE WHEN COALESCE(u.status, 'dont_own') = 'need' THEN 1 ELSE 0 END) AS need,
                   SUM(CASE WHEN COALESCE(u.status, 'dont_own') = 'dont_own' THEN 1 ELSE 0 END) AS dont_own
            FROM threads t
            LEFT JOIN user_thread_status u ON u.thread_id = t.id AND u.user_id = ?
            WHERE t.brand = ?
        """, (uid, brand)).fetchone()
    else:
        row = conn.execute("""
            SELECT COUNT(*) AS total,
                   SUM(CASE WHEN COALESCE(u.status, 'dont_own') = 'own' THEN 1 ELSE 0 END) AS owned,
                   SUM(CASE WHEN COALESCE(u.status, 'dont_own') = 'need' THEN 1 ELSE 0 END) AS need,
                   SUM(CASE WHEN COALESCE(u.status, 'dont_own') = 'dont_own' THEN 1 ELSE 0 END) AS dont_own
            FROM threads t
            LEFT JOIN user_thread_status u ON u.thread_id = t.id AND u.user_id = ?
        """, (uid,)).fetchone()

    return jsonify({
        'total': row[0],
        'owned': row[1],
        'need': row[2],
        'dont_own': row[3]
    })


@app.route('/api/threads/<int:thread_id>/similar')
@limiter.limit("30 per minute")
@login_required
def get_similar_threads(thread_id):
    """Find threads with similar colors using CIEDE2000."""
    limit = request.args.get('limit', 6, type=int)
    limit = min(max(limit, 1), 50)  # Clamp between 1 and 50
    category_filter = request.args.get('category', 'all')  # 'all', 'standard', 'specialty'

    conn = get_db()
    cursor = conn.cursor()

    # Get the reference thread (including brand for scoping)
    cursor.execute("SELECT id, number, hex_color, brand FROM threads WHERE id = ?", (thread_id,))
    reference = cursor.fetchone()

    if not reference:
        return jsonify({'error': 'Thread not found'}), 404

    reference_lab = hex_to_lab(reference['hex_color'])
    if reference_lab is None:
        return jsonify({'error': 'Reference thread has no valid color'}), 400

    ref_id = reference['id']
    ref_brand = reference['brand']

    # Compute delta-E using pre-built LAB cache — scoped to same brand
    scored = []
    for tid, info in _PALETTE_LAB.items():
        if tid == ref_id:
            continue
        if info['brand'] != ref_brand:
            continue
        if category_filter == 'standard' and info['category'] != 'Standard':
            continue
        if category_filter == 'specialty' and info['category'] == 'Standard':
            continue
        delta_e = calculate_ciede2000(reference_lab, info['lab'])
        scored.append((tid, delta_e))

    scored.sort(key=lambda x: x[1])
    top = scored[:limit]

    # Fetch live DB data only for the top-N results (with per-user status)
    uid = current_user.id
    if top:
        top_ids = [t[0] for t in top]
        ph = ','.join('?' * len(top_ids))
        cursor.execute(
            f"""SELECT t.id, t.number, t.name, t.category, t.hex_color, t.brand,
                       COALESCE(u.status, 'dont_own') AS status,
                       COALESCE(u.notes, '') AS notes,
                       COALESCE(u.skein_qty, 0) AS skein_qty
                FROM threads t
                LEFT JOIN user_thread_status u ON u.thread_id = t.id AND u.user_id = ?
                WHERE t.id IN ({ph})""",
            [uid] + top_ids
        )
        db_lookup = {r['id']: dict(r) for r in cursor.fetchall()}
    else:
        db_lookup = {}

    results = []
    for tid, de in top:
        thread_dict = db_lookup.get(tid, {
            'number': _PALETTE_LAB[tid]['number'],
            'hex_color': _PALETTE_LAB[tid]['hex'],
            'name': _PALETTE_LAB[tid]['name'],
        })
        thread_dict['delta_e'] = round(de, 2)
        results.append(thread_dict)

    return jsonify(results)


@app.route('/pattern-calculator')
@login_required
def pattern_calculator():
    """Project Materials Calculator — thread needs, skein estimates, and fabric sizing."""
    return render_template('pattern-calculator.html')


@app.route('/stash-calculator')
@login_required
def stash_calculator():
    """Redirect old stash-calculator URL to Project Materials Calculator page."""
    pattern = request.args.get('pattern', '')
    url = '/pattern-calculator' + ('?pattern=' + pattern if pattern else '')
    return redirect(url)


@app.route('/settings')
@login_required
def settings_page():
    """User settings and preferences."""
    return render_template('settings.html',
                           pattern_symbols=_PATTERN_SYMBOLS)


@app.route('/api/preferences', methods=['GET'])
@login_required
def api_get_preferences():
    """Return current user preferences."""
    return jsonify(_get_user_prefs(current_user.id))


@app.route('/api/preferences', methods=['PATCH'])
@login_required
@limiter.limit("30 per minute")
def api_update_preferences():
    """Update one or more user preferences."""
    data = request.get_json(force=True)
    if not data:
        return jsonify({'error': 'No data provided'}), 400

    prefs = _get_user_prefs(current_user.id)
    errors = []
    for key, value in data.items():
        validator = _PREF_VALIDATORS.get(key)
        if not validator:
            continue  # silently skip unknown keys
        if not validator(value):
            errors.append(f'Invalid value for {key}')
            continue
        prefs[key] = value

    if errors:
        return jsonify({'error': '; '.join(errors)}), 400

    # Write only non-default values to keep stored JSON small
    stored = {k: v for k, v in prefs.items() if k in _DEFAULT_PREFS and v != _DEFAULT_PREFS[k]}
    conn = get_db()
    conn.execute("UPDATE users SET preferences = ? WHERE id = ?",
                 (json.dumps(stored), current_user.id))
    conn.commit()
    return jsonify(prefs)


@app.route('/api/preferences/reset', methods=['POST'])
@login_required
@limiter.limit("5 per minute")
def api_reset_preferences():
    """Reset all preferences to defaults."""
    conn = get_db()
    conn.execute("UPDATE users SET preferences = '{}' WHERE id = ?",
                 (current_user.id,))
    conn.commit()
    return jsonify(_DEFAULT_PREFS)


@app.route('/api/account/password', methods=['POST'])
@login_required
@limiter.limit("5 per minute")
def api_change_password():
    """Change the current user's password."""
    data = request.get_json(force=True)
    current_pw = data.get('current_password', '')
    new_pw = data.get('new_password', '')

    if not current_pw or not new_pw:
        return jsonify({'error': 'Both current and new password are required'}), 400
    if len(new_pw) < 8:
        return jsonify({'error': 'New password must be at least 8 characters'}), 400
    if len(new_pw) > 1024:
        return jsonify({'error': 'Password too long'}), 400

    conn = get_db()
    row = conn.execute("SELECT password_hash FROM users WHERE id = ?",
                       (current_user.id,)).fetchone()
    valid, _ = User.verify_password(row['password_hash'], current_pw) if row else (False, None)
    if not valid:
        return jsonify({'error': 'Current password is incorrect'}), 403

    new_hash = ph.hash(new_pw)
    conn.execute("UPDATE users SET password_hash = ? WHERE id = ?",
                 (new_hash, current_user.id))
    conn.commit()
    return jsonify({'ok': True})


def _parse_floss_table(tables, text):
    """
    Given a list of pdfplumber tables and raw page text, find and parse the floss/color table.
    Returns a list of dicts with keys: dmc, full_stitches, half_stitches, quarter_stitches, backstitch.
    """
    DMC_PATTERN = re.compile(r'^(B5200|Blanc|White|Ecru|Black|\d{1,4})$', re.IGNORECASE)

    def find_col(headers, *keywords):
        for i, h in enumerate(headers):
            if h and any(kw.lower() in h.lower() for kw in keywords):
                return i
        return None

    def safe_int(val):
        if val is None:
            return 0
        try:
            return int(str(val).strip().replace(',', ''))
        except (ValueError, TypeError):
            return 0

    for table in tables:
        if not table or len(table) < 2:
            continue

        # Use first row as headers
        headers = [str(c).strip() if c else '' for c in table[0]]

        dmc_col   = find_col(headers, 'DMC', 'Color', 'Number', 'No', 'Thread', 'Floss')
        name_col  = find_col(headers, 'Name', 'Description', 'Colour', 'Color Name')
        full_col  = find_col(headers, 'Stitches', 'Cross', 'Full', 'Count', 'Total')
        half_col  = find_col(headers, 'Half')
        qtr_col   = find_col(headers, 'Quarter', 'Qtr')
        bs_col    = find_col(headers, 'Backstitch', 'Back', 'BS')

        if dmc_col is None:
            # Try to auto-detect: find a column where most values match DMC pattern
            for ci in range(len(headers)):
                matches = sum(
                    1 for row in table[1:]
                    if row and ci < len(row) and row[ci] and DMC_PATTERN.match(str(row[ci]).strip())
                )
                if matches >= max(1, (len(table) - 1) // 2):
                    dmc_col = ci
                    break

        if dmc_col is None:
            continue

        # Validate: at least one data row has a DMC-like value
        valid_rows = [
            row for row in table[1:]
            if row and dmc_col < len(row) and row[dmc_col] and DMC_PATTERN.match(str(row[dmc_col]).strip())
        ]
        if not valid_rows:
            continue

        # If we found no stitch count column yet, try any numeric-looking column
        if full_col is None:
            for ci in range(len(headers)):
                if ci == dmc_col:
                    continue
                nums = sum(
                    1 for row in valid_rows
                    if ci < len(row) and row[ci] and str(row[ci]).strip().replace(',', '').isdigit()
                )
                if nums >= max(1, len(valid_rows) // 2):
                    full_col = ci
                    break

        colors = []
        for row in valid_rows:
            dmc = str(row[dmc_col]).strip()
            name = str(row[name_col]).strip() if name_col is not None and name_col < len(row) and row[name_col] else ''
            full   = safe_int(row[full_col])  if full_col  is not None and full_col  < len(row) else 0
            half   = safe_int(row[half_col])  if half_col  is not None and half_col  < len(row) else 0
            qtr    = safe_int(row[qtr_col])   if qtr_col   is not None and qtr_col   < len(row) else 0
            bs     = safe_int(row[bs_col])    if bs_col    is not None and bs_col    < len(row) else 0
            colors.append({
                'dmc': dmc,
                'name': name,
                'full_stitches': full,
                'half_stitches': half,
                'quarter_stitches': qtr,
                'backstitch': bs,
            })

        if colors:
            return colors

    return []


def _parse_floss_last_page(text):
    """
    Parse the last-page floss list produced by pattern software like PC Stitch.
    Handles lines of the form:  2 DMC 924 Gray Green - Very Dark 1820
    where the leading number is strand count and the trailing number is stitch count.
    """
    # Match: <strands> DMC <number> <name> <stitches>
    LINE_RE = re.compile(
        r'^\d+\s+DMC\s+(\S+)\s+(.+?)\s+(\d+)\s*$',
        re.IGNORECASE,
    )
    colors = []
    seen = set()
    for line in text.splitlines():
        m = LINE_RE.match(line.strip())
        if not m:
            continue
        dmc, name, stitches = m.group(1), m.group(2).strip(), int(m.group(3))
        if dmc in seen:
            continue
        seen.add(dmc)
        colors.append({
            'dmc': dmc,
            'name': name,
            'full_stitches': stitches,
            'half_stitches': 0,
            'quarter_stitches': 0,
            'backstitch': 0,
        })
    return colors


def _parse_floss_text(text):
    """
    Fallback: parse raw text lines for DMC thread numbers and stitch counts.
    Looks for lines like: "924  Gray Green - Very Dark  1820"
    """
    DMC_PATTERN = re.compile(r'\b(B5200|Blanc|White|Ecru|Black|\d{1,4})\b')
    colors = []
    seen = set()
    for line in text.splitlines():
        line = line.strip()
        nums = re.findall(r'\b\d+\b', line)
        dmc_matches = DMC_PATTERN.findall(line)
        if not dmc_matches:
            continue
        dmc = dmc_matches[0]
        if dmc in seen:
            continue
        # Extract largest number as stitch count (heuristic)
        stitch_nums = [int(n) for n in nums if int(n) > 10 and n != dmc]
        full = max(stitch_nums) if stitch_nums else 0
        # Try to extract name: text between DMC number and the stitch count
        name_match = re.search(r'(?:' + re.escape(dmc) + r')\s+([A-Za-z][^0-9]{3,50}?)\s+\d', line)
        name = name_match.group(1).strip() if name_match else ''
        seen.add(dmc)
        colors.append({
            'dmc': dmc,
            'name': name,
            'full_stitches': full,
            'half_stitches': 0,
            'quarter_stitches': 0,
            'backstitch': 0,
        })
    return colors


@app.route('/api/pattern/parse', methods=['POST'])
@limiter.limit("10 per minute")
@login_required
def parse_pattern():
    """Parse an uploaded PDF and extract floss list + detected settings."""
    if 'pdf' not in request.files:
        return jsonify({'error': 'No PDF file uploaded'}), 400

    pdf_file = request.files['pdf']
    if not pdf_file.filename or not pdf_file.filename.lower().endswith('.pdf'):
        return jsonify({'error': 'File must be a PDF'}), 400

    pdf_bytes = pdf_file.read()
    if not pdf_bytes:
        return jsonify({'error': 'Uploaded file is empty'}), 400
    if len(pdf_bytes) > MAX_PDF_SIZE:
        return jsonify({'error': 'PDF too large (max 25 MB)'}), 400
    if pdf_bytes[:5] != b'%PDF-':
        return jsonify({'error': 'File does not appear to be a valid PDF'}), 400

    try:
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            all_text = ''
            all_tables = []
            last_page_text = ''
            design_info = {'width': None, 'height': None, 'total_stitches': None}

            for i, page in enumerate(pdf.pages):
                page_text = page.extract_text() or ''
                all_text += page_text + '\n'
                if i == len(pdf.pages) - 1:
                    last_page_text = page_text
                try:
                    tables = page.extract_tables()
                    if tables:
                        all_tables.extend(tables)
                except Exception:
                    pass

            # Detect fabric count
            fabric_count = None
            m = re.search(r'(\d+)\s*(?:count|ct\.?)\b', all_text, re.IGNORECASE)
            if not m:
                m = re.search(r'Aida\s*(\d+)', all_text, re.IGNORECASE)
            if m:
                val = int(m.group(1))
                if val in (11, 14, 16, 18, 20, 22, 25, 28, 32):
                    fabric_count = val

            # Detect strands
            strands = None
            m2 = re.search(r'(\d)\s*strands?', all_text, re.IGNORECASE)
            if not m2:
                m2 = re.search(r'using\s*(\d)\s*strand', all_text, re.IGNORECASE)
            if m2:
                val2 = int(m2.group(1))
                if 1 <= val2 <= 6:
                    strands = val2

            # Detect design dimensions
            dim_m = re.search(r'(\d{2,4})\s*[xX×]\s*(\d{2,4})\s*(?:stitches|st\.?)?', all_text)
            if dim_m:
                design_info['width'] = int(dim_m.group(1))
                design_info['height'] = int(dim_m.group(2))

            # Parse floss list — try last-page targeted regex first, then table, then full-text fallback
            colors = _parse_floss_last_page(last_page_text)
            if not colors:
                colors = _parse_floss_table(all_tables, all_text)
            if not colors:
                colors = _parse_floss_text(all_text)

            if not colors:
                return jsonify({'error': 'Could not find a floss list in this PDF. '
                                         'The PDF may use an unsupported format.'}), 400

            # Cross-reference inventory (per-user status)
            conn = get_db()
            uid = current_user.id
            dmc_nums = [c['dmc'] for c in colors]
            _tlookup = _lookup_threads_by_number(conn, uid, 'DMC', dmc_nums,
                                                  extra_fields=('id', 'skein_qty'))
            for color in colors:
                row = _tlookup.get(color['dmc'])
                if row:
                    color['inventory_status'] = row['status']
                    color['hex_color'] = row['hex_color']
                    color['skein_qty'] = row['skein_qty'] or 0
                    color['thread_id'] = row['id']
                    if not color['name']:
                        color['name'] = row['name']
                else:
                    color['inventory_status'] = 'not_found'
                    color['hex_color'] = None
                    color['skein_qty'] = 0
                    color['thread_id'] = None

                eff = (color['full_stitches'] * 1.0
                       + color['half_stitches'] * 0.5
                       + color['quarter_stitches'] * 0.25
                       + color['backstitch'] * 0.3)
                color['effective_stitches'] = round(eff, 2)


            total_eff = sum(c['effective_stitches'] for c in colors)
            if design_info['total_stitches'] is None and total_eff:
                design_info['total_stitches'] = round(total_eff)

            return jsonify({
                'detected': {
                    'fabric_count': fabric_count,
                    'strands': strands,
                },
                'colors': colors,
                'design_info': design_info,
            })

    except Exception as e:
        app.logger.exception("PDF parsing failed")
        return jsonify({'error': 'Failed to read PDF. The file may be corrupted or in an unsupported format.'}), 400


@app.route('/api/pattern/mark-need', methods=['POST'])
@limiter.limit("10 per minute")
@login_required
def mark_need():
    """Bulk-mark a list of thread numbers as 'need' (only if currently 'dont_own')."""
    data = request.get_json(silent=True) or {}
    thread_numbers = data.get('thread_numbers', [])
    brand = data.get('brand', 'DMC')
    if brand not in ('DMC', 'Anchor'):
        brand = 'DMC'
    if not thread_numbers:
        return jsonify({'error': 'No thread numbers provided'}), 400
    if not isinstance(thread_numbers, list) or len(thread_numbers) > 750:
        return jsonify({'error': 'thread_numbers must be a list of at most 750 items'}), 400
    thread_numbers = [str(n)[:20] for n in thread_numbers if isinstance(n, (str, int, float))]

    conn = get_db()
    cursor = conn.cursor()
    uid = current_user.id

    # Resolve thread numbers → IDs
    placeholders = ','.join('?' * len(thread_numbers))
    cursor.execute(
        f"SELECT id, number FROM threads WHERE brand = ? AND number IN ({placeholders})",
        [brand] + thread_numbers
    )
    thread_map = {r['number']: r['id'] for r in cursor.fetchall()}

    not_found = [n for n in thread_numbers if n not in thread_map]

    # Batch-fetch user statuses for found threads
    found_ids = list(thread_map.values())
    if found_ids:
        id_ph = ','.join('?' * len(found_ids))
        cursor.execute(
            f"SELECT thread_id, status FROM user_thread_status WHERE user_id = ? AND thread_id IN ({id_ph})",
            [uid] + found_ids
        )
        user_status = {r['thread_id']: r['status'] for r in cursor.fetchall()}
    else:
        user_status = {}

    # Determine which threads to update: only those currently 'dont_own' (or no row = default dont_own)
    skipped_owned = 0
    updated = 0
    for num in thread_numbers:
        tid = thread_map.get(num)
        if tid is None:
            continue
        current_status = user_status.get(tid, 'dont_own')
        if current_status == 'own':
            skipped_owned += 1
        elif current_status == 'dont_own':
            # UPSERT to 'need'
            if tid in user_status:
                cursor.execute(
                    "UPDATE user_thread_status SET status = 'need', updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND thread_id = ?",
                    (uid, tid)
                )
            else:
                cursor.execute(
                    "INSERT INTO user_thread_status (user_id, thread_id, status, updated_at) VALUES (?, ?, 'need', CURRENT_TIMESTAMP)",
                    (uid, tid)
                )
            updated += 1

    conn.commit()

    return jsonify({'updated': updated, 'skipped_owned': skipped_owned, 'not_found': not_found})


@app.route('/image-to-pattern')
@login_required
def image_to_pattern():
    """Image to cross-stitch pattern generator page."""
    return render_template('image-to-pattern.html',
                           pattern_symbols=_PATTERN_SYMBOLS)


@app.route('/api/image/session-source')
@limiter.limit("30 per minute")
@login_required
def session_source_image():
    """Serve the session's stored source image for crop overlay display."""
    fpath = session.get('upload_image_path')
    if not fpath:
        return jsonify({'error': 'No session image available'}), 404
    # Validate path is within uploads directory (defense-in-depth)
    real_path = os.path.realpath(fpath)
    uploads_real = os.path.realpath(UPLOADS_DIR)
    if not real_path.startswith(uploads_real + os.sep):
        app.logger.warning(f"Rejected session image path outside uploads: {fpath}")
        return jsonify({'error': 'Invalid file path'}), 403
    if not os.path.isfile(real_path):
        return jsonify({'error': 'No session image available'}), 404
    return send_file(real_path)


@app.route('/api/image/generate', methods=['POST'])
@limiter.limit("10 per minute")
@login_required
def generate_image_pattern():
    """Convert an uploaded image to a cross-stitch pattern."""
    allowed_exts = {'.jpg', '.jpeg', '.png', '.gif', '.webp'}

    # Branch A: new file uploaded → save to disk, store path in session
    if 'image' in request.files and request.files['image'].filename:
        img_file = request.files['image']
        ext = os.path.splitext(img_file.filename.lower())[1]
        if ext not in allowed_exts:
            return jsonify({'error': 'File must be an image (jpg, png, gif, webp)'}), 400
        img_bytes = img_file.read()
        if not img_bytes:
            return jsonify({'error': 'Uploaded file is empty'}), 400
        if len(img_bytes) > MAX_IMAGE_SIZE:
            return jsonify({'error': 'Image file must be 10 MB or smaller'}), 400
        try:
            test_img = Image.open(io.BytesIO(img_bytes))
            test_img.verify()
            test_img.close()
        except Exception:
            return jsonify({'error': 'Could not read image file'}), 400
        if not _check_disk_space():
            return jsonify({'error': 'Server storage is full. Please contact the administrator.'}), 507
        try:
            fname = uuid.uuid4().hex + ext
            fpath = os.path.join(UPLOADS_DIR, fname)
            with open(fpath, 'wb') as f:
                f.write(img_bytes)
            session['upload_image_path'] = fpath
        except OSError:
            app.logger.exception("Image save failed")
            return jsonify({'error': 'Could not save image. Please try again later.'}), 500

    # Branch B: reuse session image (settings-only change)
    elif request.form.get('use_session_image') == 'true':
        fpath = session.get('upload_image_path')
        if not fpath or not os.path.isfile(fpath):
            return jsonify({'error': 'No session image available'}), 400
        with open(fpath, 'rb') as f:
            img_bytes = f.read()

    # Branch C: regenerate from a saved pattern's stored image
    elif request.form.get('source_pattern_slug'):
        ref_slug = request.form['source_pattern_slug']
        conn = get_db()
        row = conn.execute(
            "SELECT source_image_path FROM saved_patterns WHERE slug=? AND user_id=?",
            (ref_slug, current_user.id)).fetchone()
        if not row or not row['source_image_path'] or not os.path.isfile(row['source_image_path']):
            return jsonify({'error': 'Source image not found for that pattern'}), 404
        fpath = row['source_image_path']
        with open(fpath, 'rb') as f:
            img_bytes = f.read()
        session['upload_image_path'] = fpath  # promote to session image

    else:
        return jsonify({'error': 'No image provided'}), 400

    # Parse parameters
    def clamp(val, lo, hi):
        return max(lo, min(hi, val))

    try:
        grid_w = clamp(int(request.form.get('grid_width', 100)), 25, 250)
        grid_height_raw = int(request.form.get('grid_height', 0))
        num_colors = clamp(int(request.form.get('num_colors', 15)), 5, 34)
        dither = request.form.get('dither', 'true').lower() not in ('false', '0', 'no')
        contrast = clamp(float(request.form.get('contrast', 1.0)), 0.5, 2.0)
        brightness = clamp(float(request.form.get('brightness', 1.0)), 0.5, 1.5)
    except (ValueError, TypeError):
        return jsonify({'error': 'Invalid parameter value. Check grid dimensions, colors, contrast, and brightness.'}), 400

    pixel_art = request.form.get('pixel_art', 'false').lower() in ('true', '1', 'yes')

    try:
        cl = max(0.0, min(1.0, float(request.form.get('crop_left',   0.0))))
        ct = max(0.0, min(1.0, float(request.form.get('crop_top',    0.0))))
        cr = max(0.0, min(1.0, float(request.form.get('crop_right',  1.0))))
        cb = max(0.0, min(1.0, float(request.form.get('crop_bottom', 1.0))))
        if cl >= cr or ct >= cb:
            crop = None
        else:
            crop = (cl, ct, cr, cb) if (cl, ct, cr, cb) != (0.0, 0.0, 1.0, 1.0) else None
    except (ValueError, TypeError):
        crop = None

    tmp_img = Image.open(io.BytesIO(img_bytes))
    native_w, native_h = tmp_img.size
    tmp_img.close()

    if grid_height_raw == 0:
        if crop:
            crop_w_px = (cr - cl) * native_w
            crop_h_px = (cb - ct) * native_h
            crop_aspect = (crop_h_px / crop_w_px) if crop_w_px > 0 else 1.0
            grid_h = clamp(max(1, round(grid_w * crop_aspect)), 1, 250)
        else:
            grid_h = clamp(max(1, round(grid_w * native_h / native_w)), 1, 250)
    else:
        grid_h = clamp(grid_height_raw, 25, 250)

    palette_brand = request.form.get('palette_brand', 'DMC')
    if palette_brand not in ('DMC', 'Anchor'):
        palette_brand = 'DMC'

    palette_filter = request.form.get('palette_filter', 'standard')
    if palette_filter not in ('standard', 'special', 'both'):
        palette_filter = 'standard'

    crop_shape = request.form.get('crop_shape', 'rect')
    if crop_shape not in ('rect', 'square', 'circle', 'ellipse'):
        crop_shape = 'rect'

    if not _PALETTE_LAB:
        return jsonify({'error': 'Thread palette not loaded — server may still be starting up'}), 503

    try:
        result = _generate_cross_stitch_pattern(img_bytes, grid_w, grid_h, num_colors, dither, contrast, brightness, palette_filter, pixel_art=pixel_art, crop=crop, crop_shape=crop_shape, palette_brand=palette_brand)
        result['native_w'] = native_w
        result['native_h'] = native_h
        result['image_stored'] = True
        return jsonify(result)
    except Exception as e:
        app.logger.exception("Pattern generation failed")
        return jsonify({'error': 'Pattern generation failed. Please try different settings or a different image.'}), 500


@app.route('/saved-patterns')
@login_required
def saved_patterns_page():
    """Saved patterns gallery page."""
    return render_template('saved-patterns.html')


@app.route('/view/<pattern_slug>')
@login_required
def view_pattern(pattern_slug):
    """Interactive pattern viewer page."""
    return render_template('pattern-viewer.html', pattern_slug=pattern_slug,
                           pattern_symbols=_PATTERN_SYMBOLS)


@app.route('/api/saved-patterns', methods=['POST'])
@limiter.limit("20 per minute")
@login_required
def api_save_pattern():
    """Save a new pattern."""
    data = request.get_json(silent=True) or {}

    name = str(data.get('name', 'Untitled')).strip()[:120] or 'Untitled'
    grid_data = data.get('grid_data')
    legend_data = data.get('legend_data')
    grid_w = data.get('grid_w')
    grid_h = data.get('grid_h')
    thumbnail = data.get('thumbnail')
    if thumbnail is not None and (not isinstance(thumbnail, str) or len(thumbnail) > MAX_THUMBNAIL):
        return jsonify({'error': 'Invalid thumbnail (max 500 KB)'}), 400
    if thumbnail and not thumbnail.startswith('data:image/'):
        return jsonify({'error': 'Thumbnail must be a data:image/ URI'}), 400
    generation_settings = data.get('generation_settings')  # dict or None
    image_source = data.get('image_source', '')             # "session" or "pattern:<N>"

    if not grid_data or legend_data is None or grid_w is None or grid_h is None:
        return jsonify({'error': 'grid_data, legend_data, grid_w, and grid_h are required'}), 400
    if not isinstance(grid_data, list) or not isinstance(legend_data, list):
        return jsonify({'error': 'grid_data and legend_data must be arrays'}), 400
    valid, err = _validate_grid_dims(grid_w, grid_h)
    if not valid:
        return jsonify({'error': err}), 400
    if len(grid_data) != grid_w * grid_h:
        return jsonify({'error': f'grid_data length ({len(grid_data)}) does not match {grid_w}\u00d7{grid_h}'}), 400

    grid_json = json.dumps(grid_data)
    legend_json = json.dumps(legend_data)
    if len(grid_json) + len(legend_json) > MAX_PATTERN_DATA:
        return jsonify({'error': 'Pattern data too large (max 2 MB)'}), 400
    if not _check_disk_space():
        return jsonify({'error': 'Server storage is full. Please contact the administrator.'}), 507

    color_count = len(legend_data)

    # Resolve source image path
    source_image_path = None
    if image_source == 'session':
        source_image_path = session.get('upload_image_path')
    elif isinstance(image_source, str) and image_source.startswith('pattern:'):
        try:
            ref_slug = image_source.split(':')[1]
            ref = get_db().execute(
                "SELECT source_image_path FROM saved_patterns WHERE slug=? AND user_id=?",
                (ref_slug, current_user.id)).fetchone()
            if ref:
                source_image_path = ref['source_image_path']
        except (ValueError, IndexError):
            pass

    gen_settings_json = json.dumps(generation_settings) if isinstance(generation_settings, dict) else None

    # Brand
    brand = data.get('brand', 'DMC')
    if brand not in ('DMC', 'Anchor'):
        brand = 'DMC'

    # Fabric color
    fabric_color = data.get('fabric_color', '#F5F0E8')
    if not isinstance(fabric_color, str) or not re.match(r'^#[0-9a-fA-F]{6}$', fabric_color):
        fabric_color = '#F5F0E8'

    # New stitch layers (optional — default to empty arrays)
    ps_json, bs_json, kn_json, bd_json = _serialize_stitch_layers(data)

    conn = get_db()
    cursor = conn.cursor()
    slug = _insert_pattern_with_slug(
        cursor, user_id=current_user.id, name=name, grid_w=grid_w, grid_h=grid_h,
        color_count=color_count, grid_json=grid_json, legend_json=legend_json,
        thumbnail=thumbnail, source_image_path=source_image_path,
        gen_settings_json=gen_settings_json,
        ps_json=ps_json, bs_json=bs_json, kn_json=kn_json, bd_json=bd_json, brand=brand,
        fabric_color=fabric_color)
    if not slug:
        return jsonify({'error': 'Could not save pattern. Please try again.'}), 500
    conn.commit()

    return jsonify({'slug': slug, 'name': name}), 201


@app.route('/api/saved-patterns/import', methods=['POST'])
@limiter.limit("20 per minute")
@login_required
def api_import_pattern():
    """Import a pattern from a JSON export file."""
    data = request.get_json(silent=True)
    if not data:
        return jsonify({'error': 'Request body must be JSON'}), 400

    if data.get('format') not in ('needlework-studio', 'dmc-thread-studio'):
        return jsonify({'error': 'Not a Needlework Studio export file'}), 400
    if data.get('version') not in (1, 2):
        return jsonify({'error': f'Unsupported format version: {data.get("version")}'}), 400

    name = str(data.get('name', 'Imported Pattern')).strip()[:120] or 'Imported Pattern'
    grid_data = data.get('grid_data')
    legend_data = data.get('legend_data')
    grid_w = data.get('grid_w')
    grid_h = data.get('grid_h')

    if not isinstance(grid_data, list) or not isinstance(legend_data, list):
        return jsonify({'error': 'grid_data and legend_data must be arrays'}), 400
    valid, err = _validate_grid_dims(grid_w, grid_h)
    if not valid:
        return jsonify({'error': err}), 400
    if len(grid_data) != grid_w * grid_h:
        return jsonify({'error': f'grid_data length ({len(grid_data)}) does not match {grid_w}\u00d7{grid_h}'}), 400
    if not legend_data:
        return jsonify({'error': 'legend_data must not be empty'}), 400

    # Validate legend_data entries — sanitize hex values to prevent stored XSS
    _hex_re = re.compile(r'^#[0-9a-fA-F]{3,8}$')
    for entry in legend_data:
        if not isinstance(entry, dict):
            return jsonify({'error': 'legend_data entries must be objects'}), 400
        hex_val = entry.get('hex', '')
        if not isinstance(hex_val, str) or not _hex_re.match(hex_val):
            entry['hex'] = '#888888'

    grid_json = json.dumps(grid_data)
    legend_json = json.dumps(legend_data)
    if len(grid_json) + len(legend_json) > MAX_PATTERN_DATA:
        return jsonify({'error': 'Pattern data too large (max 2 MB)'}), 400
    if not _check_disk_space():
        return jsonify({'error': 'Server storage is full. Please contact the administrator.'}), 507

    color_count = len(legend_data)
    thumbnail = data.get('thumbnail') if isinstance(data.get('thumbnail'), str) else None
    if thumbnail and not thumbnail.startswith('data:image/'):
        thumbnail = None  # silently drop non-image thumbnails

    # Brand
    brand = data.get('brand', 'DMC')
    if brand not in ('DMC', 'Anchor'):
        brand = 'DMC'

    # Fabric color
    fabric_color = data.get('fabric_color', '#F5F0E8')
    if not isinstance(fabric_color, str) or not re.match(r'^#[0-9a-fA-F]{6}$', fabric_color):
        fabric_color = '#F5F0E8'

    # v2 stitch layers
    ps_json, bs_json, kn_json, bd_json = _serialize_stitch_layers(data)

    conn = get_db()
    cursor = conn.cursor()
    slug = _insert_pattern_with_slug(
        cursor, user_id=current_user.id, name=name, grid_w=grid_w, grid_h=grid_h,
        color_count=color_count, grid_json=grid_json, legend_json=legend_json,
        thumbnail=thumbnail,
        ps_json=ps_json, bs_json=bs_json, kn_json=kn_json, bd_json=bd_json, brand=brand,
        fabric_color=fabric_color)
    if not slug:
        return jsonify({'error': 'Could not save pattern. Please try again.'}), 500
    conn.commit()

    return jsonify({'slug': slug, 'name': name, 'color_count': color_count}), 201


@app.route('/api/saved-patterns', methods=['GET'])
@limiter.limit("30 per minute")
@login_required
def api_list_saved_patterns():
    """List saved patterns for the current user (no blobs)."""
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        """SELECT slug, name, grid_w, grid_h, color_count, thumbnail, created_at, updated_at,
                  project_status, progress_data, brand, notes
             FROM saved_patterns
            WHERE user_id = ?
            ORDER BY updated_at DESC""",
        (current_user.id,)
    )
    rows = []
    pattern_ids = {}  # slug → index
    for r in cursor.fetchall():
        d = dict(r)
        d.update(_parse_progress_data(d.pop('progress_data', None)))
        d['tags'] = []
        pattern_ids[d['slug']] = len(rows)
        rows.append(d)

    # Batch-fetch tags for all patterns
    if rows:
        tag_rows = conn.execute(
            """SELECT sp.slug, pt.id, pt.name, pt.color
                 FROM pattern_tag_map ptm
                 JOIN pattern_tags pt ON pt.id = ptm.tag_id
                 JOIN saved_patterns sp ON sp.id = ptm.pattern_id
                WHERE sp.user_id = ?
                ORDER BY pt.name""",
            (current_user.id,)
        ).fetchall()
        for tr in tag_rows:
            idx = pattern_ids.get(tr['slug'])
            if idx is not None:
                rows[idx]['tags'].append({
                    'id': tr['id'], 'name': tr['name'], 'color': tr['color']
                })

    return jsonify(rows)


@app.route('/api/saved-patterns/export-all', methods=['GET'])
@limiter.limit("5 per minute")
@login_required
def api_export_all_patterns():
    """Download a ZIP of all user patterns as JSON files."""
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        """SELECT slug, name, grid_w, grid_h, grid_data, legend_data, thumbnail,
                  part_stitches_data, backstitches_data, knots_data, beads_data, brand, fabric_color, notes
             FROM saved_patterns
            WHERE user_id = ?
            ORDER BY updated_at DESC""",
        (current_user.id,)
    )
    # Pre-fetch tags per pattern
    tag_map = {}  # slug → [tag_name, ...]
    tag_rows = conn.execute(
        """SELECT sp.slug, pt.name
             FROM pattern_tag_map ptm
             JOIN pattern_tags pt ON pt.id = ptm.tag_id
             JOIN saved_patterns sp ON sp.id = ptm.pattern_id
            WHERE sp.user_id = ?
            ORDER BY pt.name""",
        (current_user.id,)
    ).fetchall()
    for tr in tag_rows:
        tag_map.setdefault(tr['slug'], []).append(tr['name'])

    buf = io.BytesIO()
    count = 0
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
        for row in cursor:
            r = dict(row)
            slug = r['slug']
            # Sanitize name for filename: keep alphanumeric, spaces, hyphens, underscores
            safe_name = re.sub(r'[^\w\s-]', '', r['name']).strip()
            safe_name = re.sub(r'\s+', '-', safe_name).lower()
            filename = f"{slug}-{safe_name}.json" if safe_name else f"{slug}.json"

            try:
                grid_data = json.loads(r['grid_data'])
                legend_raw = json.loads(r['legend_data'])
                part_stitches = json.loads(r['part_stitches_data'] or '[]')
                backstitches = json.loads(r['backstitches_data'] or '[]')
                knots = json.loads(r['knots_data'] or '[]')
                beads = json.loads(r['beads_data'] or '[]')
            except (json.JSONDecodeError, TypeError):
                app.logger.exception("Skipping corrupted pattern %s during export-all", slug)
                continue

            # Strip legend to essential fields (matches client-side exportJSON)
            legend_data = []
            for e in legend_raw:
                legend_data.append({
                    'dmc': e.get('dmc'), 'hex': e.get('hex'), 'name': e.get('name'),
                    'symbol': e.get('symbol'), 'stitches': e.get('stitches'),
                    'category': e.get('category'),
                })

            payload = {
                'format': 'needlework-studio',
                'version': 1,
                'exported_at': datetime.utcnow().isoformat() + 'Z',
                'name': r['name'],
                'brand': r.get('brand') or 'DMC',
                'fabric_color': r.get('fabric_color') or '#F5F0E8',
                'grid_w': r['grid_w'],
                'grid_h': r['grid_h'],
                'grid_data': grid_data,
                'legend_data': legend_data,
                'part_stitches': part_stitches,
                'backstitches': backstitches,
                'knots': knots,
                'beads': beads,
                'thumbnail': r.get('thumbnail') or '',
                'notes': r.get('notes') or '',
                'tags': tag_map.get(slug, []),
            }
            zf.writestr(filename, json.dumps(payload, separators=(',', ':')))
            count += 1

    if count == 0:
        return jsonify({'error': 'No patterns to export'}), 404

    buf.seek(0)
    date_str = datetime.utcnow().strftime('%Y-%m-%d')
    return send_file(
        buf,
        mimetype='application/zip',
        as_attachment=True,
        download_name=f'needlework-studio-backup-{date_str}.zip',
    )


@app.route('/api/shopping-list', methods=['GET'])
@login_required
@limiter.limit("10 per minute")
def api_shopping_list():
    """Aggregate thread needs across all non-completed patterns."""
    conn = get_db()
    rows = conn.execute(
        """SELECT slug, name, legend_data, brand, project_status
             FROM saved_patterns
            WHERE user_id = ? AND project_status != 'completed'
            ORDER BY name""",
        (current_user.id,)
    ).fetchall()

    # Aggregate: (brand, dmc) → { name, hex, patterns: [{name, slug, stitches}], total_stitches }
    agg = {}
    for r in rows:
        try:
            legend = json.loads(r['legend_data'])
        except (json.JSONDecodeError, TypeError):
            continue
        brand = r['brand'] or 'DMC'
        for entry in legend:
            dmc = entry.get('dmc')
            if not dmc or dmc == 'BG':
                continue
            key = (brand, str(dmc))
            if key not in agg:
                agg[key] = {
                    'dmc': str(dmc), 'name': entry.get('name', ''),
                    'hex': entry.get('hex', '#888'), 'brand': brand,
                    'patterns': [], 'total_stitches': 0
                }
            agg[key]['patterns'].append({
                'name': r['name'], 'slug': r['slug'],
                'stitches': entry.get('stitches', 0)
            })
            agg[key]['total_stitches'] += entry.get('stitches', 0)

    # Enrich with inventory status
    result = list(agg.values())
    for brand_name in set(k[0] for k in agg):
        brand_threads = [v for v in result if v['brand'] == brand_name]
        numbers = [v['dmc'] for v in brand_threads]
        live = _lookup_threads_by_number(conn, current_user.id, brand_name, numbers,
                                          extra_fields=('skein_qty',))
        for v in brand_threads:
            info = live.get(v['dmc'])
            if info:
                v['status'] = info['status']
                v['skein_qty'] = info['skein_qty'] or 0
            else:
                v['status'] = 'dont_own'
                v['skein_qty'] = 0

    result.sort(key=lambda x: x['dmc'])
    return jsonify(result)


@app.route('/api/saved-patterns/<pattern_slug>', methods=['GET'])
@login_required
@limiter.limit("60 per minute")
def api_get_saved_pattern(pattern_slug):
    """Load a single saved pattern with full data."""
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        """SELECT id, slug, name, grid_w, grid_h, color_count, grid_data, legend_data, thumbnail,
                  created_at, updated_at, source_image_path, generation_settings, progress_data,
                  project_status, part_stitches_data, backstitches_data, knots_data, beads_data, brand, fabric_color, notes
             FROM saved_patterns
            WHERE slug = ? AND user_id = ?""",
        (pattern_slug, current_user.id)
    )
    row = cursor.fetchone()

    if not row:
        return jsonify({'error': 'Pattern not found'}), 404

    result = dict(row)
    try:
        result['grid_data'] = json.loads(result['grid_data'])
        result['legend_data'] = json.loads(result['legend_data'])
        result['part_stitches'] = json.loads(result.pop('part_stitches_data') or '[]')
        result['backstitches'] = json.loads(result.pop('backstitches_data') or '[]')
        result['knots'] = json.loads(result.pop('knots_data') or '[]')
        result['beads'] = json.loads(result.pop('beads_data') or '[]')
    except (json.JSONDecodeError, TypeError):
        return jsonify({'error': 'Pattern data is corrupted'}), 500

    # Refresh thread status + skein_qty from live per-user inventory
    pattern_brand = result.get('brand', 'DMC')
    uid = current_user.id
    dmc_numbers = [e['dmc'] for e in result['legend_data'] if e.get('dmc')]
    if dmc_numbers:
        _live = _lookup_threads_by_number(conn, uid, pattern_brand, dmc_numbers,
                                           extra_fields=('id', 'skein_qty'))
        live_status = {n: r['status'] for n, r in _live.items()}
        live_qty = {n: r['skein_qty'] or 0 for n, r in _live.items()}
        live_id = {n: r['id'] for n, r in _live.items()}
        for entry in result['legend_data']:
            dmc = entry.get('dmc')
            if dmc in live_status:
                entry['status'] = live_status[dmc]
                entry['skein_qty'] = live_qty.get(dmc, 0)
                entry['thread_id'] = live_id.get(dmc)
            else:
                entry['skein_qty'] = 0
                entry['thread_id'] = None

    result['has_source_image'] = bool(
        result.get('source_image_path') and os.path.isfile(result['source_image_path']))
    try:
        result['generation_settings'] = (
            json.loads(result['generation_settings']) if result.get('generation_settings') else None)
        pd = result.get('progress_data')
        pd_parsed = json.loads(pd) if pd else {}
        result['completed_dmcs'] = pd_parsed.get('completed_dmcs', [])
        result['stitched_cells'] = pd_parsed.get('stitched_cells', [])
        result['place_markers'] = pd_parsed.get('place_markers', [])
        result['accumulated_seconds'] = pd_parsed.get('accumulated_seconds', 0)
    except (json.JSONDecodeError, KeyError, TypeError):
        result['generation_settings'] = None
        result['completed_dmcs'] = []
        result['stitched_cells'] = []
        result['place_markers'] = []
        result['accumulated_seconds'] = 0
    # Fetch tags for this pattern
    tag_rows = conn.execute(
        """SELECT pt.id, pt.name, pt.color
             FROM pattern_tag_map ptm
             JOIN pattern_tags pt ON pt.id = ptm.tag_id
            WHERE ptm.pattern_id = ?
            ORDER BY pt.name""",
        (result['id'],)
    ).fetchall()
    result['tags'] = [{'id': t['id'], 'name': t['name'], 'color': t['color']} for t in tag_rows]

    del result['source_image_path']  # don't expose internal path to client
    del result['progress_data']      # replaced by individual keys above
    del result['id']                 # don't expose internal integer id
    return jsonify(result)


@app.route('/api/saved-patterns/<pattern_slug>', methods=['PATCH'])
@limiter.limit("30 per minute")
@login_required
def api_update_saved_pattern(pattern_slug):
    """Update a saved pattern (rename, save progress, or update grid/legend)."""
    data = request.get_json(silent=True) or {}
    conn = get_db()
    cursor = conn.cursor()
    # Resolve slug to internal id
    _row = cursor.execute(
        "SELECT id FROM saved_patterns WHERE slug = ? AND user_id = ?",
        (pattern_slug, current_user.id)).fetchone()
    if not _row:
        return jsonify({'error': 'Pattern not found'}), 404
    pattern_id = _row['id']

    # Grid + legend update (editor save)
    if 'grid_data' in data and 'legend_data' in data:
        grid_data = data['grid_data']
        legend_data = data['legend_data']
        if not isinstance(grid_data, list) or not isinstance(legend_data, list):
            return jsonify({'error': 'grid_data and legend_data must be arrays'}), 400
        # Accept optional new dimensions (canvas resize)
        new_grid_w = data.get('grid_w')
        new_grid_h = data.get('grid_h')
        if new_grid_w is not None and new_grid_h is not None:
            valid, err = _validate_grid_dims(new_grid_w, new_grid_h)
            if not valid:
                return jsonify({'error': err}), 400
            if len(grid_data) != new_grid_w * new_grid_h:
                return jsonify({'error': f'grid_data length ({len(grid_data)}) does not match {new_grid_w}×{new_grid_h}'}), 400
        else:
            dims = cursor.execute('SELECT grid_w, grid_h FROM saved_patterns WHERE id=? AND user_id=?',
                                  [pattern_id, current_user.id]).fetchone()
            if dims and len(grid_data) != dims['grid_w'] * dims['grid_h']:
                return jsonify({'error': 'grid_data length does not match pattern dimensions'}), 400
            new_grid_w = dims['grid_w'] if dims else None
            new_grid_h = dims['grid_h'] if dims else None
        grid_json = json.dumps(grid_data)
        legend_json = json.dumps(legend_data)
        # Serialize new stitch layers (default to existing if not provided)
        part_stitches = data.get('part_stitches')
        backstitches = data.get('backstitches')
        knots = data.get('knots')
        beads = data.get('beads')
        ps_json = json.dumps(part_stitches) if isinstance(part_stitches, list) else None
        bs_json = json.dumps(backstitches) if isinstance(backstitches, list) else None
        kn_json = json.dumps(knots) if isinstance(knots, list) else None
        bd_json = json.dumps(beads) if isinstance(beads, list) else None

        total_size = len(grid_json) + len(legend_json)
        if ps_json:
            total_size += len(ps_json)
        if bs_json:
            total_size += len(bs_json)
        if kn_json:
            total_size += len(kn_json)
        if bd_json:
            total_size += len(bd_json)
        if total_size > MAX_PATTERN_FULL:
            return jsonify({'error': 'Pattern data too large (max 4 MB)'}), 400
        color_count = len(legend_data)
        thumbnail = data.get('thumbnail')
        if thumbnail and (not isinstance(thumbnail, str) or not thumbnail.startswith('data:image/')):
            thumbnail = None  # silently drop invalid thumbnails

        # Build dynamic UPDATE
        fields = ['grid_data=?', 'legend_data=?', 'color_count=?', 'grid_w=?', 'grid_h=?',
                  'updated_at=CURRENT_TIMESTAMP']
        params = [grid_json, legend_json, color_count, new_grid_w, new_grid_h]
        if thumbnail:
            fields.append('thumbnail=?')
            params.append(thumbnail)
        if ps_json is not None:
            fields.append('part_stitches_data=?')
            params.append(ps_json)
        if bs_json is not None:
            fields.append('backstitches_data=?')
            params.append(bs_json)
        if kn_json is not None:
            fields.append('knots_data=?')
            params.append(kn_json)
        if bd_json is not None:
            fields.append('beads_data=?')
            params.append(bd_json)
        fabric_color = data.get('fabric_color')
        if fabric_color is not None:
            if isinstance(fabric_color, str) and re.match(r'^#[0-9a-fA-F]{6}$', fabric_color):
                fields.append('fabric_color=?')
                params.append(fabric_color)
        params.extend([pattern_id, current_user.id])
        cursor.execute(
            f'UPDATE saved_patterns SET {",".join(fields)} WHERE id=? AND user_id=?',
            params)
        conn.commit()
        affected = cursor.rowcount
        if affected == 0:
            return jsonify({'error': 'Pattern not found'}), 404
        return jsonify({'ok': True, 'color_count': color_count})

    if 'notes' in data:
        notes_val = str(data['notes'] or '')[:2000]
        cursor.execute(
            'UPDATE saved_patterns SET notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?',
            [notes_val, pattern_id, current_user.id])
        conn.commit()
        if cursor.rowcount == 0:
            return jsonify({'error': 'Pattern not found'}), 404
        return jsonify({'ok': True})

    if 'project_status' in data:
        new_status = data['project_status']
        if new_status not in ('not_started', 'in_progress', 'completed'):
            return jsonify({'error': 'Invalid project_status'}), 400
        cursor.execute(
            'UPDATE saved_patterns SET project_status=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?',
            [new_status, pattern_id, current_user.id]
        )
        conn.commit()
        affected = cursor.rowcount
        if affected == 0:
            return jsonify({'error': 'Pattern not found'}), 404
        return jsonify({'ok': True})

    if 'progress_data' in data:
        pd = data['progress_data']
        if not isinstance(pd, dict) or not isinstance(pd.get('completed_dmcs'), list):
            return jsonify({'error': 'progress_data must include completed_dmcs array'}), 400
        # Validate stitched_cells if present
        sc = pd.get('stitched_cells', [])
        if not isinstance(sc, list):
            return jsonify({'error': 'stitched_cells must be an array'}), 400
        if sc and not all(isinstance(i, int) and not isinstance(i, bool) and i >= 0 for i in sc):
            return jsonify({'error': 'stitched_cells must contain non-negative integers'}), 400
        # Validate place_markers if present
        pm = pd.get('place_markers', [])
        if not isinstance(pm, list):
            return jsonify({'error': 'place_markers must be an array'}), 400
        _marker_re = re.compile(r'^\d{1,6},\d{1,6}$')
        if pm and not all(isinstance(m, str) and _marker_re.match(m) for m in pm):
            return jsonify({'error': 'place_markers must contain "col,row" strings'}), 400
        # Validate accumulated_seconds if present
        acc = pd.get('accumulated_seconds')
        if acc is not None:
            if not isinstance(acc, int) or isinstance(acc, bool) or acc < 0 or acc > 315360000:
                return jsonify({'error': 'accumulated_seconds must be a non-negative integer'}), 400
        pd_json = json.dumps(pd)
        if len(pd_json) > MAX_PROGRESS_DATA:
            return jsonify({'error': 'progress_data too large'}), 400
        cursor.execute(
            'UPDATE saved_patterns SET progress_data=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?',
            [pd_json, pattern_id, current_user.id]
        )
        conn.commit()
        affected = cursor.rowcount
        if affected == 0:
            return jsonify({'error': 'Pattern not found'}), 404
        return jsonify({'ok': True})

    if 'thumbnail' in data and len(data) == 1:
        thumb = data['thumbnail']
        if not isinstance(thumb, str) or len(thumb) > MAX_THUMBNAIL:
            return jsonify({'error': 'Invalid thumbnail'}), 400
        if thumb and not thumb.startswith('data:image/'):
            return jsonify({'error': 'Thumbnail must be a data:image/ URI'}), 400
        cursor.execute(
            'UPDATE saved_patterns SET thumbnail=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?',
            [thumb, pattern_id, current_user.id])
        conn.commit()
        affected = cursor.rowcount
        if affected == 0:
            return jsonify({'error': 'Pattern not found'}), 404
        return jsonify({'ok': True})

    new_name = str(data.get('name', '')).strip()[:120]
    if not new_name:
        return jsonify({'error': 'name, progress_data, or project_status is required'}), 400

    cursor.execute(
        """UPDATE saved_patterns
              SET name = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND user_id = ?""",
        (new_name, pattern_id, current_user.id)
    )
    conn.commit()
    affected = cursor.rowcount

    if affected == 0:
        return jsonify({'error': 'Pattern not found'}), 404
    return jsonify({'slug': pattern_slug, 'name': new_name})


@app.route('/api/saved-patterns/<pattern_slug>', methods=['DELETE'])
@limiter.limit("20 per minute")
@login_required
def api_delete_saved_pattern(pattern_slug):
    """Delete a saved pattern."""
    conn = get_db()
    cursor = conn.cursor()
    # Fetch source image path before deleting
    row = cursor.execute(
        "SELECT id, source_image_path FROM saved_patterns WHERE slug = ? AND user_id = ?",
        (pattern_slug, current_user.id)).fetchone()
    if not row:
        return jsonify({'error': 'Pattern not found'}), 404
    pattern_id = row['id']
    cursor.execute(
        "DELETE FROM saved_patterns WHERE id = ? AND user_id = ?",
        (pattern_id, current_user.id)
    )
    conn.commit()
    affected = cursor.rowcount
    # Log deletion for sync
    if affected > 0:
        cursor.execute(
            "INSERT INTO sync_log (entity_type, entity_key, action, user_id) VALUES ('pattern', ?, 'delete', ?)",
            (pattern_slug, current_user.id))
        conn.commit()
    # Clean up image file if no other patterns reference it
    if affected > 0 and row and row['source_image_path']:
        img_path = row['source_image_path']
        ref_count = cursor.execute(
            "SELECT COUNT(*) FROM saved_patterns WHERE source_image_path = ?",
            (img_path,)).fetchone()[0]
        if ref_count == 0:
            try:
                os.remove(img_path)
            except FileNotFoundError:
                pass

    if affected == 0:
        return jsonify({'error': 'Pattern not found'}), 404
    # Sweep any other orphaned images (e.g. from expired sessions)
    _cleanup_orphaned_images()
    return '', 204


@app.route('/api/saved-patterns/batch', methods=['POST'])
@limiter.limit("10 per minute")
@login_required
def api_batch_saved_patterns():
    """Batch operations on saved patterns (delete, status update)."""
    data = request.get_json(silent=True) or {}
    action = data.get('action')
    slugs = data.get('slugs', [])

    if not slugs or not isinstance(slugs, list):
        return jsonify({'error': 'slugs array required'}), 400
    slugs = [str(s).strip() for s in slugs]
    if len(slugs) > 500:
        return jsonify({'error': 'Too many slugs (max 500)'}), 400

    conn = get_db()
    cursor = conn.cursor()

    # Resolve slugs to internal integer ids
    slug_placeholders = ','.join('?' * len(slugs))
    id_rows = cursor.execute(
        f"SELECT id, slug, source_image_path FROM saved_patterns WHERE slug IN ({slug_placeholders}) AND user_id = ?",
        slugs + [current_user.id]).fetchall()
    ids = [r['id'] for r in id_rows]

    if not ids:
        return jsonify({'error': 'No matching patterns found'}), 404

    if action == 'delete':
        image_paths = [r['source_image_path'] for r in id_rows if r['source_image_path']]
        deleted_slugs = [r['slug'] for r in id_rows]
        placeholders = ','.join('?' * len(ids))

        cursor.execute(
            f"DELETE FROM saved_patterns WHERE id IN ({placeholders}) AND user_id = ?",
            ids + [current_user.id])
        conn.commit()
        deleted = cursor.rowcount

        # Log deletions for sync
        for s in deleted_slugs:
            cursor.execute(
                "INSERT INTO sync_log (entity_type, entity_key, action, user_id) VALUES ('pattern', ?, 'delete', ?)",
                (s, current_user.id))
        conn.commit()

        # Clean up orphaned images
        for img_path in image_paths:
            ref_count = cursor.execute(
                "SELECT COUNT(*) FROM saved_patterns WHERE source_image_path = ?",
                (img_path,)).fetchone()[0]
            if ref_count == 0:
                try:
                    os.remove(img_path)
                except FileNotFoundError:
                    pass
        _cleanup_orphaned_images()
        return jsonify({'deleted': deleted}), 200

    elif action == 'status':
        new_status = data.get('status')
        if new_status not in ('not_started', 'in_progress', 'completed'):
            return jsonify({'error': 'Invalid status'}), 400
        placeholders = ','.join('?' * len(ids))
        cursor.execute(
            f"UPDATE saved_patterns SET project_status = ? WHERE id IN ({placeholders}) AND user_id = ?",
            [new_status] + ids + [current_user.id])
        conn.commit()
        updated = cursor.rowcount
        return jsonify({'updated': updated}), 200

    elif action == 'tag':
        tag_ids = data.get('tag_ids', [])
        mode = data.get('mode', 'add')  # 'add' | 'remove' | 'set'
        if mode not in ('add', 'remove', 'set'):
            return jsonify({'error': 'Invalid mode'}), 400
        if not isinstance(tag_ids, list) or not all(isinstance(t, int) for t in tag_ids):
            return jsonify({'error': 'tag_ids must be list of integers'}), 400
        # Validate all tag_ids belong to current user
        if tag_ids:
            ph = ','.join('?' * len(tag_ids))
            valid = cursor.execute(
                f"SELECT id FROM pattern_tags WHERE id IN ({ph}) AND user_id = ?",
                tag_ids + [current_user.id]).fetchall()
            valid_ids = {r['id'] for r in valid}
            tag_ids = [t for t in tag_ids if t in valid_ids]
        for pid in ids:
            if mode == 'set':
                cursor.execute("DELETE FROM pattern_tag_map WHERE pattern_id = ?", (pid,))
            if mode == 'remove':
                for tid in tag_ids:
                    cursor.execute("DELETE FROM pattern_tag_map WHERE tag_id = ? AND pattern_id = ?", (tid, pid))
            elif mode in ('add', 'set'):
                for tid in tag_ids:
                    cursor.execute("INSERT OR IGNORE INTO pattern_tag_map (tag_id, pattern_id) VALUES (?, ?)", (tid, pid))
        conn.commit()
        return jsonify({'updated': len(ids)}), 200

    else:
        return jsonify({'error': 'Unknown action. Use "delete", "status", or "tag".'}), 400


# ──── Tag CRUD ────────────────────────────────────────────
_TAG_COLORS = {'red', 'orange', 'gold', 'green', 'blue', 'purple', 'pink', 'gray'}


@app.route('/api/tags', methods=['GET'])
@login_required
@limiter.limit("30 per minute")
def api_list_tags():
    conn = get_db()
    rows = conn.execute("""
        SELECT pt.id, pt.name, pt.color,
               COUNT(ptm.pattern_id) AS pattern_count
        FROM pattern_tags pt
        LEFT JOIN pattern_tag_map ptm ON ptm.tag_id = pt.id
        WHERE pt.user_id = ?
        GROUP BY pt.id
        ORDER BY pt.name COLLATE NOCASE
    """, (current_user.id,)).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route('/api/tags', methods=['POST'])
@login_required
@limiter.limit("20 per minute")
def api_create_tag():
    data = request.get_json(silent=True) or {}
    name = (data.get('name') or '').strip()
    if not name or len(name) > 30:
        return jsonify({'error': 'Tag name required (1-30 chars)'}), 400
    color = data.get('color')
    if color and color not in _TAG_COLORS:
        color = None
    conn = get_db()
    # Check limit
    count = conn.execute("SELECT COUNT(*) as c FROM pattern_tags WHERE user_id = ?",
                         (current_user.id,)).fetchone()['c']
    if count >= 20:
        return jsonify({'error': 'Maximum 20 tags allowed'}), 400
    try:
        cursor = conn.execute(
            "INSERT INTO pattern_tags (user_id, name, color) VALUES (?, ?, ?)",
            (current_user.id, name, color))
        conn.commit()
        return jsonify({'id': cursor.lastrowid, 'name': name, 'color': color}), 201
    except Exception:
        return jsonify({'error': 'Tag name already exists'}), 409


@app.route('/api/tags/<int:tag_id>', methods=['PATCH'])
@login_required
@limiter.limit("20 per minute")
def api_update_tag(tag_id):
    conn = get_db()
    tag = conn.execute("SELECT * FROM pattern_tags WHERE id = ? AND user_id = ?",
                       (tag_id, current_user.id)).fetchone()
    if not tag:
        return jsonify({'error': 'Tag not found'}), 404
    data = request.get_json(silent=True) or {}
    updates, params = [], []
    if 'name' in data:
        name = (data['name'] or '').strip()
        if not name or len(name) > 30:
            return jsonify({'error': 'Tag name required (1-30 chars)'}), 400
        updates.append("name = ?")
        params.append(name)
    if 'color' in data:
        color = data['color']
        if color and color not in _TAG_COLORS:
            color = None
        updates.append("color = ?")
        params.append(color)
    if not updates:
        return jsonify({'error': 'Nothing to update'}), 400
    params.append(tag_id)
    try:
        conn.execute(f"UPDATE pattern_tags SET {', '.join(updates)} WHERE id = ?", params)
        conn.commit()
        return jsonify({'ok': True})
    except Exception:
        return jsonify({'error': 'Tag name already exists'}), 409


@app.route('/api/tags/<int:tag_id>', methods=['DELETE'])
@login_required
@limiter.limit("20 per minute")
def api_delete_tag(tag_id):
    conn = get_db()
    tag = conn.execute("SELECT id FROM pattern_tags WHERE id = ? AND user_id = ?",
                       (tag_id, current_user.id)).fetchone()
    if not tag:
        return jsonify({'error': 'Tag not found'}), 404
    conn.execute("DELETE FROM pattern_tag_map WHERE tag_id = ?", (tag_id,))
    conn.execute("DELETE FROM pattern_tags WHERE id = ?", (tag_id,))
    conn.commit()
    return '', 204


@app.route('/api/saved-patterns/<pattern_slug>/tags', methods=['PUT'])
@login_required
@limiter.limit("20 per minute")
def api_set_pattern_tags(pattern_slug):
    conn = get_db()
    pat = conn.execute("SELECT id FROM saved_patterns WHERE slug = ? AND user_id = ?",
                       (pattern_slug, current_user.id)).fetchone()
    if not pat:
        return jsonify({'error': 'Pattern not found'}), 404
    data = request.get_json(silent=True) or {}
    tag_ids = data.get('tag_ids', [])
    if not isinstance(tag_ids, list):
        return jsonify({'error': 'tag_ids must be array'}), 400
    if len(tag_ids) > 10:
        return jsonify({'error': 'Maximum 10 tags per pattern'}), 400
    # Validate ownership
    if tag_ids:
        ph = ','.join('?' * len(tag_ids))
        valid = conn.execute(
            f"SELECT id FROM pattern_tags WHERE id IN ({ph}) AND user_id = ?",
            tag_ids + [current_user.id]).fetchall()
        tag_ids = [r['id'] for r in valid]
    pid = pat['id']
    conn.execute("DELETE FROM pattern_tag_map WHERE pattern_id = ?", (pid,))
    for tid in tag_ids:
        conn.execute("INSERT INTO pattern_tag_map (tag_id, pattern_id) VALUES (?, ?)", (tid, pid))
    conn.commit()
    return jsonify({'ok': True})


@app.route('/pdf-to-pattern')
@login_required
def pdf_to_pattern():
    return render_template('pdf-to-pattern.html')


@app.route('/json-to-pattern')
@login_required
def json_to_pattern():
    return render_template('json-to-pattern.html')


@app.route('/oxs-to-pattern')
@login_required
def oxs_to_pattern():
    return render_template('oxs-to-pattern.html')


@app.route('/create-pattern')
@login_required
def create_pattern():
    return render_template('create-pattern.html',
                           pattern_symbols=_PATTERN_SYMBOLS)


@app.route('/api/pdf/import', methods=['POST'])
@limiter.limit("10 per minute")
@login_required
def api_pdf_import():
    if 'pdf' not in request.files:
        return jsonify({'error': 'No PDF uploaded'}), 400
    pdf_file = request.files['pdf']
    if not pdf_file.filename.lower().endswith('.pdf'):
        return jsonify({'error': 'File must be a PDF'}), 400
    try:
        pdf_bytes = pdf_file.read()
        if not pdf_bytes:
            return jsonify({'error': 'Uploaded file is empty'}), 400
        if len(pdf_bytes) > MAX_PDF_SIZE:
            return jsonify({'error': 'PDF too large (max 25 MB)'}), 400
        if pdf_bytes[:5] != b'%PDF-':
            return jsonify({'error': 'File does not appear to be a valid PDF'}), 400
        data = _import_pdf_pattern(pdf_bytes)
        return jsonify(data)
    except Exception as e:
        app.logger.exception("PDF import failed")
        return jsonify({'error': 'PDF import failed. The file may be corrupted or in an unsupported format.'}), 500


# ──────────────────────────────────────────────────────────────────────────────
# Sync API endpoints (server-side) — used by desktop app to sync data
# ──────────────────────────────────────────────────────────────────────────────

@app.route('/api/sync/pair', methods=['POST'])
@csrf.exempt
@limiter.limit("3 per minute")
def api_sync_pair():
    """Exchange username/password for a long-lived API token."""
    data = request.get_json(silent=True) or {}
    username = data.get('username', '').strip()
    password = data.get('password', '')

    if not username or not password:
        return jsonify({'error': 'Username and password are required'}), 400

    user_data = User.get_by_username(username)
    if user_data:
        is_valid, rehash = User.verify_password(user_data['password_hash'], password)
    else:
        # Constant-time: run Argon2 anyway to prevent timing leaks
        try:
            ph.verify(_dummy_hash, password)
        except Exception:
            pass
        is_valid, rehash = False, None

    if not is_valid or not user_data:
        return jsonify({'error': 'Invalid username or password'}), 401
    if not user_data['is_active']:
        return jsonify({'error': 'Account disabled'}), 403

    # Upgrade hash if Argon2 parameters have changed
    if rehash:
        conn = get_db()
        conn.execute("UPDATE users SET password_hash = ? WHERE id = ?",
                     (rehash, user_data['id']))
        conn.commit()

    # Generate a random 64-char token; store only the SHA-256 hash
    token = secrets.token_urlsafe(48)  # 48 bytes → 64 base64url chars
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    conn = get_db()
    conn.execute(
        "INSERT INTO api_tokens (user_id, token, name) VALUES (?, ?, 'Desktop Sync')",
        (user_data['id'], token_hash))
    conn.commit()

    return jsonify({'token': token, 'username': user_data['username']})


@app.route('/api/sync/unpair', methods=['POST'])
@csrf.exempt
@api_token_required
def api_sync_unpair():
    """Revoke the current API token."""
    conn = get_db()
    conn.execute("DELETE FROM api_tokens WHERE id = ?", (g.api_token_id,))
    conn.commit()
    return '', 204


@app.route('/api/sync/changes', methods=['GET'])
@csrf.exempt
@api_token_required
def api_sync_changes():
    """Return delta manifest of changes since the given timestamp."""
    since = request.args.get('since', '1970-01-01T00:00:00')
    try:
        datetime.fromisoformat(since)
    except (ValueError, TypeError):
        return jsonify({'error': 'Invalid since timestamp'}), 400
    uid = current_user.id
    conn = get_db()

    # Server's current time as the baseline for next sync
    server_time = conn.execute("SELECT datetime('now')").fetchone()[0]

    # Patterns updated since
    pattern_rows = conn.execute(
        """SELECT slug, name, updated_at, grid_w, grid_h, color_count,
                  project_status, brand, thumbnail, notes
           FROM saved_patterns WHERE user_id = ? AND updated_at > ?
           ORDER BY updated_at""",
        (uid, since)).fetchall()
    patterns_upserted = [dict(r) for r in pattern_rows]

    # Patterns deleted since
    deleted_patterns = conn.execute(
        "SELECT entity_key FROM sync_log WHERE user_id = ? AND entity_type = 'pattern' AND action = 'delete' AND timestamp > ?",
        (uid, since)).fetchall()
    patterns_deleted = [r['entity_key'] for r in deleted_patterns]

    # Thread statuses updated since
    thread_rows = conn.execute(
        """SELECT t.brand, t.number, u.status, u.notes, u.skein_qty, u.updated_at
           FROM user_thread_status u
           JOIN threads t ON t.id = u.thread_id
           WHERE u.user_id = ? AND u.updated_at > ?
           ORDER BY u.updated_at""",
        (uid, since)).fetchall()
    threads_upserted = [dict(r) for r in thread_rows]

    # Thread statuses deleted since (status reset to dont_own tracked in sync_log)
    deleted_threads = conn.execute(
        "SELECT entity_key FROM sync_log WHERE user_id = ? AND entity_type = 'thread_status' AND action = 'delete' AND timestamp > ?",
        (uid, since)).fetchall()
    threads_deleted = [r['entity_key'] for r in deleted_threads]

    return jsonify({
        'server_time': server_time,
        'patterns': {
            'upserted': patterns_upserted,
            'deleted': patterns_deleted,
        },
        'thread_statuses': {
            'upserted': threads_upserted,
            'deleted': threads_deleted,
        }
    })


@app.route('/api/sync/pattern/<slug>', methods=['GET'])
@csrf.exempt
@api_token_required
def api_sync_pattern_download(slug):
    """Download full pattern data for a single pattern."""
    uid = current_user.id
    conn = get_db()
    row = conn.execute(
        """SELECT slug, name, grid_w, grid_h, color_count, grid_data, legend_data,
                  thumbnail, created_at, updated_at, progress_data, project_status,
                  part_stitches_data, backstitches_data, knots_data, beads_data, brand, notes
           FROM saved_patterns WHERE slug = ? AND user_id = ?""",
        (slug, uid)).fetchone()
    if not row:
        return jsonify({'error': 'Pattern not found'}), 404
    result = dict(row)
    # Parse JSON fields back to objects for the client
    for field in ('grid_data', 'legend_data', 'part_stitches_data', 'backstitches_data', 'knots_data', 'beads_data'):
        if result.get(field):
            try:
                result[field] = json.loads(result[field])
            except (json.JSONDecodeError, TypeError):
                pass
    if result.get('progress_data'):
        try:
            result['progress_data'] = json.loads(result['progress_data'])
        except (json.JSONDecodeError, TypeError):
            pass
    return jsonify(result)


@app.route('/api/sync/push', methods=['POST'])
@csrf.exempt
@api_token_required
def api_sync_push():
    """Receive batch changes from desktop. Last-write-wins on updated_at."""
    data = request.get_json(silent=True) or {}
    uid = current_user.id
    conn = get_db()
    cursor = conn.cursor()
    stats = {'patterns_created': 0, 'patterns_updated': 0, 'patterns_skipped': 0,
             'patterns_deleted': 0, 'threads_created': 0, 'threads_updated': 0,
             'threads_skipped': 0, 'threads_deleted': 0}

    # --- Pattern upserts ---
    for p in data.get('patterns', {}).get('upsert', []):
        slug = p.get('slug')
        if not slug:
            continue
        pushed_at = p.get('updated_at', '')
        existing = cursor.execute(
            "SELECT id, updated_at FROM saved_patterns WHERE slug = ? AND user_id = ?",
            (slug, uid)).fetchone()
        if existing:
            # Last-write-wins: only update if pushed version is newer
            if pushed_at > (existing['updated_at'] or ''):
                grid_json = json.dumps(p['grid_data']) if isinstance(p.get('grid_data'), list) else p.get('grid_data', '[]')
                legend_json = json.dumps(p['legend_data']) if isinstance(p.get('legend_data'), list) else p.get('legend_data', '[]')
                ps_json, bs_json, kn_json, bd_json = _serialize_stitch_layers(p)
                progress_json = json.dumps(p['progress_data']) if isinstance(p.get('progress_data'), dict) else p.get('progress_data')
                cursor.execute(
                    """UPDATE saved_patterns SET name=?, grid_w=?, grid_h=?, color_count=?,
                              grid_data=?, legend_data=?, thumbnail=?, updated_at=?,
                              progress_data=?, project_status=?,
                              part_stitches_data=?, backstitches_data=?, knots_data=?, beads_data=?, brand=?
                       WHERE id=? AND user_id=?""",
                    (p.get('name', 'Untitled'), p.get('grid_w'), p.get('grid_h'), p.get('color_count', 0),
                     grid_json, legend_json, p.get('thumbnail'),
                     pushed_at, progress_json, p.get('project_status', 'not_started'),
                     ps_json, bs_json, kn_json, bd_json, p.get('brand', 'DMC'),
                     existing['id'], uid))
                stats['patterns_updated'] += 1
            else:
                stats['patterns_skipped'] += 1
        else:
            # New pattern — insert
            grid_json = json.dumps(p['grid_data']) if isinstance(p.get('grid_data'), list) else p.get('grid_data', '[]')
            legend_json = json.dumps(p['legend_data']) if isinstance(p.get('legend_data'), list) else p.get('legend_data', '[]')
            ps_json, bs_json, kn_json, bd_json = _serialize_stitch_layers(p)
            progress_json = json.dumps(p['progress_data']) if isinstance(p.get('progress_data'), dict) else p.get('progress_data')
            cursor.execute(
                """INSERT INTO saved_patterns
                       (slug, user_id, name, grid_w, grid_h, color_count, grid_data, legend_data,
                        thumbnail, created_at, updated_at, progress_data, project_status,
                        part_stitches_data, backstitches_data, knots_data, beads_data, brand)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (slug, uid, p.get('name', 'Untitled'), p.get('grid_w'), p.get('grid_h'),
                 p.get('color_count', 0), grid_json, legend_json, p.get('thumbnail'),
                 p.get('created_at', pushed_at), pushed_at, progress_json,
                 p.get('project_status', 'not_started'), ps_json, bs_json, kn_json, bd_json,
                 p.get('brand', 'DMC')))
            stats['patterns_created'] += 1

    # --- Pattern deletes ---
    for d in data.get('patterns', {}).get('delete', []):
        slug = d.get('slug')
        deleted_at = d.get('deleted_at', '')
        if not slug:
            continue
        existing = cursor.execute(
            "SELECT id, updated_at FROM saved_patterns WHERE slug = ? AND user_id = ?",
            (slug, uid)).fetchone()
        if existing and deleted_at > (existing['updated_at'] or ''):
            cursor.execute("DELETE FROM saved_patterns WHERE id = ? AND user_id = ?",
                           (existing['id'], uid))
            cursor.execute(
                "INSERT INTO sync_log (entity_type, entity_key, action, user_id) VALUES ('pattern', ?, 'delete', ?)",
                (slug, uid))
            stats['patterns_deleted'] += 1

    # --- Thread status upserts ---
    for ts in data.get('thread_statuses', {}).get('upsert', []):
        brand = ts.get('brand', 'DMC')
        number = ts.get('number', '')
        if not number:
            continue
        pushed_at = ts.get('updated_at', '')
        # Resolve (brand, number) → local thread_id
        thread_row = cursor.execute(
            "SELECT id FROM threads WHERE brand = ? AND number = ?",
            (brand, number)).fetchone()
        if not thread_row:
            continue
        tid = thread_row['id']
        existing = cursor.execute(
            "SELECT status, updated_at FROM user_thread_status WHERE user_id = ? AND thread_id = ?",
            (uid, tid)).fetchone()
        if existing:
            if pushed_at > (existing['updated_at'] or ''):
                cursor.execute(
                    "UPDATE user_thread_status SET status=?, notes=?, skein_qty=?, updated_at=? WHERE user_id=? AND thread_id=?",
                    (ts.get('status', 'dont_own'), ts.get('notes', ''), ts.get('skein_qty', 0),
                     pushed_at, uid, tid))
                stats['threads_updated'] += 1
            else:
                stats['threads_skipped'] += 1
        else:
            cursor.execute(
                "INSERT INTO user_thread_status (user_id, thread_id, status, notes, skein_qty, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                (uid, tid, ts.get('status', 'dont_own'), ts.get('notes', ''), ts.get('skein_qty', 0), pushed_at))
            stats['threads_created'] += 1

    # --- Thread status deletes ---
    for td in data.get('thread_statuses', {}).get('delete', []):
        key = td.get('key', '')
        deleted_at = td.get('deleted_at', '')
        if not key or ':' not in key:
            continue
        brand, number = key.split(':', 1)
        thread_row = cursor.execute(
            "SELECT id FROM threads WHERE brand = ? AND number = ?",
            (brand, number)).fetchone()
        if not thread_row:
            continue
        tid = thread_row['id']
        existing = cursor.execute(
            "SELECT updated_at FROM user_thread_status WHERE user_id = ? AND thread_id = ?",
            (uid, tid)).fetchone()
        if existing and deleted_at > (existing['updated_at'] or ''):
            cursor.execute(
                "DELETE FROM user_thread_status WHERE user_id = ? AND thread_id = ?",
                (uid, tid))
            cursor.execute(
                "INSERT INTO sync_log (entity_type, entity_key, action, user_id) VALUES ('thread_status', ?, 'delete', ?)",
                (key, uid))
            stats['threads_deleted'] += 1

    conn.commit()

    # Return server time for sync baseline
    server_time = conn.execute("SELECT datetime('now')").fetchone()[0]
    stats['server_time'] = server_time
    return jsonify(stats)


# ──────────────────────────────────────────────────────────────────────────────
# Desktop-only sync config endpoints (local Flask, DESKTOP_MODE only)
# ──────────────────────────────────────────────────────────────────────────────

def _sync_config_path():
    """Path to sync_config.json in the data directory."""
    return os.path.join(DATA_DIR, 'sync_config.json')


def _read_sync_config():
    """Read sync config from disk, return dict or empty dict."""
    path = _sync_config_path()
    if os.path.exists(path):
        try:
            with open(path) as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def _write_sync_config(cfg):
    """Write sync config to disk."""
    path = _sync_config_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        json.dump(cfg, f, indent=2)
    os.chmod(path, 0o600)


@app.route('/api/sync-config', methods=['GET'])
@login_required
def api_get_sync_config():
    """Return current sync config (desktop mode only)."""
    if not DESKTOP_MODE:
        return jsonify({'error': 'Only available in desktop mode'}), 403
    cfg = _read_sync_config()
    return jsonify({
        'server_url': cfg.get('server_url', ''),
        'username': cfg.get('username', ''),
        'paired': bool(cfg.get('token')),
        'last_sync_at': cfg.get('last_sync_at', ''),
    })


@app.route('/api/sync-config/pair', methods=['POST'])
@login_required
def api_sync_config_pair():
    """Pair desktop with remote server (desktop mode only)."""
    if not DESKTOP_MODE:
        return jsonify({'error': 'Only available in desktop mode'}), 403
    data = request.get_json(silent=True) or {}
    server_url = data.get('server_url', '').strip().rstrip('/')
    username = data.get('username', '').strip()
    password = data.get('password', '')

    if not server_url or not username or not password:
        return jsonify({'error': 'server_url, username, and password are required'}), 400

    # Validate URL format and enforce HTTPS (allow http for localhost only)
    from urllib.parse import urlparse
    parsed = urlparse(server_url)
    if parsed.scheme not in ('http', 'https') or not parsed.netloc:
        return jsonify({'error': 'Invalid server URL'}), 400
    if parsed.scheme == 'http' and parsed.hostname not in ('localhost', '127.0.0.1'):
        return jsonify({'error': 'HTTPS is required for remote servers'}), 400

    # Call remote server to get a token
    import requests as http_requests
    try:
        resp = http_requests.post(
            f"{server_url}/api/sync/pair",
            json={'username': username, 'password': password},
            timeout=15)
    except http_requests.ConnectionError:
        return jsonify({'error': 'Could not connect to remote server'}), 502
    except http_requests.Timeout:
        return jsonify({'error': 'Connection timed out'}), 504

    if resp.status_code != 200:
        err = resp.json().get('error', 'Pairing failed') if resp.headers.get('content-type', '').startswith('application/json') else 'Pairing failed'
        return jsonify({'error': err}), resp.status_code

    result = resp.json()
    cfg = {
        'server_url': server_url,
        'username': result.get('username', username),
        'token': result['token'],
        'last_sync_at': '',
    }
    _write_sync_config(cfg)
    return jsonify({'ok': True, 'username': cfg['username']})


@app.route('/api/sync-config/unpair', methods=['POST'])
@login_required
def api_sync_config_unpair():
    """Unpair desktop from remote server (desktop mode only)."""
    if not DESKTOP_MODE:
        return jsonify({'error': 'Only available in desktop mode'}), 403
    cfg = _read_sync_config()
    if cfg.get('token') and cfg.get('server_url'):
        # Try to revoke token on remote server
        import requests as http_requests
        try:
            http_requests.post(
                f"{cfg['server_url']}/api/sync/unpair",
                headers={'Authorization': f"Bearer {cfg['token']}"},
                timeout=10)
        except Exception:
            pass  # Best-effort revocation
    _write_sync_config({})
    return jsonify({'ok': True})


@app.route('/api/sync-config/sync', methods=['POST'])
@login_required
def api_sync_config_trigger():
    """Trigger a sync (desktop mode only)."""
    if not DESKTOP_MODE:
        return jsonify({'error': 'Only available in desktop mode'}), 403
    cfg = _read_sync_config()
    if not cfg.get('token') or not cfg.get('server_url'):
        return jsonify({'error': 'Not paired with a server'}), 400

    from sync_engine import SyncEngine
    engine = SyncEngine(cfg['server_url'], cfg['token'], DB_PATH)
    result = engine.sync(cfg.get('last_sync_at', ''), current_user.id)

    if result.get('error'):
        return jsonify({'error': result['error']}), 502

    # Update last_sync_at
    cfg['last_sync_at'] = result.get('server_time', '')
    _write_sync_config(cfg)
    return jsonify(result)


def _migrate_pattern_symbols():
    """Re-assign symbols in all saved patterns using the current _PATTERN_SYMBOLS set.
    Skips the migration if already up to date (checked via app_settings sentinel)."""
    conn = _get_db_direct()
    conn.execute(
        "CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT)"
    )
    row = conn.execute(
        "SELECT value FROM app_settings WHERE key = 'symbols_version'"
    ).fetchone()
    if row and row[0] == _SYMBOLS_VERSION:
        conn.close()
        return
    rows = conn.execute(
        'SELECT id, legend_data FROM saved_patterns WHERE legend_data IS NOT NULL'
    ).fetchall()
    for row in rows:
        try:
            legend = json.loads(row['legend_data'])
            for i, entry in enumerate(legend):
                entry['symbol'] = _PATTERN_SYMBOLS[i % len(_PATTERN_SYMBOLS)]
            conn.execute(
                'UPDATE saved_patterns SET legend_data = ? WHERE id = ?',
                (json.dumps(legend), row['id'])
            )
        except (json.JSONDecodeError, TypeError):
            pass
    conn.execute(
        "INSERT OR REPLACE INTO app_settings(key, value) VALUES('symbols_version', ?)",
        (_SYMBOLS_VERSION,)
    )
    conn.commit()
    conn.close()


def _migrate_patterns_brand():
    """Add brand column to saved_patterns if missing."""
    conn = _get_db_direct()
    cols = [r[1] for r in conn.execute("PRAGMA table_info(saved_patterns)").fetchall()]
    if 'brand' not in cols:
        conn.execute("ALTER TABLE saved_patterns ADD COLUMN brand TEXT NOT NULL DEFAULT 'DMC'")
        conn.commit()
    conn.close()


def _migrate_user_thread_status():
    """Create user_thread_status table for per-user inventory isolation.

    Migrates any existing per-thread status/notes/skein_qty from the shared
    threads table into the new per-user table for every existing user.
    """
    conn = _get_db_direct()
    tables = [r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
    if 'user_thread_status' in tables:
        conn.close()
        return

    app.logger.info("Creating user_thread_status table for per-user inventory isolation")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS user_thread_status (
            user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
            status    TEXT DEFAULT 'dont_own',
            notes     TEXT DEFAULT '',
            skein_qty REAL DEFAULT 0,
            PRIMARY KEY (user_id, thread_id)
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_uts_user ON user_thread_status(user_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_uts_status ON user_thread_status(user_id, status)")

    # Migrate existing thread status/notes/skein_qty into per-user table
    # for all existing users (only rows that differ from defaults)
    user_ids = [r[0] for r in conn.execute("SELECT id FROM users").fetchall()]
    changed = conn.execute(
        "SELECT id, status, notes, skein_qty FROM threads "
        "WHERE status != 'dont_own' OR notes != '' OR skein_qty != 0"
    ).fetchall()
    if user_ids and changed:
        for uid in user_ids:
            for row in changed:
                conn.execute(
                    "INSERT OR IGNORE INTO user_thread_status "
                    "(user_id, thread_id, status, notes, skein_qty) VALUES (?, ?, ?, ?, ?)",
                    (uid, row[0], row[1], row[2], row[3])
                )
        app.logger.info(f"Migrated {len(changed)} thread statuses for {len(user_ids)} user(s)")
    conn.commit()
    conn.close()


def _migrate_sync_tables():
    """Create api_tokens, sync_log tables and add updated_at to user_thread_status."""
    conn = _get_db_direct()
    tables = [r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'").fetchall()]

    if 'api_tokens' not in tables:
        app.logger.info("Creating api_tokens table for sync authentication")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS api_tokens (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                token TEXT UNIQUE NOT NULL,
                name TEXT DEFAULT 'Desktop Sync',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_used_at TIMESTAMP
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_api_tokens_token ON api_tokens(token)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id)")

    if 'sync_log' not in tables:
        app.logger.info("Creating sync_log table for sync delete tracking")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS sync_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                entity_type TEXT NOT NULL,
                entity_key TEXT NOT NULL,
                action TEXT NOT NULL,
                user_id INTEGER NOT NULL,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_sync_log_user_ts ON sync_log(user_id, timestamp)")

    # Add updated_at to user_thread_status if missing
    if 'user_thread_status' in tables:
        cols = [r[1] for r in conn.execute("PRAGMA table_info(user_thread_status)").fetchall()]
        if 'updated_at' not in cols:
            app.logger.info("Adding updated_at column to user_thread_status")
            conn.execute("ALTER TABLE user_thread_status ADD COLUMN updated_at TIMESTAMP")
            conn.execute("UPDATE user_thread_status SET updated_at = CURRENT_TIMESTAMP WHERE updated_at IS NULL")

    conn.commit()
    conn.close()


# Desktop mode: auto-initialize database if it doesn't exist
if DESKTOP_MODE and not os.path.exists(DB_PATH):
    os.makedirs(DATA_DIR, exist_ok=True)
    from init_db import init_database_if_needed
    schema = os.path.join(_BUNDLE_DIR, 'schema.sql')
    if init_database_if_needed(DB_PATH, schema_path=schema):
        logging.info("Desktop mode: initialized database at %s", DB_PATH)

# Build thread palette in LAB space at import time (requires DB to exist)
if os.path.exists(DB_PATH):
    with app.app_context():
        _ensure_saved_patterns_table()
        _ensure_threads_columns()
        _cleanup_orphaned_images()
        _migrate_patterns_brand()
        _migrate_user_thread_status()
        _migrate_sync_tables()
        _migrate_pattern_symbols()
        _migrate_user_preferences()
        _build_palette_lab()

    # Desktop mode: ensure a local user exists for auto-login
    if DESKTOP_MODE:
        _desktop_user_id = _ensure_desktop_user()


if __name__ == '__main__':
    if not os.path.exists(DB_PATH):
        print("Database not found. Please run 'python init_db.py' first.")
        sys.exit(1)

    port = int(os.environ.get('PORT', 6969))
    mode = " (desktop mode)" if DESKTOP_MODE else ""
    print(f"Starting Needlework Studio server{mode}...")
    print(f"Open http://localhost:{port} in your browser")
    app.run(host='0.0.0.0', port=port,
            debug=os.environ.get('FLASK_DEBUG', '').lower() in ('1', 'true'))
