"""Tests for _migrate_sync_tables() schema migration."""

import os
import sqlite3
import tempfile


class TestMigrateSyncTables:

    def _make_minimal_db(self):
        """Create a minimal DB with users and user_thread_status but NO sync tables."""
        tmpdir = tempfile.mkdtemp(prefix="migrate_test_")
        db_path = os.path.join(tmpdir, "test.db")
        conn = sqlite3.connect(db_path)
        conn.execute("""
            CREATE TABLE users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                is_active INTEGER DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_login TIMESTAMP
            )
        """)
        # user_thread_status WITHOUT updated_at column
        conn.execute("""
            CREATE TABLE user_thread_status (
                user_id INTEGER NOT NULL,
                thread_id INTEGER NOT NULL,
                status TEXT DEFAULT 'dont_own',
                notes TEXT DEFAULT '',
                skein_qty REAL DEFAULT 0,
                PRIMARY KEY (user_id, thread_id)
            )
        """)
        conn.commit()
        conn.close()
        return db_path, tmpdir

    def test_creates_api_tokens_table(self, flask_app):
        db_path, tmpdir = self._make_minimal_db()
        import app as app_module
        original_db_path = app_module.DB_PATH

        # Temporarily point at our test DB
        app_module.DB_PATH = db_path
        try:
            with flask_app.app_context():
                app_module._migrate_sync_tables()

            conn = sqlite3.connect(db_path)
            tables = [r[0] for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
            assert "api_tokens" in tables

            cols = [r[1] for r in conn.execute("PRAGMA table_info(api_tokens)").fetchall()]
            assert "token" in cols
            assert "user_id" in cols
            assert "last_used_at" in cols
            conn.close()
        finally:
            app_module.DB_PATH = original_db_path

    def test_creates_sync_log_table(self, flask_app):
        db_path, tmpdir = self._make_minimal_db()
        import app as app_module
        original_db_path = app_module.DB_PATH

        app_module.DB_PATH = db_path
        try:
            with flask_app.app_context():
                app_module._migrate_sync_tables()

            conn = sqlite3.connect(db_path)
            tables = [r[0] for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
            assert "sync_log" in tables

            cols = [r[1] for r in conn.execute("PRAGMA table_info(sync_log)").fetchall()]
            assert "entity_type" in cols
            assert "entity_key" in cols
            assert "action" in cols
            assert "timestamp" in cols
            conn.close()
        finally:
            app_module.DB_PATH = original_db_path

    def test_adds_updated_at_to_user_thread_status(self, flask_app):
        db_path, tmpdir = self._make_minimal_db()
        import app as app_module
        original_db_path = app_module.DB_PATH

        app_module.DB_PATH = db_path
        try:
            with flask_app.app_context():
                app_module._migrate_sync_tables()

            conn = sqlite3.connect(db_path)
            cols = [r[1] for r in conn.execute(
                "PRAGMA table_info(user_thread_status)").fetchall()]
            assert "updated_at" in cols
            conn.close()
        finally:
            app_module.DB_PATH = original_db_path
