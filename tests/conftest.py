"""Shared fixtures for sync feature tests."""

import json
import os
import secrets
import sqlite3
import tempfile

import pytest

# Set env vars BEFORE importing app so module-level code picks them up
_test_dir_holder = {}


@pytest.fixture(scope="session", autouse=True)
def test_db_dir():
    """Create a temp directory and point NEEDLEWORK_DATA_DIR at it."""
    tmpdir = tempfile.mkdtemp(prefix="needlework_test_")
    _test_dir_holder["path"] = tmpdir
    os.environ["NEEDLEWORK_DATA_DIR"] = tmpdir
    os.environ["DESKTOP_MODE"] = ""  # off by default
    os.environ["SECRET_KEY"] = "test-secret-key-for-pytest"
    yield tmpdir


@pytest.fixture(scope="session")
def base_db(test_db_dir):
    """Initialize schema and seed minimal data (runs once per session)."""
    db_path = os.path.join(test_db_dir, "dmc_threads.db")
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row

    # Read and execute schema
    schema_path = os.path.join(os.path.dirname(__file__), "..", "schema.sql")
    with open(schema_path) as f:
        conn.executescript(f.read())

    # Seed users
    from argon2 import PasswordHasher
    ph = PasswordHasher()
    pw_hash = ph.hash("testpassword")

    conn.execute(
        "INSERT INTO users (id, username, email, password_hash, is_active) VALUES (1, 'testuser', 'test@example.com', ?, 1)",
        (pw_hash,),
    )
    conn.execute(
        "INSERT INTO users (id, username, email, password_hash, is_active) VALUES (2, 'disableduser', 'disabled@example.com', ?, 0)",
        (ph.hash("disabledpass"),),
    )

    # Seed 3 DMC threads
    conn.execute("INSERT INTO threads (id, number, name, category, hex_color, brand) VALUES (1, '310', 'Black', 'Basic', '#000000', 'DMC')")
    conn.execute("INSERT INTO threads (id, number, name, category, hex_color, brand) VALUES (2, '666', 'Bright Red', 'Red', '#E31D42', 'DMC')")
    conn.execute("INSERT INTO threads (id, number, name, category, hex_color, brand) VALUES (3, '3865', 'Winter White', 'White', '#FAF6F0', 'DMC')")

    conn.commit()
    conn.close()
    return db_path


@pytest.fixture(scope="session")
def flask_app(base_db):
    """Import and configure the Flask app for testing."""
    import app as app_module

    app_module.app.config["TESTING"] = True
    app_module.app.config["WTF_CSRF_ENABLED"] = False
    app_module.app.config["LOGIN_DISABLED"] = False
    # Disable rate limiter
    app_module.limiter.enabled = False
    return app_module.app


_MUTABLE_TABLES = ("saved_patterns", "api_tokens", "sync_log", "user_thread_status")


@pytest.fixture(autouse=True)
def _clean_tables(base_db):
    """Truncate mutable tables before every test for isolation."""
    conn = sqlite3.connect(base_db)
    for table in _MUTABLE_TABLES:
        conn.execute(f"DELETE FROM {table}")
    conn.commit()
    conn.close()


@pytest.fixture()
def client(flask_app):
    """Flask test client."""
    with flask_app.test_client() as c:
        yield c


@pytest.fixture()
def db_conn(base_db):
    """Direct sqlite3 connection for asserting DB state."""
    conn = sqlite3.connect(base_db)
    conn.row_factory = sqlite3.Row
    yield conn
    conn.close()


def _create_api_token(db_path, user_id=1, name="Desktop Sync"):
    """Insert an API token and return the raw token string."""
    token = secrets.token_urlsafe(48)
    conn = sqlite3.connect(db_path)
    conn.execute(
        "INSERT INTO api_tokens (user_id, token, name) VALUES (?, ?, ?)",
        (user_id, token, name),
    )
    conn.commit()
    conn.close()
    return token


@pytest.fixture()
def auth_token(base_db):
    """Create an API token for testuser (id=1), return the raw token."""
    return _create_api_token(base_db, user_id=1)


@pytest.fixture()
def auth_headers(auth_token):
    """Bearer Authorization headers for testuser."""
    return {"Authorization": f"Bearer {auth_token}"}


@pytest.fixture()
def logged_in_client(flask_app, client, base_db):
    """A test client that is session-authenticated as testuser."""
    with flask_app.test_request_context():
        from flask_login import login_user
        import app as app_module

        user = app_module.User(1, "testuser", "test@example.com")

    # Use a session transaction to log in
    with client.session_transaction() as sess:
        sess["_user_id"] = "1"
    return client


def _make_pattern(slug="test-pattern", name="Test Pattern", updated_at="2025-01-01T12:00:00"):
    """Return a minimal valid pattern dict."""
    return {
        "slug": slug,
        "name": name,
        "grid_w": 10,
        "grid_h": 10,
        "color_count": 1,
        "grid_data": [[0] * 10] * 10,
        "legend_data": [{"dmc": "310", "hex": "#000000", "name": "Black", "symbol": "X"}],
        "thumbnail": None,
        "created_at": "2025-01-01T00:00:00",
        "updated_at": updated_at,
        "progress_data": None,
        "project_status": "not_started",
        "part_stitches_data": [],
        "backstitches_data": [],
        "knots_data": [],
        "brand": "DMC",
    }


@pytest.fixture()
def sample_pattern():
    """Return a factory for pattern dicts."""
    return _make_pattern


@pytest.fixture()
def insert_pattern(base_db):
    """Insert a pattern directly into the DB. Returns the slug."""

    def _insert(slug="test-pattern", user_id=1, name="Test Pattern",
                updated_at="2025-01-01T12:00:00", created_at="2025-01-01T00:00:00"):
        conn = sqlite3.connect(base_db)
        grid = json.dumps([[0] * 10] * 10)
        legend = json.dumps([{"dmc": "310", "hex": "#000000", "name": "Black", "symbol": "X"}])
        conn.execute(
            """INSERT INTO saved_patterns
                   (slug, user_id, name, grid_w, grid_h, color_count,
                    grid_data, legend_data, thumbnail, created_at, updated_at,
                    progress_data, project_status, part_stitches_data,
                    backstitches_data, knots_data, brand)
               VALUES (?, ?, ?, 10, 10, 1, ?, ?, NULL, ?, ?, NULL, 'not_started', '[]', '[]', '[]', 'DMC')""",
            (slug, user_id, name, grid, legend, created_at, updated_at),
        )
        conn.commit()
        conn.close()
        return slug

    return _insert
