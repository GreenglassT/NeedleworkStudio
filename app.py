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
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

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
from PIL import Image, ImageChops, ImageEnhance, ImageDraw
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
# Demo mode — set DEMO_MODE=1 to disable PWA install prompts
DEMO_MODE = os.environ.get('DEMO_MODE', '').lower() in ('1', 'true')

# Admin bootstrap — set ADMIN_USERNAME to grant admin on startup
ADMIN_USERNAME = os.environ.get('ADMIN_USERNAME', '').strip()

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

    def __init__(self, id, username, email, is_active=True, is_admin=False):
        self.id = id
        self.username = username
        self.email = email
        self._is_active = is_active
        self._is_admin = is_admin

    @property
    def is_active(self):
        return self._is_active

    @property
    def is_admin(self):
        return self._is_admin

    @staticmethod
    def get_by_id(user_id):
        """Retrieve user by ID."""
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("SELECT id, username, email, is_active, is_admin FROM users WHERE id = ?", (user_id,))
        row = cursor.fetchone()

        if row:
            return User(row['id'], row['username'], row['email'],
                        bool(row['is_active']), bool(row['is_admin']))
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
def _inject_demo_mode():
    return dict(demo_mode=DEMO_MODE)


@app.context_processor
def _inject_user_prefs():
    if current_user.is_authenticated:
        return dict(user_prefs=_get_user_prefs(current_user.id))
    return dict(user_prefs={})


@app.context_processor
def _inject_admin_status():
    if current_user.is_authenticated:
        return dict(current_user_is_admin=current_user.is_admin)
    return dict(current_user_is_admin=False)


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


def admin_required(f):
    """Decorator: requires login and is_admin=1."""
    @wraps(f)
    def decorated(*args, **kwargs):
        if not current_user.is_authenticated:
            if request.is_json or request.headers.get('X-Requested-With') == 'fetch':
                return jsonify({'error': 'Authentication required'}), 401
            return redirect(url_for('login', next=request.path))
        conn = get_db()
        row = conn.execute("SELECT is_admin FROM users WHERE id = ?",
                           (current_user.id,)).fetchone()
        if not row or not row['is_admin']:
            if request.is_json or request.headers.get('X-Requested-With') == 'fetch':
                return jsonify({'error': 'Admin access required'}), 403
            return redirect(url_for('home'))
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
    if 'total_stitches' not in existing:
        conn.execute("ALTER TABLE saved_patterns ADD COLUMN total_stitches INTEGER NOT NULL DEFAULT 0")
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


def _migrate_admin_column():
    """Add is_admin column to users table; mark all existing users as admin."""
    conn = _get_db_direct()
    cols = {r['name'] for r in conn.execute("PRAGMA table_info(users)").fetchall()}
    if 'is_admin' not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0")
        conn.execute("UPDATE users SET is_admin = 1")
        conn.commit()
        app.logger.info("Added is_admin column; marked all existing users as admin")
    conn.close()


def _bootstrap_admin_from_env():
    """If ADMIN_USERNAME env var is set, ensure that user has is_admin=1."""
    if not ADMIN_USERNAME:
        return
    conn = _get_db_direct()
    row = conn.execute("SELECT id FROM users WHERE username = ?",
                       (ADMIN_USERNAME,)).fetchone()
    if row:
        conn.execute("UPDATE users SET is_admin = 1 WHERE id = ?", (row['id'],))
        conn.commit()
        app.logger.info("Admin bootstrap: granted admin to '%s'", ADMIN_USERNAME)
    else:
        app.logger.error(
            "ADMIN_USERNAME='%s' is set but no user with that name exists. "
            "Create the user first: python manage_users.py create",
            ADMIN_USERNAME)
    conn.close()


def _pdf_normalize_line(text):
    """Replace tabs/pipes with spaces, collapse runs, strip."""
    s = re.sub(r'[\t|]+', ' ', text)
    return re.sub(r'\s{2,}', ' ', s).strip()


def _pdf_is_likely_page_number(n, x_pct, y_pct):
    """Return True if integer n at (x_pct, y_pct) looks like a page number."""
    if n >= 20:
        return False
    if x_pct > 0.60 and y_pct < 0.15:
        return True
    if y_pct > 0.92:
        return True
    return False


# Pre-compiled dimension patterns for cover page parsing (most specific → generic)
_PDF_DIM_PATTERNS = [re.compile(p) for p in [
    r'[Dd]esign\s+size\s*:\s*(\d+)\s*[×xX]\s*(\d+)',
    r'[Ss]ize\s*:\s*(\d+)\s*[×xX]\s*(\d+)',
    r'[Dd]imensions?\s*:\s*(\d+)\s*[×xX]\s*(\d+)',
    r'(\d+)\s*[wW]\s*[×xX]\s*(\d+)\s*[hH]',
    r'[Ww]idth\s*:\s*(\d+).*?[Hh]eight\s*:\s*(\d+)',
    r'(\d+)\s*[×xX]\s*(\d+)\s*stitch',
    r'(\d+)\s*stitch(?:es)?\s*wide.*?(\d+)\s*stitch(?:es)?\s*(?:high|tall)',
    r'\b(\d{2,})\s*[×xX]\s*(\d{2,})\b',
]]


def _pdf_parse_cover(page):
    """Return (grid_w, grid_h, title) from cover page text.

    Tries multiple dimension patterns used by common cross-stitch generators:
      - "Design size: 100×100"       (common format)
      - "Size: 100 x 100 stitches"   (common format)
      - "100w x 100h"                (common format)
      - "Width: 100  Height: 100"    (various)
      - "Dimensions: 100 x 100"      (various)
      - "100 x 100 stitches"         (generic)
      - "100×100" / "100x100"        (bare dimensions)
    Returns (0, 0, title) if no dimensions found (caller can infer from grid).
    """
    text = page.extract_text() or ''
    lines = [l.strip() for l in text.split('\n') if l.strip()]
    title = lines[0] if lines else 'Imported Pattern'

    full_text = text.replace('\n', ' ')  # for multi-line "Width/Height" pattern
    for pat in _PDF_DIM_PATTERNS:
        m = pat.search(full_text)
        if m:
            w, h = int(m.group(1)), int(m.group(2))
            if 1 <= w <= 10000 and 1 <= h <= 10000:
                return w, h, title

    # No dimensions found — return zeros so caller can try inference
    return 0, 0, title


def _pdf_parse_legend(page):
    """Return list of {dmc, brand, name, legend_count} from legend page text.

    Tries multiple legend formats in order of specificity:
      1. Brand-prefixed: "DMC 310 Black 245", "Anchor 1 White 245"
      2. Flexible brand: "DMC-310 Black 245", "DMC#310", "#310 (DMC)"
      3. Pipe/tab tables: "310 | Black | 245", "+ | DMC 310 | Black | 245"
    """
    text = page.extract_text() or ''
    entries = []
    seen = set()

    # Normalize pipes/tabs to spaces for uniform matching, keep original too
    for line in text.split('\n'):
        stripped = line.strip()
        if not stripped:
            continue
        norm = _pdf_normalize_line(stripped)

        brand = number = name = count = None

        # --- Pattern 1: "DMC 310 Black 245" (standard, anywhere in line) ---
        # Number: digits optionally prefixed by letter (B5200, E310), or names (Blanc, White, Ecru)
        m = re.search(r'DMC[\s\-#.:]*([A-Za-z]?\d+\w*|Blanc|White|Ecru)\s+([\w\s\-\.\/]+?)\s+([\d,]+)\s*$',
                      norm, re.IGNORECASE)
        if m:
            brand, number = 'DMC', m.group(1).strip()
            name, count = m.group(2).strip(), int(m.group(3).replace(',', ''))

        # --- Pattern 2: "Anchor 1 White 245" / "ANC 1 White 245" ---
        if not brand:
            m = re.search(r'(?:Anchor|ANC)[\s\-#.:]*(\d+)\s+([\w\s\-\.\/]+?)\s+([\d,]+)\s*$',
                          norm, re.IGNORECASE)
            if m:
                brand, number = 'Anchor', m.group(1).strip()
                name, count = m.group(2).strip(), int(m.group(3).replace(',', ''))

        # --- Pattern 3: Number with "(DMC)" or "(Anchor)" suffix ---
        if not brand:
            m = re.search(r'(\S+)\s*\(\s*(DMC|Anchor|ANC)\s*\)\s+([\w\s\-\.\/]+?)\s+([\d,]+)\s*$',
                          norm, re.IGNORECASE)
            if m:
                number = m.group(1).strip()
                b = m.group(2).strip()
                brand = 'Anchor' if b.upper() == 'ANC' else ('DMC' if b.upper() == 'DMC' else b.capitalize())
                name, count = m.group(3).strip(), int(m.group(4).replace(',', ''))

        # --- Pattern 4: "DMC 350 - Medium Coral" (no stitch count) ---
        if not brand:
            m = re.search(r'DMC[\s\-#.:]*([A-Za-z]?\d+\w*|Blanc|White|Ecru)\s*[\-–—]\s*([\w\s\.\/]+)',
                          norm, re.IGNORECASE)
            if m:
                brand, number = 'DMC', m.group(1).strip()
                name, count = m.group(2).strip(), 0
        if not brand:
            m = re.search(r'(?:Anchor|ANC)[\s\-#.:]*(\d+)\s*[\-–—]\s*([\w\s\.\/]+)',
                          norm, re.IGNORECASE)
            if m:
                brand, number = 'Anchor', m.group(1).strip()
                name, count = m.group(2).strip(), 0

        if brand and number and count is not None:
            key = f'{brand}:{number}'
            if key not in seen:
                entries.append({'dmc': number, 'brand': brand,
                                'name': name, 'legend_count': count})
                seen.add(key)

    return entries


def _pdf_parse_legend_bare(page, known_threads=None):
    """Fallback legend parser for formats without any brand prefix.

    Matches lines like: ``310 Black 245`` or ``+ 310 Black 245``
    where the number is a known thread number in the database.
    Checks both DMC and Anchor; prefers DMC when a number exists in both.
    Requires >= 3 matches to avoid false positives from random text.
    Returns list of {dmc, brand, name, legend_count} or empty list.
    """
    text = page.extract_text() or ''
    if not text.strip():
        return []

    # Load known thread numbers from the database for validation
    if known_threads is None:
        db = get_db()
        rows = db.execute("SELECT DISTINCT brand, number FROM threads").fetchall()
        known_threads = {}  # number → brand (DMC wins ties)
        for r in rows:
            num, brand = r['number'], r['brand']
            if num not in known_threads or brand == 'DMC':
                known_threads[num] = brand
    known_lower = {n.lower(): (n, b) for n, b in known_threads.items()}

    entries = []
    seen = set()
    for line in text.split('\n'):
        stripped = line.strip()
        if not stripped:
            continue
        norm = _pdf_normalize_line(stripped)

        # Match: optional_symbol(1 char) + thread_number + color_name + stitch_count
        # Thread number can be: digits (310), letter+digits (B5200, E310), or names (Blanc)
        m = re.match(
            r'^(?:\S\s+)?'                   # optional single-char symbol
            r'([A-Za-z]?\d{1,4}|[Bb]lanc|[Ww]hite|[Ee]cru)\s+'  # thread number
            r'([\w\s\-\.\/]+?)\s+'           # color name
            r'([\d,]+)\s*$',                 # stitch count
            norm
        )
        if not m:
            continue
        number = m.group(1).strip()
        name = m.group(2).strip()
        count_str = m.group(3).replace(',', '')

        # Validate against known thread numbers (DMC + Anchor)
        if number in known_threads:
            brand = known_threads[number]
        elif number.lower() in known_lower:
            number, brand = known_lower[number.lower()]
        else:
            continue
        # Skip if name looks like a page header/footer
        if len(name) < 2 or name.isdigit():
            continue

        count = int(count_str)
        if number not in seen:
            entries.append({'dmc': number, 'brand': brand,
                            'name': name, 'legend_count': count})
            seen.add(number)

    # Only return results if enough entries found (avoids false positives)
    return entries if len(entries) >= 3 else []


def _pdf_split_legend_columns(page):
    """Split a page into left/right text columns using char x-positions.

    Returns a list of column line-lists, or None if no multi-column layout
    detected.  Each line is a string reconstructed from char positions with
    gap-based space insertion.  Automatically skips the top 18% of the page
    (header area) when detecting the column gap.
    """
    # Skip header area (top 18% of page) to avoid full-width header text
    # filling the column gap
    y_min = float(page.height) * 0.18
    chars = [c for c in page.chars if c['top'] > y_min]
    if len(chars) < 80:
        return None

    pw = float(page.width)
    # Find the largest x-gap near the page center
    x_positions = sorted(set(int(c['x0']) for c in chars))
    if len(x_positions) < 10:
        return None

    best_gap, split_x = 0, None
    for i in range(len(x_positions) - 1):
        gap = x_positions[i + 1] - x_positions[i]
        mid = (x_positions[i] + x_positions[i + 1]) / 2
        if gap > best_gap and 0.3 * pw < mid < 0.7 * pw:
            best_gap = gap
            split_x = mid

    if best_gap < 25:
        return None

    def _chars_to_lines(chars_subset):
        rows = defaultdict(list)
        for c in chars_subset:
            y_key = round(c['top'] / 3) * 3
            rows[y_key].append(c)
        lines = []
        for y_key in sorted(rows.keys()):
            row_chars = sorted(rows[y_key], key=lambda c: c['x0'])
            parts = []
            for j, c in enumerate(row_chars):
                if j > 0:
                    gap = c['x0'] - row_chars[j - 1].get('x1', row_chars[j - 1]['x0'] + 6)
                    if gap > 2:
                        parts.append(' ')
                parts.append(c['text'])
            text = ''.join(parts).strip()
            if text:
                lines.append(text)
        return lines

    left = [c for c in chars if c['x0'] < split_x]
    right = [c for c in chars if c['x0'] >= split_x]
    left_lines = _chars_to_lines(left)
    right_lines = _chars_to_lines(right)

    if len(left_lines) < 5 or len(right_lines) < 5:
        return None
    return [left_lines, right_lines]


def _pdf_parse_legend_tabular(page_index_pairs):
    """Parse tabular legend: (symbol) skeins stitches color_code name.

    Handles both single-column and two-column layouts.  For two-column pages,
    uses char x-positions to split columns and parses each independently.
    Tries every supplied page and keeps any with >= 5 matching entries.

    Args:
        page_index_pairs: list of (page_idx, page_object) tuples

    Returns (entries, legend_page_indices) where entries is a list of
    {dmc, brand, name, legend_count[, symbol]} and legend_page_indices is a
    set of page indices that contained legend data.
    """
    entries = []
    seen = set()
    legend_pages = set()

    _DMC_CODES = r'B5200|BLANC|Blanc|Ecru|White|\d{1,4}'

    # Single-line entry regex (for use on split-column lines)
    _LINE_RE = re.compile(
        r'^(\S)?\s*'                     # optional symbol
        r'(\d{1,2})\s+'                  # skeins
        r'(\d+)\s+'                      # stitches
        r'(' + _DMC_CODES + r')\b'       # DMC code (word boundary)
        r'\s*(.*?)$',                     # color name
    )

    # Fallback: original multi-match regex for flat text (no column split)
    _FLAT_RE = re.compile(
        r'(?<!\d)(\d)\s+'
        r'(\d+)\s+'
        r'(' + _DMC_CODES + r')\s+'
        r'([A-Z][\w\s\-\.]*?)'
        r'(?=\s+\S\s+\d{1,2}\s+\d+\s+(?:' + _DMC_CODES + r')|\s*$)',
    )

    for page_idx, page in page_index_pairs:
        page_entries = []
        page_seen = set()

        # Detect brand from page text (look for "Anchor" near legend area)
        _page_text = (page.extract_text() or '').upper()
        _page_brand = 'Anchor' if 'ANCHOR' in _page_text and 'DMC' not in _page_text else 'DMC'

        # Try char-position column split first
        columns = _pdf_split_legend_columns(page)
        if columns:
            for col_lines in columns:
                for line in col_lines:
                    # Fix merged code+name from tight char spacing
                    # e.g. "BLANCWhite" → "BLANC White"
                    cleaned = re.sub(
                        r'(BLANC|B5200|Ecru)(?=[A-Z][a-z])', r'\1 ', line
                    )
                    m = _LINE_RE.match(cleaned.strip())
                    if not m:
                        continue
                    symbol = m.group(1) or ''
                    skeins = int(m.group(2))
                    count = int(m.group(3))
                    code = m.group(4).strip()
                    name = m.group(5).strip()

                    # Handle merged code+name (e.g. BLANCWhite)
                    for prefix in ('BLANC', 'Blanc', 'Ecru', 'White', 'B5200'):
                        if code == prefix:
                            break
                        if code.startswith(prefix):
                            name = code[len(prefix):] + (' ' + name if name else '')
                            code = prefix
                            break

                    if skeins > 9 or count < 1:
                        continue
                    if len(name) < 2 and code not in ('BLANC', 'Blanc', 'Ecru', 'White', 'B5200'):
                        continue

                    if code not in page_seen:
                        entry = {'dmc': code, 'brand': _page_brand,
                                 'name': name, 'legend_count': count,
                                 'symbol': symbol}
                        page_entries.append(entry)
                        page_seen.add(code)
        else:
            # Fallback: scan flat text with multi-match regex
            text = page.extract_text() or ''
            for line in text.split('\n'):
                for m in _FLAT_RE.finditer(line):
                    skeins = int(m.group(1))
                    count = int(m.group(2))
                    code = m.group(3).strip()
                    name = m.group(4).strip()
                    if skeins > 9 or count < 1 or len(name) < 2:
                        continue
                    if code not in page_seen:
                        page_entries.append({'dmc': code, 'brand': _page_brand,
                                             'name': name, 'legend_count': count,
                                             'symbol': ''})
                        page_seen.add(code)

        if len(page_entries) >= 5:
            legend_pages.add(page_idx)
            for e in page_entries:
                if e['dmc'] not in seen:
                    entries.append(e)
                    seen.add(e['dmc'])

    return entries, legend_pages


def _pdf_parse_legend_vector(page):
    """Parse Needlework Studio vector PDF legend format.

    Expects lines like: ``+ 871 Antique Violet Med 2 1,247``
    with a header row containing "Symbol" and "Number".
    Returns list of {dmc, brand, name, symbol, legend_count} or empty list.
    """
    text = page.extract_text() or ''
    lines = text.split('\n')

    # Detect our legend format by header
    header_idx = -1
    for i, line in enumerate(lines):
        if 'Symbol' in line and 'Number' in line:
            header_idx = i
            break
    if header_idx < 0:
        return []

    # Detect brand from page text
    _upper = text.upper()
    brand = 'Anchor' if 'ANCHOR' in _upper and 'DMC' not in _upper else 'DMC'

    entries = []
    seen = set()
    for line in lines[header_idx + 1:]:
        stripped = line.strip()
        if not stripped:
            continue
        # Match: symbol(1+ chars)  number  name(words)  strands(digit)  count(with commas)
        m = re.match(r'^(\S+)\s+(\d+)\s+(.+?)\s+(\d+)\s+([\d,]+)\s*$', stripped)
        if not m:
            continue
        symbol = m.group(1)
        number = m.group(2)
        name = m.group(3).strip()
        count = int(m.group(5).replace(',', ''))
        if number not in seen:
            entries.append({
                'dmc': number, 'brand': brand, 'name': name,
                'symbol': symbol, 'legend_count': count,
            })
            seen.add(number)
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


def _import_pdf_text_grid(plumber_pdf, grid_w, grid_h, legend_entries, chart_page_indices, title='Imported Pattern'):
    """Import a vector PDF chart using text positions instead of images.

    Extracts single-character symbols from chart pages, detects the regular
    grid spacing, and maps symbols to DMC numbers via the legend.
    Supports two modes:
      - Direct mapping: legend entries have 'symbol' keys
      - Count-based matching: legend entries lack symbols
    Returns the same dict format as _import_pdf_body.
    """
    has_symbols = all('symbol' in e for e in legend_entries)

    if has_symbols:
        # Only map entries that have a non-empty symbol
        sym_to_dmc = {e['symbol']: e['dmc'] for e in legend_entries if e.get('symbol')}
        valid_syms = set(sym_to_dmc.keys())
    else:
        sym_to_dmc = None
        valid_syms = None  # will collect all single-char non-digit symbols

    # Collect all symbol characters from chart pages.
    # Use page.chars instead of extract_words() because pdfplumber merges
    # adjacent identical symbols into multi-char words (e.g. "%%%%...").
    #
    # When the grid uses a custom/icon font (e.g. IcoMoon), detect it and
    # filter to only that font — this excludes header/footer text in
    # standard fonts (Helvetica, Times-Roman, etc.) that would pollute
    # the grid coordinate detection.
    all_syms = []  # (center_x, center_y, symbol, page_idx)

    # First pass: collect candidate symbols AND track font usage
    candidates = []  # (cx, cy, symbol, page_idx, fontname)
    font_counter = Counter()
    for page_idx in chart_page_indices:
        page = plumber_pdf.pages[page_idx]
        for ch in page.chars:
            t = ch['text']
            if len(t) != 1:
                continue
            if valid_syms is not None:
                if t not in valid_syms:
                    continue
            else:
                if t.isdigit() or t.isspace() or t in ('.', ',', '-', '(', ')', '/'):
                    continue
            cx = (ch['x0'] + ch['x1']) / 2
            cy = (ch['top'] + ch['bottom']) / 2
            fn = ch.get('fontname', '')
            candidates.append((cx, cy, t, page_idx, fn))
            font_counter[fn] += 1

    # If one font dominates (>80% of symbol chars), it's the grid font —
    # filter out chars from other fonts (header/footer text).
    if candidates and font_counter:
        top_font, top_count = font_counter.most_common(1)[0]
        if top_count > 0.80 * len(candidates):
            all_syms = [(cx, cy, s, pi) for cx, cy, s, pi, fn in candidates if fn == top_font]
            app.logger.info(
                "PDF import: grid font '%s' (%d chars), filtered %d non-grid chars",
                top_font[:40], len(all_syms), len(candidates) - len(all_syms),
            )
        else:
            all_syms = [(cx, cy, s, pi) for cx, cy, s, pi, fn in candidates]
    else:
        all_syms = [(cx, cy, s, pi) for cx, cy, s, pi, fn in candidates]

    if not all_syms:
        raise ValueError(
            "No chart symbols found on any page. "
            "This PDF may use images or colored rectangles instead of text symbols."
        )

    # Reject footer/header text masquerading as grid symbols.
    # Real grid symbols spread across many y-positions (one per row);
    # footer text clusters in 1-2 lines per page → very few unique y values.
    unique_ys = len(set(round(cy, 0) for _, cy, _, _ in all_syms))
    sym_per_page = len(all_syms) / max(1, len(chart_page_indices))
    if unique_ys < 5 and sym_per_page < 100:
        raise ValueError(
            f"Only {unique_ys} unique y-positions for {len(all_syms)} symbols "
            f"across {len(chart_page_indices)} pages — likely footer text, not grid"
        )

    # Detect cell pitch from the most common spacing between adjacent symbols
    xs_by_page = {}
    ys_by_page = {}
    for cx, cy, _s, pi in all_syms:
        xs_by_page.setdefault(pi, []).append(cx)
        ys_by_page.setdefault(pi, []).append(cy)

    x_spacings = []
    y_spacings = []
    for pi in xs_by_page:
        sxs = sorted(set(round(x, 1) for x in xs_by_page[pi]))
        sys_ = sorted(set(round(y, 1) for y in ys_by_page[pi]))
        x_spacings.extend(round(sxs[i+1] - sxs[i], 1) for i in range(min(20, len(sxs)-1)))
        y_spacings.extend(round(sys_[i+1] - sys_[i], 1) for i in range(min(20, len(sys_)-1)))

    if not x_spacings or not y_spacings:
        raise ValueError(
            "Cannot detect grid spacing from chart pages. "
            "The chart symbols may be too sparse or irregularly spaced."
        )

    cell_pitch = Counter(x_spacings).most_common(1)[0][0]
    if cell_pitch < 1:
        raise ValueError(f"Detected cell pitch too small: {cell_pitch}pt")

    # For each chart page, find grid origin (row label numbers tell us the offset)
    # Extract row/column labels to determine absolute positions
    page_origins = {}  # page_idx → (col_offset, row_offset)

    for page_idx in chart_page_indices:
        page = plumber_pdf.pages[page_idx]
        words = page.extract_words()

        # Find the bounding box of symbol-only words on this page
        page_syms = [(cx, cy) for cx, cy, _s, pi in all_syms if pi == page_idx]
        if not page_syms:
            continue
        sym_min_x = min(x for x, _ in page_syms)
        sym_min_y = min(y for _, y in page_syms)

        # Look for column labels (numbers above the chart area)
        # and row labels (numbers left of the chart area)
        pw, ph = float(page.width), float(page.height)
        col_labels = []
        row_labels = []
        for w in words:
            try:
                n = int(w['text'])
            except ValueError:
                continue
            wcx = (w['x0'] + w['x1']) / 2
            wcy = (w['top'] + w['bottom']) / 2
            # Skip likely page numbers (e.g. "1" "2" from "Chart 1 / 2")
            if _pdf_is_likely_page_number(n, wcx / pw, wcy / ph):
                continue
            # Column label: above chart, aligned with a symbol column
            if wcy < sym_min_y - cell_pitch * 0.3 and 0 <= n <= grid_w:
                col_rank = round((wcx - sym_min_x) / cell_pitch)
                if col_rank >= 0:
                    col_labels.append(n - col_rank)
            # Row label: left of chart, aligned with a symbol row
            if wcx < sym_min_x - cell_pitch * 0.3 and 0 <= n <= grid_h:
                row_rank = round((wcy - sym_min_y) / cell_pitch)
                if row_rank >= 0:
                    row_labels.append(n - row_rank)

        # Filter out clearly invalid offsets (must be positive for 1-indexed grids)
        col_labels = [v for v in col_labels if v > 0]
        row_labels = [v for v in row_labels if v > 0]
        col_off = Counter(col_labels).most_common(1)[0][0] if col_labels else 0
        row_off = Counter(row_labels).most_common(1)[0][0] if row_labels else 0
        page_origins[page_idx] = (col_off, row_off, sym_min_x, sym_min_y)
        app.logger.info(
            "PDF import: page %d origin col_off=%d row_off=%d "
            "(col_labels=%s, row_labels=%s)",
            page_idx + 1, col_off, row_off,
            Counter(col_labels).most_common(3),
            Counter(row_labels).most_common(3),
        )

    # Cross-page row offset consistency: all chart pages should share the
    # same row_off. If a majority agree, override outliers.
    if len(page_origins) > 1:
        all_row_offs = [v[1] for v in page_origins.values()]
        row_consensus = Counter(all_row_offs).most_common(1)[0]
        if row_consensus[1] > len(all_row_offs) // 2:
            for pi in page_origins:
                co, ro, ox, oy = page_origins[pi]
                if ro != row_consensus[0]:
                    app.logger.info(
                        "PDF import: correcting page %d row_off %d → %d (consensus)",
                        pi + 1, ro, row_consensus[0],
                    )
                    page_origins[pi] = (co, row_consensus[0], ox, oy)

    # Build grid — first pass places symbols, then resolves to DMC numbers
    result = ['BG'] * (grid_w * grid_h)
    placed = 0
    for cx, cy, sym, page_idx in all_syms:
        if page_idx not in page_origins:
            continue
        col_off, row_off, origin_x, origin_y = page_origins[page_idx]
        col = col_off + round((cx - origin_x) / cell_pitch)
        row = row_off + round((cy - origin_y) / cell_pitch)
        if 0 <= col < grid_w and 0 <= row < grid_h:
            if sym_to_dmc is not None:
                dmc = sym_to_dmc.get(sym)
                if dmc:
                    result[row * grid_w + col] = dmc
                    placed += 1
            else:
                # Count-based mode: place symbol char as placeholder
                result[row * grid_w + col] = sym
                placed += 1

    app.logger.info(
        "PDF import: placed %d of %d symbols (%.1f%%) in %dx%d grid",
        placed, len(all_syms), placed / len(all_syms) * 100 if all_syms else 0,
        grid_w, grid_h,
    )

    # Count-based symbol→DMC matching (when legend has no symbol mapping)
    if sym_to_dmc is None:
        sym_counts = Counter(c for c in result if c != 'BG')
        legend_counts = {e['dmc']: e.get('legend_count', 0) for e in legend_entries}

        # Greedy 1-to-1 matching: pair each symbol count to closest legend count
        unmatched_syms = list(sym_counts.items())   # [(sym, count), ...]
        unmatched_dmc  = list(legend_counts.items()) # [(dmc, count), ...]
        matched = {}  # sym → dmc

        # Sort both by count descending for greedy matching
        unmatched_syms.sort(key=lambda x: -x[1])
        unmatched_dmc.sort(key=lambda x: -x[1])

        used_dmc = set()
        for sym, sym_count in unmatched_syms:
            best_dmc = None
            best_diff = float('inf')
            for dmc, leg_count in unmatched_dmc:
                if dmc in used_dmc:
                    continue
                diff = abs(sym_count - leg_count)
                if diff < best_diff:
                    best_diff = diff
                    best_dmc = dmc
            if best_dmc:
                matched[sym] = best_dmc
                used_dmc.add(best_dmc)

        app.logger.info(
            "PDF import count-based matching: %d symbols → %d DMC colors "
            "(grid has %d filled cells)",
            len(matched), len(used_dmc), placed,
        )

        # Replace symbol placeholders with DMC numbers
        for i, cell in enumerate(result):
            if cell != 'BG':
                dmc = matched.get(cell)
                result[i] = dmc if dmc else 'BG'

    # Build legend with actual stitch counts
    db = get_db()
    uid = current_user.id
    _thread_info = {}
    for brand in {e.get('brand', 'DMC') for e in legend_entries}:
        brand_numbers = [e['dmc'] for e in legend_entries if e.get('brand', 'DMC') == brand]
        _thread_info.update(_lookup_threads_by_number(db, uid, brand, brand_numbers))

    dmc_hex = {}
    for e in legend_entries:
        row = _thread_info.get(e['dmc'])
        dmc_hex[e['dmc']] = row['hex_color'].lstrip('#') if row and row['hex_color'] else 'cccccc'

    cell_counts = Counter(result)
    legend_data = []
    for e in legend_entries:
        stitches = cell_counts.get(e['dmc'], 0)
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

    for i, entry in enumerate(legend_data):
        entry['symbol'] = _PATTERN_SYMBOLS[i % len(_PATTERN_SYMBOLS)]

    return {
        'title':  title,
        'grid_w': grid_w,
        'grid_h': grid_h,
        'grid':   result,
        'legend': legend_data,
    }


def _pdf_rect_color_to_rgb(color):
    """Convert a pdfplumber non_stroking_color to an (R, G, B) tuple (0-255).

    Handles DeviceRGB (3 floats), DeviceCMYK (4 floats), and DeviceGray
    (1 float or bare float).  Returns None for unsupported formats.
    """
    if color is None:
        return None
    if isinstance(color, (int, float)):
        v = max(0, min(255, round(float(color) * 255)))
        return (v, v, v)
    if not isinstance(color, (list, tuple)):
        return None
    n = len(color)
    if n == 3:  # RGB
        return tuple(max(0, min(255, round(float(c) * 255))) for c in color)
    if n == 4:  # CMYK → RGB
        c_, m_, y_, k_ = (float(x) for x in color)
        return (
            max(0, min(255, round(255 * (1 - c_) * (1 - k_)))),
            max(0, min(255, round(255 * (1 - m_) * (1 - k_)))),
            max(0, min(255, round(255 * (1 - y_) * (1 - k_)))),
        )
    if n == 1:  # Gray
        v = max(0, min(255, round(float(color[0]) * 255)))
        return (v, v, v)
    return None


def _import_pdf_rect_grid(plumber_pdf, grid_w, grid_h, legend_entries,
                          chart_page_indices, title='Imported Pattern',
                          legend_page_indices=None):
    """Import a PDF chart using colored vector rectangles (e.g. Stitch Fiddle).

    Some generators render each grid cell as a filled PDF rectangle rather
    than embedding images or text symbols.  This function:
      1. Detects the uniform cell size from rectangle positions
      2. Extracts fill colors from each rectangle
      3. Maps fill colors to DMC numbers via legend swatch colors (preferred)
         or closest DB-color matching (fallback)
      4. Uses row/column labels for per-page grid offsets
    """
    # Build color reference from DB (used as fallback)
    db = get_db()
    uid = current_user.id
    _thread_info = {}
    for brand in {e.get('brand', 'DMC') for e in legend_entries}:
        brand_numbers = [e['dmc'] for e in legend_entries if e.get('brand', 'DMC') == brand]
        _thread_info.update(_lookup_threads_by_number(db, uid, brand, brand_numbers))
    dmc_hex = {}
    for e in legend_entries:
        row = _thread_info.get(e['dmc'])
        dmc_hex[e['dmc']] = row['hex_color'].lstrip('#') if row and row['hex_color'] else 'cccccc'
    dmc_rgb = {dmc: tuple(int(h[i:i+2], 16) for i in (0, 2, 4)) for dmc, h in dmc_hex.items()}

    # ── Phase 0: extract legend swatch colors from legend page(s) ────────────
    # The PDF legend has colored rectangles next to each DMC entry.  These
    # exact fill colors match the chart cells, giving us a precise mapping
    # even for very similar colors (BLANC vs B5200 vs 3865).
    swatch_rgb_to_dmc = {}  # (r,g,b) → dmc_number — exact match map
    if legend_page_indices:
        for lpi in sorted(legend_page_indices):
            lpage = plumber_pdf.pages[lpi]
            lrects = lpage.rects or []
            # Single pass: parse colors and count swatch sizes
            swatch_sizes = Counter()
            parsed = []  # (sw, sh, cy, rgb)
            for lr in lrects:
                rgb = _pdf_rect_color_to_rgb(lr.get('non_stroking_color'))
                if rgb is None:
                    continue
                sw = round(float(lr['x1'] - lr['x0']), 0)
                sh = round(float(lr['y1'] - lr['y0']), 0)
                if 5 < sw < 80 and 5 < sh < 80:
                    swatch_sizes[(sw, sh)] += 1
                    cy = (lr['top'] + lr['bottom']) / 2
                    parsed.append((sw, sh, cy, rgb))
            if not swatch_sizes:
                continue
            (sw_w, sw_h), _ = swatch_sizes.most_common(1)[0]
            stol = 2.0
            # Filter to dominant swatch size, sort top-to-bottom
            swatches = sorted(
                (cy, rgb) for sw, sh, cy, rgb in parsed
                if abs(sw - sw_w) <= stol and abs(sh - sw_h) <= stol
            )
            for i, (cy, rgb) in enumerate(swatches):
                if i < len(legend_entries):
                    swatch_rgb_to_dmc[rgb] = legend_entries[i]['dmc']
        if swatch_rgb_to_dmc:
            app.logger.info(
                "PDF rect import: extracted %d swatch colors from legend page(s)",
                len(swatch_rgb_to_dmc),
            )

    # ── Phase 1: detect cell size from the first chart page ──────────────────
    # Collect all filled rects and find the dominant (most common) rect size.
    all_rect_sizes = Counter()
    for pi in chart_page_indices[:3]:
        page = plumber_pdf.pages[pi]
        for r in (page.rects or []):
            c = r.get('non_stroking_color')
            if c is None:
                continue
            w = round(float(r['x1'] - r['x0']), 1)
            h = round(float(r['y1'] - r['y0']), 1)
            if w > 1 and h > 1:  # skip hairline gridlines
                all_rect_sizes[(w, h)] += 1

    if not all_rect_sizes:
        raise ValueError(
            "No colored rectangles found on chart pages. "
            "This PDF may use a format that is not yet supported."
        )

    (cell_w, cell_h), top_count = all_rect_sizes.most_common(1)[0]
    app.logger.info(
        "PDF rect import: dominant cell size %.1f×%.1f (%d rects on sampled pages)",
        cell_w, cell_h, top_count,
    )

    # Tolerance for matching cell size (allow ±0.5pt for rounding)
    size_tol = 0.6

    # ── Phase 2: collect cell rects from all chart pages ─────────────────────
    page_rects = {}  # page_idx → [(x0, y0, rgb), ...]
    for pi in chart_page_indices:
        page = plumber_pdf.pages[pi]
        cells = []
        for r in (page.rects or []):
            rw = float(r['x1'] - r['x0'])
            rh = float(r['y1'] - r['y0'])
            if abs(rw - cell_w) > size_tol or abs(rh - cell_h) > size_tol:
                continue
            rgb = _pdf_rect_color_to_rgb(r.get('non_stroking_color'))
            if rgb is None:
                continue
            cells.append((round(float(r['x0']), 1), round(float(r['top']), 1), rgb))
        if cells:
            page_rects[pi] = cells

    if not page_rects:
        raise ValueError(
            "No grid cells found in chart rectangles. "
            "The rectangles may not match the expected uniform cell size."
        )

    # ── Phase 3: per-page origin detection from labels ───────────────────────
    # Same approach as _import_pdf_text_grid: use row/col labels to compute
    # the absolute grid offset for each chart page.
    page_origins = {}  # page_idx → (col_off, row_off, origin_x, origin_y)

    for pi, cells in page_rects.items():
        page = plumber_pdf.pages[pi]
        pw, ph = float(page.width), float(page.height)

        # Bounding box of cell rects on this page
        xs = [x for x, y, _ in cells]
        ys = [y for x, y, _ in cells]
        rect_min_x = min(xs)
        rect_min_y = min(ys)

        # Parse integer labels from text on this page.
        # Use tight x_tolerance to prevent merging of adjacent 3-digit labels
        # (e.g. "121 122 123" rendered at 14pt pitch can merge with default gap).
        words = page.extract_words(x_tolerance=2)
        col_labels = []
        row_labels = []
        for w in words:
            text = w['text'].strip()
            if len(text) > 4:  # skip concatenated labels
                continue
            try:
                n = int(text)
            except ValueError:
                continue
            wcx = (w['x0'] + w['x1']) / 2
            wcy = (w['top'] + w['bottom']) / 2
            if _pdf_is_likely_page_number(n, wcx / pw, wcy / ph):
                continue
            # Column label: above the chart rects
            # Don't cap at grid_w — inferred dims may be wrong; Phase 3.5
            # determines actual extent from rect positions.
            if wcy < rect_min_y - cell_h * 0.3 and n > 0:
                col_rank = round((wcx - rect_min_x) / cell_w)
                if col_rank >= 0:
                    col_labels.append(n - col_rank)
            # Row label: left of the chart rects
            if wcx < rect_min_x - cell_w * 0.3 and n > 0:
                row_rank = round((wcy - rect_min_y) / cell_h)
                if row_rank >= 0:
                    row_labels.append(n - row_rank)

        col_labels = [v for v in col_labels if v > 0]
        row_labels = [v for v in row_labels if v > 0]
        col_ctr = Counter(col_labels)
        row_ctr = Counter(row_labels)
        col_off = col_ctr.most_common(1)[0][0] if col_labels else 0
        row_off = row_ctr.most_common(1)[0][0] if row_labels else 0
        page_origins[pi] = (col_off, row_off, rect_min_x, rect_min_y)
        app.logger.info(
            "PDF rect import: page %d origin col_off=%d row_off=%d "
            "(%d cells, col_labels=%s, row_labels=%s)",
            pi + 1, col_off, row_off, len(cells),
            col_ctr.most_common(3),
            row_ctr.most_common(3),
        )

    # ── Phase 3a: infer missing col_off from page layout stride ────────
    # When column labels fail to extract (e.g. dense 3-digit labels at
    # 8.7pt cell pitch), infer col_off from the stride of successfully-
    # parsed neighbor pages within the same row band.
    _fix_pis = {pi for pi, (co, _, _, _) in page_origins.items() if co == 0}
    if _fix_pis:
        # Compute local column count per page from cell x-positions
        _page_ncols = {}
        for pi, cells in page_rects.items():
            xs = sorted(set(round((x - page_origins[pi][2]) / cell_w)
                            for x, _, _ in cells))
            _page_ncols[pi] = (max(xs) + 1) if xs else 0

        # Group pages by row_off
        _row_groups = {}
        for pi, (co, ro, _, _) in page_origins.items():
            _row_groups.setdefault(ro, []).append(pi)

        for ro, pis in _row_groups.items():
            pis.sort()
            # Backward walk: infer from preceding pages
            for i, pi in enumerate(pis):
                if pi not in _fix_pis:
                    continue
                for j in range(i - 1, -1, -1):
                    prev_co = page_origins[pis[j]][0]
                    if prev_co > 0:
                        offset = prev_co
                        for k in range(j, i):
                            offset += _page_ncols.get(pis[k], 0)
                        page_origins[pi] = (offset, ro,
                                            page_origins[pi][2],
                                            page_origins[pi][3])
                        app.logger.info(
                            "PDF rect import: inferred page %d col_off=%d "
                            "(from page layout stride, backward)",
                            pi + 1, offset,
                        )
                        break
            # Forward walk: infer pages at the start of a band from
            # a successor with known col_off (e.g. first page fails
            # but second page succeeded).
            for i in range(len(pis) - 1, -1, -1):
                pi = pis[i]
                if page_origins[pi][0] > 0:
                    continue
                for j in range(i + 1, len(pis)):
                    next_co = page_origins[pis[j]][0]
                    if next_co > 0:
                        # Subtract local widths from this page to the anchor
                        offset = next_co
                        for k in range(i, j):
                            offset -= _page_ncols.get(pis[k], 0)
                        if offset > 0:
                            page_origins[pi] = (offset, ro,
                                                page_origins[pi][2],
                                                page_origins[pi][3])
                            app.logger.info(
                                "PDF rect import: inferred page %d col_off=%d "
                                "(from page layout stride, forward)",
                                pi + 1, offset,
                            )
                        break
            # Warn about any pages still unfixed
            for pi in pis:
                if page_origins[pi][0] == 0:
                    app.logger.warning(
                        "PDF rect import: page %d col_off still 0 "
                        "(no anchor page found in row band)",
                        pi + 1,
                    )

    # Cross-page row offset consensus (same logic as text grid path)
    if len(page_origins) > 1:
        all_row_offs = [v[1] for v in page_origins.values()]
        row_consensus = Counter(all_row_offs).most_common(1)[0]
        if row_consensus[1] > len(all_row_offs) // 2:
            for pi in page_origins:
                co, ro, ox, oy = page_origins[pi]
                if ro != row_consensus[0]:
                    app.logger.info(
                        "PDF rect import: correcting page %d row_off %d → %d (consensus)",
                        pi + 1, ro, row_consensus[0],
                    )
                    page_origins[pi] = (co, row_consensus[0], ox, oy)

    # ── Phase 3.5: compute actual grid dimensions from cell positions ────────
    # The inferred dimensions from _pdf_infer_grid_dims may be wrong (label
    # cross-contamination between row/col bands).  Compute the true extent
    # from the cell positions we just determined.
    max_col = 0
    max_row = 0
    for pi, cells in page_rects.items():
        if pi not in page_origins:
            continue
        col_off, row_off, origin_x, origin_y = page_origins[pi]
        for x0, y0, _ in cells:
            c = col_off + round((x0 - origin_x) / cell_w)
            r = row_off + round((y0 - origin_y) / cell_h)
            if c > max_col:
                max_col = c
            if r > max_row:
                max_row = r

    if max_col > grid_w or max_row > grid_h:
        app.logger.info(
            "PDF rect import: expanding grid from %d×%d to %d×%d "
            "(actual cell extent)",
            grid_w, grid_h, max(grid_w, max_col), max(grid_h, max_row),
        )
        grid_w = max(grid_w, max_col)
        grid_h = max(grid_h, max_row)

    # ── Phase 4: map rect colors → DMC ──────────────────────────────────────
    # Prefer exact swatch match (from legend page); fall back to closest DB color.
    result = ['BG'] * (grid_w * grid_h)
    placed = 0
    dmc_list = list(dmc_rgb.items())  # [(dmc_number, (r,g,b)), ...]
    color_cache = {}  # rgb_tuple → dmc_number

    for pi, cells in page_rects.items():
        if pi not in page_origins:
            continue
        col_off, row_off, origin_x, origin_y = page_origins[pi]

        for x0, y0, rgb in cells:
            col = col_off + round((x0 - origin_x) / cell_w)
            row = row_off + round((y0 - origin_y) / cell_h)
            if not (1 <= col <= grid_w and 1 <= row <= grid_h):
                continue

            # Look up or compute DMC color mapping
            dmc = color_cache.get(rgb)
            if dmc is None:
                # Try exact swatch match first
                dmc = swatch_rgb_to_dmc.get(rgb)
                if dmc is None:
                    # Fall back to closest DB hex color
                    best_dist = float('inf')
                    best_dmc = None
                    for d, ref in dmc_list:
                        dist = (rgb[0]-ref[0])**2 + (rgb[1]-ref[1])**2 + (rgb[2]-ref[2])**2
                        if dist < best_dist:
                            best_dist = dist
                            best_dmc = d
                    dmc = best_dmc
                color_cache[rgb] = dmc

            idx = (row - 1) * grid_w + (col - 1)
            result[idx] = dmc
            placed += 1

    app.logger.info(
        "PDF rect import: placed %d cells (%.1f%%) in %d×%d grid, %d unique colors cached",
        placed, placed / (grid_w * grid_h) * 100, grid_w, grid_h, len(color_cache),
    )

    # Build legend with actual stitch counts
    cell_counts = Counter(result)
    legend_data = []
    for e in legend_entries:
        stitches = cell_counts.get(e['dmc'], 0)
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

    for i, entry in enumerate(legend_data):
        entry['symbol'] = _PATTERN_SYMBOLS[i % len(_PATTERN_SYMBOLS)]

    return {
        'title':  title,
        'grid_w': grid_w,
        'grid_h': grid_h,
        'grid':   result,
        'legend': legend_data,
    }


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
                        part_stitches_data, backstitches_data, knots_data, beads_data, brand, fabric_color,
                        total_stitches)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (slug, kwargs['user_id'], kwargs['name'], kwargs['grid_w'], kwargs['grid_h'],
                 kwargs['color_count'], kwargs['grid_json'], kwargs['legend_json'],
                 kwargs.get('thumbnail'), kwargs.get('source_image_path'),
                 kwargs.get('gen_settings_json'),
                 kwargs['ps_json'], kwargs['bs_json'], kwargs['kn_json'], kwargs['bd_json'],
                 kwargs.get('brand', 'DMC'), kwargs.get('fabric_color', '#F5F0E8'),
                 kwargs.get('total_stitches', 0))
            )
            return slug
        except sqlite3.IntegrityError:
            continue
    return None


def _count_stitchable_cells(grid_data):
    """Count non-BG cells in a grid list — matches pattern-viewer's _totalStitchableCount."""
    if not isinstance(grid_data, list):
        return 0
    return sum(1 for c in grid_data if c != 'BG')


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
        stitched = set(pd.get('stitched_cells', []))
        cleared = set(pd.get('cleared_cells', []))
        return {
            'completed_count': len(pd.get('completed_dmcs', [])),
            'stitched_cell_count': len(stitched - cleared),
            'accumulated_seconds': pd.get('accumulated_seconds', 0),
        }
    except (json.JSONDecodeError, KeyError, TypeError):
        return {'completed_count': 0, 'stitched_cell_count': 0, 'accumulated_seconds': 0}


def _merge_progress_data(existing_json, incoming):
    """Merge two progress_data dicts by taking the union of sets and max of counters.

    existing_json: JSON string (from DB) or None
    incoming: dict or JSON string (from sync payload)
    Returns: JSON string of merged progress_data.
    """
    try:
        existing = json.loads(existing_json) if existing_json else {}
    except (json.JSONDecodeError, TypeError):
        existing = {}
    if isinstance(incoming, str):
        try:
            incoming = json.loads(incoming)
        except (json.JSONDecodeError, TypeError):
            incoming = {}
    if not isinstance(incoming, dict):
        incoming = {}

    # Union of completed DMCs (string sets)
    e_dmcs = set(existing.get('completed_dmcs', []))
    i_dmcs = set(incoming.get('completed_dmcs', []))
    merged_dmcs = e_dmcs | i_dmcs

    # Union of stitched cells (int sets)
    e_cells = set(existing.get('stitched_cells', []))
    i_cells = set(incoming.get('stitched_cells', []))
    merged_cells = e_cells | i_cells

    # Union of cleared cells (int sets) — tracks intentional unmarks
    e_cc = set(existing.get('cleared_cells', []))
    i_cc = set(incoming.get('cleared_cells', []))
    merged_cleared_cells = e_cc | i_cc

    # Union of place markers (string sets)
    e_markers = set(existing.get('place_markers', []))
    i_markers = set(incoming.get('place_markers', []))
    merged_markers = e_markers | i_markers

    # Union of cleared markers (string sets) — tracks intentional unmarks
    e_cm = set(existing.get('cleared_markers', []))
    i_cm = set(incoming.get('cleared_markers', []))
    merged_cleared_markers = e_cm | i_cm

    # Conflict resolution: incoming device's intent wins
    # If incoming has a cell actively stitched (not cleared), remove stale clears
    merged_cleared_cells -= (i_cells - i_cc)
    merged_cleared_markers -= (i_markers - i_cm)

    # Max of accumulated seconds
    e_secs = existing.get('accumulated_seconds', 0) or 0
    i_secs = incoming.get('accumulated_seconds', 0) or 0

    merged = {
        'completed_dmcs': sorted(merged_dmcs),
        'stitched_cells': sorted(merged_cells),
        'cleared_cells': sorted(merged_cleared_cells),
        'place_markers': sorted(merged_markers),
        'cleared_markers': sorted(merged_cleared_markers),
        'accumulated_seconds': max(e_secs, i_secs),
    }
    return json.dumps(merged)


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


def _pdf_infer_grid_dims(plumber_pdf, chart_page_indices):
    """Infer grid dimensions from row/column label numbers on chart pages.

    Scans the edges of each chart page for integer labels (1, 10, 20, ...)
    and returns (estimated_width, estimated_height).
    Uses the label interval to estimate the full grid size beyond the last label.
    Returns (0, 0) if no labels found.
    """
    col_labels = set()
    row_labels = set()

    for page_idx in chart_page_indices[:20]:  # sample up to 20 pages
        page = plumber_pdf.pages[page_idx]
        pw, ph = float(page.width), float(page.height)
        words = page.extract_words()
        for w in words:
            try:
                n = int(w['text'])
            except ValueError:
                continue
            if n < 1 or n > 10000:
                continue
            wcx = (w['x0'] + w['x1']) / 2
            wcy = (w['top'] + w['bottom']) / 2
            x_pct = wcx / pw
            y_pct = wcy / ph
            if _pdf_is_likely_page_number(n, x_pct, y_pct):
                continue
            # Column labels: top or bottom band (within 20% of page edge)
            if y_pct < 0.20 or y_pct > 0.85:
                col_labels.add(n)
            # Row labels: left or right band (within 20% of page edge)
            if x_pct < 0.20 or x_pct > 0.82:
                row_labels.add(n)

    if not col_labels and not row_labels:
        return 0, 0

    def _estimate_dim(labels):
        if not labels:
            return 0
        vals = sorted(labels)
        if len(vals) < 2:
            return vals[0]
        # Detect label interval (most common spacing)
        spacings = [vals[i+1] - vals[i] for i in range(len(vals)-1)]
        interval = Counter(spacings).most_common(1)[0][0] if spacings else 10
        return vals[-1] + interval

    return _estimate_dim(col_labels), _estimate_dim(row_labels)


def _import_pdf_body(plumber_pdf, pdfium_doc):
    """Inner logic for PDF pattern import — called with managed resources."""
    # -- Cover --
    grid_w, grid_h, title = _pdf_parse_cover(plumber_pdf.pages[0])

    # -- Legend detection: search all non-cover pages --
    # Priority: branded → vector header → tabular → bare number fallback
    # Track which pages contain the legend so we can exclude them from chart pages.
    num_pages = len(plumber_pdf.pages)
    legend_entries = []
    legend_page_indices = set()

    # Order: last page first (most common), then page 1, then remaining inner
    # pages, then page 0 (cover) as fallback — some generators (Stitch Fiddle)
    # put the legend on the cover page itself.
    search_order = [num_pages - 1]
    if num_pages >= 3:
        search_order.append(1)
    for i in range(2, num_pages - 1):
        if i not in search_order:
            search_order.append(i)
    if 0 not in search_order:
        search_order.append(0)

    # Pass 1: per-page parsers (branded, vector header)
    for page_idx in search_order:
        page = plumber_pdf.pages[page_idx]

        entries = _pdf_parse_legend(page)
        if not entries:
            entries = _pdf_parse_legend_vector(page)
        if entries:
            legend_entries = entries
            legend_page_indices.add(page_idx)
            app.logger.info("PDF import: legend found on page %d (%d entries)", page_idx + 1, len(entries))
            break

    # Pass 2: tabular format (may span multiple pages, no header dependency)
    if not legend_entries:
        entries, tab_pages = _pdf_parse_legend_tabular(
            [(i, plumber_pdf.pages[i]) for i in search_order]
        )
        if entries:
            legend_entries = entries
            legend_page_indices.update(tab_pages)
            app.logger.info(
                "PDF import: tabular legend found on page(s) %s (%d entries)",
                ','.join(str(p + 1) for p in sorted(tab_pages)), len(entries),
            )

    # Pass 3: bare number fallback (validated against DB — checks DMC + Anchor)
    if not legend_entries:
        db = get_db()
        rows = db.execute("SELECT DISTINCT brand, number FROM threads").fetchall()
        bare_known = {}  # number → brand (DMC wins ties)
        for r in rows:
            num, brand = r['number'], r['brand']
            if num not in bare_known or brand == 'DMC':
                bare_known[num] = brand
        for page_idx in search_order:
            entries = _pdf_parse_legend_bare(plumber_pdf.pages[page_idx], bare_known)
            if entries:
                legend_entries = entries
                legend_page_indices.add(page_idx)
                app.logger.info(
                    "PDF import: legend found via bare-number fallback on page %d (%d entries)",
                    page_idx + 1, len(entries),
                )
                break

    if not legend_entries:
        raise ValueError(
            "Could not find a thread legend in this PDF. "
            "The legend should list DMC or Anchor thread numbers with color names."
        )

    # Chart pages = everything except cover (page 0), legend pages,
    # and non-chart pages (index/TOC pages, near-empty pages).
    # Only filter when dimensions aren't known yet (small patterns may
    # have legitimately short chart pages).
    chart_page_indices = []
    for i in range(1, num_pages):
        if i in legend_page_indices:
            continue
        if grid_w == 0 or grid_h == 0:
            text = plumber_pdf.pages[i].extract_text() or ''
            stripped = text.strip()
            # Skip near-empty pages
            if len(stripped) < 100:
                continue
            # Skip pages that are mostly header/footer with no grid content
            # (e.g. page-index pages or final info pages).  Strip common
            # header/footer lines and check remaining content length.
            content_lines = [
                ln for ln in stripped.split('\n')
                if not re.match(
                    r'^\d+\s*/\s*\d+$|^Powered\s+by\b|^\d+\s+/\s+\d+$|'
                    r'www\.|info@|Make your own|Picture to pattern|'
                    r'Cross stitch pattern\b',
                    ln.strip(), re.IGNORECASE,
                )
            ]
            content_text = ' '.join(ln.strip() for ln in content_lines)
            if len(content_text) < 40:
                continue
        chart_page_indices.append(i)

    if not chart_page_indices:
        raise ValueError(
            "No chart pages found in this PDF. "
            "The file may only contain a legend or cover page without any stitch grid."
        )

    app.logger.info(
        "PDF import: %d pages total, %d legend, %d chart (pages %s)",
        num_pages, len(legend_page_indices), len(chart_page_indices),
        ','.join(str(p + 1) for p in chart_page_indices),
    )

    # Infer grid dimensions from chart labels if cover page didn't have them
    if grid_w == 0 or grid_h == 0:
        inf_w, inf_h = _pdf_infer_grid_dims(plumber_pdf, chart_page_indices)
        if inf_w > 0 and inf_h > 0:
            grid_w, grid_h = inf_w, inf_h
            app.logger.info("PDF import: inferred grid dimensions from labels: %d×%d", grid_w, grid_h)
        else:
            raise ValueError(
                "Could not determine the pattern dimensions. "
                "The cover page should list the stitch count (e.g. '150 x 123'), "
                "or chart pages should have numbered row/column labels."
            )

    # Check if chart pages have embedded images (image-based PDF) or text symbols (vector PDF).
    # Two indicators of image-based charts:
    #   1. A single large image covering >25% of page (some export formats)
    #   2. Many small named images (>50 per page) — individual cell images (some generators)
    def _has_chart_images(page):
        pa = float(page.width) * float(page.height)
        named_count = 0
        for img in page.images:
            if not img.get('name'):
                continue
            named_count += 1
            iw = float(img.get('width', 0) or 0)
            ih = float(img.get('height', 0) or 0)
            if iw * ih > 0.25 * pa:
                return True
        # Many small named images = image-based cell grid
        return named_count > 50

    has_images = any(_has_chart_images(plumber_pdf.pages[i]) for i in chart_page_indices[:3])

    if not has_images:
        # Pre-count colored vector rects as potential fallback (Stitch Fiddle).
        _rect_count = 0
        for _ci in chart_page_indices[:3]:
            _pg = plumber_pdf.pages[_ci]
            for _r in (_pg.rects or []):
                if _r.get('non_stroking_color') is not None:
                    rw = float(_r['x1'] - _r['x0'])
                    rh = float(_r['y1'] - _r['y0'])
                    if rw > 1 and rh > 1:
                        _rect_count += 1

        # Try text-based extraction first (exact symbol mapping is preferred
        # over color-distance matching).  Fall back to rect-based extraction
        # if no text symbols are found on chart pages.
        try:
            app.logger.info(
                "PDF import: no cell images found, trying text-based grid extraction "
                "(%d legend entries, %d chart pages, %d rects detected)",
                len(legend_entries), len(chart_page_indices), _rect_count,
            )
            return _import_pdf_text_grid(plumber_pdf, grid_w, grid_h, legend_entries, chart_page_indices, title)
        except ValueError:
            if _rect_count > 50:
                app.logger.info(
                    "PDF import: text extraction failed, falling back to rect-based "
                    "grid extraction (%d colored rects)",
                    _rect_count,
                )
                return _import_pdf_rect_grid(
                    plumber_pdf, grid_w, grid_h, legend_entries, chart_page_indices,
                    title, legend_page_indices,
                )
            raise  # re-raise if no rects either

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
    cell_counts = Counter(result)
    legend_data = []
    for e in legend_entries:
        stitches = cell_counts.get(e['dmc'], 0)
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


_PATTERN_SYMBOLS = "+×#@*!=?%&~^$●■▲◆★§¶†‡±÷◎⊕⊗≠√∞⊞⬡¤※○□▽▷◁▼◀▶⊙⊘⊛⊝⊟⊠⊡☆♣♠♥∇≈≡⊃⊂∩∪⊥∂Ω⌘⌂☼✦✶⊤µ"
_SYMBOLS_VERSION = "4"  # increment when _PATTERN_SYMBOLS changes

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
    img = Image.open(io.BytesIO(img_bytes))
    # Extract alpha channel as a transparency mask before converting to RGB
    alpha_mask = None
    if img.mode in ('RGBA', 'LA', 'PA'):
        alpha_mask = img.split()[-1]  # last channel is alpha (0=transparent, 255=opaque)
    img = img.convert('RGB')

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

    if alpha_mask is not None:
        # Resize alpha mask to match (crop may have changed img size)
        if alpha_mask.size != img.size:
            alpha_mask = alpha_mask.resize(img.size, Image.LANCZOS)
        if shape_mask is None:
            shape_mask = alpha_mask
        else:
            # Combine: pixel is inside only if both masks say so (AND)
            shape_mask = ImageChops.multiply(shape_mask, alpha_mask)
        # Fill transparent areas with white so they don't affect quantization
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

    # Check if any users exist — show setup hint if not
    no_users = False
    if not DESKTOP_MODE:
        conn = get_db()
        no_users = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0

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

    return render_template('login.html', error=error, no_users=no_users)


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
    """Redirect old calculator URL to Materials Calculator page."""
    return redirect('/pattern-calculator?mode=fabric')


@app.route('/skein-calculator')
@login_required
def skein_calculator():
    """Redirect old skein-calculator URL to Materials Calculator page."""
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
    """Materials Calculator — thread needs, skein estimates, and fabric sizing."""
    return render_template('pattern-calculator.html')


@app.route('/stash-calculator')
@login_required
def stash_calculator():
    """Redirect old stash-calculator URL to Materials Calculator page."""
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


# --- Admin user management (server-only) ---

@app.route('/admin')
@admin_required
def admin_page():
    """Admin user management page."""
    if DESKTOP_MODE:
        return redirect(url_for('home'))
    conn = get_db()
    users = conn.execute(
        "SELECT id, username, email, is_active, is_admin, created_at, last_login "
        "FROM users ORDER BY created_at ASC"
    ).fetchall()
    return render_template('admin.html', users=users,
                           admin_self_id=current_user.id)


@app.route('/api/admin/users', methods=['POST'])
@limiter.limit("10 per minute")
@admin_required
def api_admin_create_user():
    """Create a new user account."""
    data = request.get_json(force=True)
    username = (data.get('username') or '').strip()
    email = (data.get('email') or '').strip()
    password = data.get('password', '')

    if not username or not email or not password:
        return jsonify({'error': 'Username, email, and password are required'}), 400
    if len(username) < 3 or len(username) > 50:
        return jsonify({'error': 'Username must be 3-50 characters'}), 400
    if not re.match(r'^[a-zA-Z0-9_\- ]+$', username):
        return jsonify({'error': 'Username may only contain letters, numbers, spaces, hyphens, and underscores'}), 400
    if '@' not in email or '.' not in email:
        return jsonify({'error': 'Invalid email address'}), 400
    if len(password) < 8:
        return jsonify({'error': 'Password must be at least 8 characters'}), 400
    if len(password) > 1024:
        return jsonify({'error': 'Password too long'}), 400

    conn = get_db()
    existing = conn.execute(
        "SELECT id FROM users WHERE username = ? OR email = ?",
        (username, email)).fetchone()
    if existing:
        return jsonify({'error': 'Username or email already exists'}), 409

    password_hash = ph.hash(password)
    cur = conn.execute(
        "INSERT INTO users (username, email, password_hash, is_active, is_admin) "
        "VALUES (?, ?, ?, 1, 0)",
        (username, email, password_hash))
    conn.commit()
    user_id = cur.lastrowid
    return jsonify({'id': user_id, 'username': username, 'email': email}), 201


@app.route('/api/admin/users/<int:user_id>/password', methods=['POST'])
@limiter.limit("10 per minute")
@admin_required
def api_admin_reset_password(user_id):
    """Reset a user's password (admin action, no current password needed)."""
    data = request.get_json(force=True)
    new_pw = data.get('new_password', '')

    if len(new_pw) < 8:
        return jsonify({'error': 'Password must be at least 8 characters'}), 400
    if len(new_pw) > 1024:
        return jsonify({'error': 'Password too long'}), 400

    conn = get_db()
    row = conn.execute("SELECT id FROM users WHERE id = ?", (user_id,)).fetchone()
    if not row:
        return jsonify({'error': 'User not found'}), 404

    new_hash = ph.hash(new_pw)
    conn.execute("UPDATE users SET password_hash = ? WHERE id = ?",
                 (new_hash, user_id))
    conn.commit()
    return jsonify({'ok': True})


@app.route('/api/admin/users/<int:user_id>', methods=['PATCH'])
@limiter.limit("20 per minute")
@admin_required
def api_admin_update_user(user_id):
    """Toggle is_active or is_admin for a user."""
    if user_id == current_user.id:
        return jsonify({'error': 'Cannot modify your own account'}), 400

    data = request.get_json(force=True)
    conn = get_db()

    row = conn.execute("SELECT id, is_admin FROM users WHERE id = ?",
                       (user_id,)).fetchone()
    if not row:
        return jsonify({'error': 'User not found'}), 404

    updates = []
    params = []

    if 'is_active' in data:
        val = 1 if data['is_active'] else 0
        updates.append("is_active = ?")
        params.append(val)

    if 'is_admin' in data:
        val = 1 if data['is_admin'] else 0
        # Prevent removing the last admin
        if val == 0 and row['is_admin']:
            admin_count = conn.execute(
                "SELECT COUNT(*) FROM users WHERE is_admin = 1 AND id != ?",
                (user_id,)).fetchone()[0]
            if admin_count == 0:
                return jsonify({'error': 'Cannot remove the last admin'}), 400
        updates.append("is_admin = ?")
        params.append(val)

    if not updates:
        return jsonify({'error': 'No valid fields to update'}), 400

    params.append(user_id)
    conn.execute(f"UPDATE users SET {', '.join(updates)} WHERE id = ?", params)
    conn.commit()
    return jsonify({'ok': True})


@app.route('/api/admin/users/<int:user_id>', methods=['DELETE'])
@limiter.limit("10 per minute")
@admin_required
def api_admin_delete_user(user_id):
    """Delete a user account."""
    if user_id == current_user.id:
        return jsonify({'error': 'Cannot delete your own account'}), 400

    conn = get_db()
    row = conn.execute("SELECT id, is_admin FROM users WHERE id = ?",
                       (user_id,)).fetchone()
    if not row:
        return jsonify({'error': 'User not found'}), 404

    # Prevent deleting the last admin
    if row['is_admin']:
        admin_count = conn.execute(
            "SELECT COUNT(*) FROM users WHERE is_admin = 1 AND id != ?",
            (user_id,)).fetchone()[0]
        if admin_count == 0:
            return jsonify({'error': 'Cannot delete the last admin'}), 400

    conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
    conn.commit()
    return '', 204


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
        num_colors = clamp(int(request.form.get('num_colors', 15)), 5, len(_PATTERN_SYMBOLS))
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
    total_stitches = _count_stitchable_cells(grid_data)

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
        fabric_color=fabric_color, total_stitches=total_stitches)
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
    total_stitches = _count_stitchable_cells(grid_data)
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
        fabric_color=fabric_color, total_stitches=total_stitches)
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
                  project_status, progress_data, brand, notes, total_stitches
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
                'exported_at': datetime.now(timezone.utc).isoformat(),
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
    date_str = datetime.now(timezone.utc).strftime('%Y-%m-%d')
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
        result['cleared_cells'] = pd_parsed.get('cleared_cells', [])
        result['place_markers'] = pd_parsed.get('place_markers', [])
        result['cleared_markers'] = pd_parsed.get('cleared_markers', [])
        result['accumulated_seconds'] = pd_parsed.get('accumulated_seconds', 0)
    except (json.JSONDecodeError, KeyError, TypeError):
        result['generation_settings'] = None
        result['completed_dmcs'] = []
        result['stitched_cells'] = []
        result['cleared_cells'] = []
        result['place_markers'] = []
        result['cleared_markers'] = []
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
        total_stitches = _count_stitchable_cells(grid_data)
        thumbnail = data.get('thumbnail')
        if thumbnail and (not isinstance(thumbnail, str) or not thumbnail.startswith('data:image/')):
            thumbnail = None  # silently drop invalid thumbnails

        # Build dynamic UPDATE
        fields = ['grid_data=?', 'legend_data=?', 'color_count=?', 'grid_w=?', 'grid_h=?',
                  'total_stitches=?', 'updated_at=CURRENT_TIMESTAMP']
        params = [grid_json, legend_json, color_count, new_grid_w, new_grid_h, total_stitches]
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
        stitched_count = 0
        if new_status == 'completed':
            # Mark all non-BG cells as stitched and all colors as completed
            cursor.execute(
                'SELECT grid_data, legend_data, progress_data FROM saved_patterns WHERE id=? AND user_id=?',
                [pattern_id, current_user.id]
            )
            pat = cursor.fetchone()
            if not pat:
                return jsonify({'error': 'Pattern not found'}), 404
            try:
                grid = json.loads(pat['grid_data'])
                legend = json.loads(pat['legend_data'])
            except (json.JSONDecodeError, TypeError):
                grid, legend = [], []
            all_stitchable = [i for i, dmc in enumerate(grid) if dmc != 'BG']
            all_dmcs = [str(e.get('dmc', '')) for e in legend if e.get('dmc') and str(e['dmc']) != 'BG']
            # Preserve existing accumulated_seconds and place_markers
            try:
                existing_pd = json.loads(pat['progress_data'] or '{}')
            except (json.JSONDecodeError, TypeError):
                existing_pd = {}
            # Save pre-completion progress so it can be restored if user un-completes
            backup = {
                'completed_dmcs': existing_pd.get('completed_dmcs', []),
                'stitched_cells': existing_pd.get('stitched_cells', []),
                'cleared_cells': existing_pd.get('cleared_cells', []),
            }
            pd = {
                'completed_dmcs': all_dmcs,
                'stitched_cells': all_stitchable,
                'cleared_cells': [],
                'place_markers': existing_pd.get('place_markers', []),
                'cleared_markers': existing_pd.get('cleared_markers', []),
                'accumulated_seconds': existing_pd.get('accumulated_seconds', 0),
                '_pre_complete_backup': backup,
            }
            pd_json = json.dumps(pd)
            cursor.execute(
                'UPDATE saved_patterns SET project_status=?, progress_data=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?',
                [new_status, pd_json, pattern_id, current_user.id]
            )
        else:
            # Restore pre-completion progress if un-completing
            cursor.execute(
                'SELECT progress_data, project_status FROM saved_patterns WHERE id=? AND user_id=?',
                [pattern_id, current_user.id])
            pat = cursor.fetchone()
            if pat and pat['project_status'] == 'completed':
                try:
                    existing_pd = json.loads(pat['progress_data'] or '{}')
                except (json.JSONDecodeError, TypeError):
                    existing_pd = {}
                backup = existing_pd.pop('_pre_complete_backup', None)
                if backup:
                    existing_pd['completed_dmcs'] = backup.get('completed_dmcs', [])
                    existing_pd['stitched_cells'] = backup.get('stitched_cells', [])
                    existing_pd['cleared_cells'] = backup.get('cleared_cells', [])
                    pd_json = json.dumps(existing_pd)
                    cursor.execute(
                        'UPDATE saved_patterns SET project_status=?, progress_data=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?',
                        [new_status, pd_json, pattern_id, current_user.id])
                    # Count effective stitched cells for the response
                    cleared = set(backup.get('cleared_cells', []))
                    stitched_count = len([c for c in backup.get('stitched_cells', []) if c not in cleared])
                else:
                    cursor.execute(
                        'UPDATE saved_patterns SET project_status=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?',
                        [new_status, pattern_id, current_user.id])
            else:
                cursor.execute(
                    'UPDATE saved_patterns SET project_status=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?',
                    [new_status, pattern_id, current_user.id])
                if pat:
                    try:
                        existing_pd = json.loads(pat['progress_data'] or '{}')
                        cleared = set(existing_pd.get('cleared_cells', []))
                        stitched_count = len([c for c in existing_pd.get('stitched_cells', []) if c not in cleared])
                    except (json.JSONDecodeError, TypeError):
                        pass
        conn.commit()
        affected = cursor.rowcount
        if affected == 0:
            return jsonify({'error': 'Pattern not found'}), 404
        return jsonify({'ok': True, 'stitched_cell_count': stitched_count})

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
        # Validate cleared_cells if present
        cc = pd.get('cleared_cells', [])
        if not isinstance(cc, list):
            return jsonify({'error': 'cleared_cells must be an array'}), 400
        if cc and not all(isinstance(i, int) and not isinstance(i, bool) and i >= 0 for i in cc):
            return jsonify({'error': 'cleared_cells must contain non-negative integers'}), 400
        # Validate place_markers if present
        pm = pd.get('place_markers', [])
        if not isinstance(pm, list):
            return jsonify({'error': 'place_markers must be an array'}), 400
        _marker_re = re.compile(r'^\d{1,6},\d{1,6}$')
        if pm and not all(isinstance(m, str) and _marker_re.match(m) for m in pm):
            return jsonify({'error': 'place_markers must contain "col,row" strings'}), 400
        # Validate cleared_markers if present
        cm = pd.get('cleared_markers', [])
        if not isinstance(cm, list):
            return jsonify({'error': 'cleared_markers must be an array'}), 400
        if cm and not all(isinstance(m, str) and _marker_re.match(m) for m in cm):
            return jsonify({'error': 'cleared_markers must contain "col,row" strings'}), 400
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
        rows = cursor.execute(
            f"SELECT id, grid_data, legend_data, progress_data, project_status FROM saved_patterns WHERE id IN ({placeholders}) AND user_id = ?",
            ids + [current_user.id]).fetchall()
        for row in rows:
            try:
                existing_pd = json.loads(row['progress_data'] or '{}')
            except (json.JSONDecodeError, TypeError):
                existing_pd = {}
            if new_status == 'completed':
                try:
                    grid = json.loads(row['grid_data'])
                    legend = json.loads(row['legend_data'])
                except (json.JSONDecodeError, TypeError):
                    grid, legend = [], []
                all_stitchable = [i for i, dmc in enumerate(grid) if dmc != 'BG']
                all_dmcs = [str(e.get('dmc', '')) for e in legend if e.get('dmc') and str(e['dmc']) != 'BG']
                backup = {
                    'completed_dmcs': existing_pd.get('completed_dmcs', []),
                    'stitched_cells': existing_pd.get('stitched_cells', []),
                    'cleared_cells': existing_pd.get('cleared_cells', []),
                }
                pd = {
                    'completed_dmcs': all_dmcs,
                    'stitched_cells': all_stitchable,
                    'cleared_cells': [],
                    'place_markers': existing_pd.get('place_markers', []),
                    'cleared_markers': existing_pd.get('cleared_markers', []),
                    'accumulated_seconds': existing_pd.get('accumulated_seconds', 0),
                    '_pre_complete_backup': backup,
                }
                cursor.execute(
                    'UPDATE saved_patterns SET project_status=?, progress_data=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?',
                    [new_status, json.dumps(pd), row['id'], current_user.id])
            elif row['project_status'] == 'completed':
                # Un-completing: restore backed-up progress
                backup = existing_pd.pop('_pre_complete_backup', None)
                if backup:
                    existing_pd['completed_dmcs'] = backup.get('completed_dmcs', [])
                    existing_pd['stitched_cells'] = backup.get('stitched_cells', [])
                    existing_pd['cleared_cells'] = backup.get('cleared_cells', [])
                    cursor.execute(
                        'UPDATE saved_patterns SET project_status=?, progress_data=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?',
                        [new_status, json.dumps(existing_pd), row['id'], current_user.id])
                else:
                    cursor.execute(
                        'UPDATE saved_patterns SET project_status=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?',
                        [new_status, row['id'], current_user.id])
            else:
                cursor.execute(
                    'UPDATE saved_patterns SET project_status=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?',
                    [new_status, row['id'], current_user.id])
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
    return render_template('oxs-to-pattern.html',
                           pattern_symbols=_PATTERN_SYMBOLS)


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
    except ValueError as e:
        # Controlled import-failure messages — pass through to the user
        app.logger.warning("PDF import failed: %s", e)
        return jsonify({'error': str(e)}), 422
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


@app.route('/api/sync/progress', methods=['GET'])
@csrf.exempt
@api_token_required
def api_sync_progress_changes():
    """Lightweight delta: return only progress_data and thread statuses changed since timestamp."""
    since = request.args.get('since', '1970-01-01T00:00:00')
    try:
        datetime.fromisoformat(since)
    except (ValueError, TypeError):
        return jsonify({'error': 'Invalid since timestamp'}), 400
    uid = current_user.id
    conn = get_db()
    server_time = conn.execute("SELECT datetime('now')").fetchone()[0]

    # Only progress_data and project_status for patterns updated since
    pattern_rows = conn.execute(
        """SELECT slug, progress_data, project_status, updated_at, total_stitches
           FROM saved_patterns WHERE user_id = ? AND updated_at > ?
           ORDER BY updated_at""",
        (uid, since)).fetchall()
    patterns = []
    for r in pattern_rows:
        pd = r['progress_data']
        try:
            pd = json.loads(pd) if pd else None
        except (json.JSONDecodeError, TypeError):
            pd = None
        patterns.append({
            'slug': r['slug'],
            'progress_data': pd,
            'project_status': r['project_status'],
            'updated_at': r['updated_at'],
            'total_stitches': r['total_stitches'],
        })

    # Thread statuses (same as full sync — these are always small)
    thread_rows = conn.execute(
        """SELECT t.brand, t.number, u.status, u.notes, u.skein_qty, u.updated_at
           FROM user_thread_status u
           JOIN threads t ON t.id = u.thread_id
           WHERE u.user_id = ? AND u.updated_at > ?
           ORDER BY u.updated_at""",
        (uid, since)).fetchall()
    threads_upserted = [dict(r) for r in thread_rows]

    return jsonify({
        'server_time': server_time,
        'patterns': patterns,
        'thread_statuses': threads_upserted,
    })


@app.route('/api/sync/progress', methods=['POST'])
@csrf.exempt
@api_token_required
def api_sync_progress_push():
    """Lightweight push: accept only progress_data and thread status updates."""
    data = request.get_json(silent=True) or {}
    uid = current_user.id
    conn = get_db()
    cursor = conn.cursor()
    stats = {'patterns_updated': 0, 'patterns_skipped': 0,
             'threads_updated': 0, 'threads_skipped': 0, 'threads_created': 0}

    for p in data.get('patterns', []):
        slug = p.get('slug')
        pushed_at = p.get('updated_at', '')
        if not slug:
            continue
        existing = cursor.execute(
            "SELECT id, updated_at, progress_data FROM saved_patterns WHERE slug = ? AND user_id = ?",
            (slug, uid)).fetchone()
        if not existing:
            continue  # progress-only sync doesn't create new patterns
        # Merge progress data (union of sets) instead of last-write-wins
        progress_json = _merge_progress_data(existing['progress_data'], p.get('progress_data'))
        project_status = p.get('project_status', 'not_started')
        if project_status not in ('not_started', 'in_progress', 'completed'):
            project_status = 'not_started'
        new_ts = max(pushed_at, existing['updated_at'] or '')
        # Accept total_stitches if pushed (desktop may have recomputed it)
        total_stitches = p.get('total_stitches')
        if isinstance(total_stitches, int) and total_stitches > 0:
            cursor.execute(
                "UPDATE saved_patterns SET progress_data=?, project_status=?, updated_at=?, total_stitches=? WHERE id=? AND user_id=?",
                (progress_json, project_status, new_ts, total_stitches, existing['id'], uid))
        else:
            cursor.execute(
                "UPDATE saved_patterns SET progress_data=?, project_status=?, updated_at=? WHERE id=? AND user_id=?",
                (progress_json, project_status, new_ts, existing['id'], uid))
        stats['patterns_updated'] += 1

    # Thread statuses (same handling as full push)
    for ts in data.get('thread_statuses', []):
        brand = ts.get('brand', 'DMC')
        number = ts.get('number', '')
        if not number:
            continue
        pushed_at = ts.get('updated_at', '')
        thread_row = cursor.execute(
            "SELECT id FROM threads WHERE brand = ? AND number = ?",
            (brand, number)).fetchone()
        if not thread_row:
            continue
        tid = thread_row['id']
        existing = cursor.execute(
            "SELECT updated_at FROM user_thread_status WHERE user_id = ? AND thread_id = ?",
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

    conn.commit()
    server_time = conn.execute("SELECT datetime('now')").fetchone()[0]
    stats['server_time'] = server_time
    return jsonify(stats)


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
            "SELECT id, updated_at, progress_data FROM saved_patterns WHERE slug = ? AND user_id = ?",
            (slug, uid)).fetchone()
        if existing:
            # Last-write-wins for pattern data, but merge progress
            if pushed_at > (existing['updated_at'] or ''):
                grid_json = json.dumps(p['grid_data']) if isinstance(p.get('grid_data'), list) else p.get('grid_data', '[]')
                legend_json = json.dumps(p['legend_data']) if isinstance(p.get('legend_data'), list) else p.get('legend_data', '[]')
                ps_json, bs_json, kn_json, bd_json = _serialize_stitch_layers(p)
                progress_json = _merge_progress_data(existing['progress_data'], p.get('progress_data'))
                notes_val = str(p.get('notes', '') or '')[:2000]
                total_stitches = _count_stitchable_cells(p.get('grid_data', []))
                cursor.execute(
                    """UPDATE saved_patterns SET name=?, grid_w=?, grid_h=?, color_count=?,
                              grid_data=?, legend_data=?, thumbnail=?, updated_at=?,
                              progress_data=?, project_status=?,
                              part_stitches_data=?, backstitches_data=?, knots_data=?, beads_data=?, brand=?, notes=?,
                              total_stitches=?
                       WHERE id=? AND user_id=?""",
                    (p.get('name', 'Untitled'), p.get('grid_w'), p.get('grid_h'), p.get('color_count', 0),
                     grid_json, legend_json, p.get('thumbnail'),
                     pushed_at, progress_json, p.get('project_status', 'not_started'),
                     ps_json, bs_json, kn_json, bd_json, p.get('brand', 'DMC'), notes_val,
                     total_stitches, existing['id'], uid))
                stats['patterns_updated'] += 1
            else:
                stats['patterns_skipped'] += 1
        else:
            # New pattern — insert
            grid_json = json.dumps(p['grid_data']) if isinstance(p.get('grid_data'), list) else p.get('grid_data', '[]')
            legend_json = json.dumps(p['legend_data']) if isinstance(p.get('legend_data'), list) else p.get('legend_data', '[]')
            ps_json, bs_json, kn_json, bd_json = _serialize_stitch_layers(p)
            progress_json = json.dumps(p['progress_data']) if isinstance(p.get('progress_data'), dict) else p.get('progress_data')
            notes_val = str(p.get('notes', '') or '')[:2000]
            total_stitches = _count_stitchable_cells(p.get('grid_data', []))
            cursor.execute(
                """INSERT INTO saved_patterns
                       (slug, user_id, name, grid_w, grid_h, color_count, grid_data, legend_data,
                        thumbnail, created_at, updated_at, progress_data, project_status,
                        part_stitches_data, backstitches_data, knots_data, beads_data, brand, notes,
                        total_stitches)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (slug, uid, p.get('name', 'Untitled'), p.get('grid_w'), p.get('grid_h'),
                 p.get('color_count', 0), grid_json, legend_json, p.get('thumbnail'),
                 p.get('created_at', pushed_at), pushed_at, progress_json,
                 p.get('project_status', 'not_started'), ps_json, bs_json, kn_json, bd_json,
                 p.get('brand', 'DMC'), notes_val, total_stitches))
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


@app.route('/api/sync-config/sync-progress', methods=['POST'])
@login_required
def api_sync_config_trigger_progress():
    """Trigger a lightweight progress-only sync (desktop mode only)."""
    if not DESKTOP_MODE:
        return jsonify({'error': 'Only available in desktop mode'}), 403
    cfg = _read_sync_config()
    if not cfg.get('token') or not cfg.get('server_url'):
        return jsonify({'error': 'Not paired with a server'}), 400

    from sync_engine import SyncEngine
    engine = SyncEngine(cfg['server_url'], cfg['token'], DB_PATH)
    result = engine.sync_progress(cfg.get('last_progress_sync_at', cfg.get('last_sync_at', '')), current_user.id)

    if result.get('error'):
        return jsonify({'error': result['error']}), 502

    # Track progress sync time separately so full sync still picks up everything
    cfg['last_progress_sync_at'] = result.get('server_time', '')
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


def _migrate_total_stitches():
    """Add total_stitches column and backfill from grid_data."""
    conn = _get_db_direct()
    cols = [r[1] for r in conn.execute("PRAGMA table_info(saved_patterns)").fetchall()]
    if 'total_stitches' not in cols:
        conn.execute("ALTER TABLE saved_patterns ADD COLUMN total_stitches INTEGER NOT NULL DEFAULT 0")
    # Always backfill rows that still have total_stitches=0
    cursor = conn.execute(
        "SELECT id, grid_data FROM saved_patterns WHERE grid_data IS NOT NULL AND total_stitches = 0")
    updated = 0
    for row in cursor:
        try:
            grid = json.loads(row['grid_data'])
            count = _count_stitchable_cells(grid)
            if count > 0:
                conn.execute("UPDATE saved_patterns SET total_stitches = ? WHERE id = ?",
                             (count, row['id']))
                updated += 1
        except (json.JSONDecodeError, TypeError):
            pass
    if updated:
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
        _migrate_total_stitches()
        _migrate_user_thread_status()
        _migrate_sync_tables()
        _migrate_pattern_symbols()
        _migrate_user_preferences()
        _migrate_admin_column()
        _bootstrap_admin_from_env()
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
