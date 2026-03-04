"""Tests for the 5 server-side /api/sync/* endpoints."""

import json
import sqlite3

from tests.conftest import _create_api_token, _make_pattern


class TestSyncPair:
    """POST /api/sync/pair — exchange credentials for API token."""

    def test_valid_credentials_returns_token(self, client):
        resp = client.post("/api/sync/pair",
                           json={"username": "testuser", "password": "testpassword"})
        assert resp.status_code == 200
        data = resp.get_json()
        assert "token" in data
        assert data["username"] == "testuser"

    def test_creates_api_tokens_row(self, client, db_conn):
        client.post("/api/sync/pair",
                     json={"username": "testuser", "password": "testpassword"})
        row = db_conn.execute("SELECT * FROM api_tokens WHERE user_id = 1").fetchone()
        assert row is not None
        assert row["name"] == "Desktop Sync"

    def test_invalid_password_returns_401(self, client):
        resp = client.post("/api/sync/pair",
                           json={"username": "testuser", "password": "wrongpassword"})
        assert resp.status_code == 401

    def test_nonexistent_user_returns_401(self, client):
        resp = client.post("/api/sync/pair",
                           json={"username": "nouser", "password": "anything"})
        assert resp.status_code == 401

    def test_disabled_user_returns_403(self, client):
        resp = client.post("/api/sync/pair",
                           json={"username": "disableduser", "password": "disabledpass"})
        assert resp.status_code == 403

    def test_empty_fields_returns_400(self, client):
        resp = client.post("/api/sync/pair", json={"username": "", "password": ""})
        assert resp.status_code == 400

    def test_csrf_exempt(self, flask_app, base_db):
        """Pair endpoint works even with CSRF enabled."""
        original = flask_app.config.get("WTF_CSRF_ENABLED")
        flask_app.config["WTF_CSRF_ENABLED"] = True
        try:
            with flask_app.test_client() as c:
                resp = c.post("/api/sync/pair",
                              json={"username": "testuser", "password": "testpassword"})
                # Should not fail with CSRF error (400); 200 means success
                assert resp.status_code == 200
        finally:
            flask_app.config["WTF_CSRF_ENABLED"] = original if original is not None else False


class TestSyncUnpair:
    """POST /api/sync/unpair — revoke current token."""

    def test_deletes_token(self, client, auth_token, auth_headers, db_conn):
        resp = client.post("/api/sync/unpair", headers=auth_headers)
        assert resp.status_code == 204
        row = db_conn.execute("SELECT * FROM api_tokens WHERE token = ?",
                              (auth_token,)).fetchone()
        assert row is None

    def test_no_auth_returns_401(self, client):
        resp = client.post("/api/sync/unpair")
        assert resp.status_code == 401


class TestSyncChanges:
    """GET /api/sync/changes — delta manifest."""

    def test_empty_db_returns_empty(self, client, auth_headers):
        resp = client.get("/api/sync/changes?since=1970-01-01T00:00:00",
                          headers=auth_headers)
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["patterns"]["upserted"] == []
        assert data["patterns"]["deleted"] == []
        assert data["thread_statuses"]["upserted"] == []
        assert data["thread_statuses"]["deleted"] == []

    def test_returns_upserted_patterns(self, client, auth_headers, insert_pattern):
        insert_pattern(slug="p1", updated_at="2025-06-01T00:00:00")
        resp = client.get("/api/sync/changes?since=2025-01-01T00:00:00",
                          headers=auth_headers)
        data = resp.get_json()
        assert len(data["patterns"]["upserted"]) == 1
        assert data["patterns"]["upserted"][0]["slug"] == "p1"

    def test_returns_deleted_pattern_slugs(self, client, auth_headers, db_conn):
        db_conn.execute(
            "INSERT INTO sync_log (entity_type, entity_key, action, user_id) VALUES ('pattern', 'del-slug', 'delete', 1)")
        db_conn.commit()
        resp = client.get("/api/sync/changes?since=1970-01-01T00:00:00",
                          headers=auth_headers)
        data = resp.get_json()
        assert "del-slug" in data["patterns"]["deleted"]

    def test_returns_upserted_thread_statuses(self, client, auth_headers, db_conn):
        db_conn.execute(
            "INSERT INTO user_thread_status (user_id, thread_id, status, notes, skein_qty, updated_at) "
            "VALUES (1, 1, 'own', 'test note', 2, '2025-06-01T00:00:00')")
        db_conn.commit()
        resp = client.get("/api/sync/changes?since=2025-01-01T00:00:00",
                          headers=auth_headers)
        data = resp.get_json()
        assert len(data["thread_statuses"]["upserted"]) == 1
        assert data["thread_statuses"]["upserted"][0]["brand"] == "DMC"

    def test_returns_deleted_thread_status_keys(self, client, auth_headers, db_conn):
        db_conn.execute(
            "INSERT INTO sync_log (entity_type, entity_key, action, user_id) "
            "VALUES ('thread_status', 'DMC:310', 'delete', 1)")
        db_conn.commit()
        resp = client.get("/api/sync/changes?since=1970-01-01T00:00:00",
                          headers=auth_headers)
        data = resp.get_json()
        assert "DMC:310" in data["thread_statuses"]["deleted"]

    def test_respects_since_filter(self, client, auth_headers, insert_pattern):
        insert_pattern(slug="old", updated_at="2020-01-01T00:00:00")
        resp = client.get("/api/sync/changes?since=2025-01-01T00:00:00",
                          headers=auth_headers)
        data = resp.get_json()
        assert len(data["patterns"]["upserted"]) == 0

    def test_includes_server_time(self, client, auth_headers):
        resp = client.get("/api/sync/changes?since=1970-01-01T00:00:00",
                          headers=auth_headers)
        data = resp.get_json()
        assert data["server_time"]  # non-empty string

    def test_no_auth_returns_401(self, client):
        resp = client.get("/api/sync/changes")
        assert resp.status_code == 401


class TestSyncPatternDownload:
    """GET /api/sync/pattern/<slug> — full pattern data."""

    def test_returns_full_pattern(self, client, auth_headers, insert_pattern):
        insert_pattern(slug="dl-test")
        resp = client.get("/api/sync/pattern/dl-test", headers=auth_headers)
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["slug"] == "dl-test"
        # JSON fields should be parsed
        assert isinstance(data["grid_data"], list)
        assert isinstance(data["legend_data"], list)

    def test_missing_slug_returns_404(self, client, auth_headers):
        resp = client.get("/api/sync/pattern/nonexistent", headers=auth_headers)
        assert resp.status_code == 404

    def test_other_users_pattern_returns_404(self, client, auth_headers, base_db):
        """User 1's token should not access user 2's pattern."""
        conn = sqlite3.connect(base_db)
        grid = json.dumps([[0]])
        legend = json.dumps([])
        conn.execute(
            """INSERT INTO saved_patterns
                   (slug, user_id, name, grid_w, grid_h, color_count,
                    grid_data, legend_data, created_at, updated_at, brand)
               VALUES ('other-user-pat', 2, 'Other', 1, 1, 0, ?, ?, '2025-01-01', '2025-01-01', 'DMC')""",
            (grid, legend))
        conn.commit()
        conn.close()
        resp = client.get("/api/sync/pattern/other-user-pat", headers=auth_headers)
        assert resp.status_code == 404

    def test_no_auth_returns_401(self, client):
        resp = client.get("/api/sync/pattern/anything")
        assert resp.status_code == 401


class TestSyncPush:
    """POST /api/sync/push — batch push from desktop."""

    def test_creates_new_pattern(self, client, auth_headers, db_conn):
        pattern = _make_pattern(slug="new-pat", updated_at="2025-06-01T00:00:00")
        payload = {
            "patterns": {"upsert": [pattern], "delete": []},
            "thread_statuses": {"upsert": [], "delete": []},
        }
        resp = client.post("/api/sync/push", json=payload, headers=auth_headers)
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["patterns_created"] == 1
        row = db_conn.execute("SELECT * FROM saved_patterns WHERE slug = 'new-pat'").fetchone()
        assert row is not None

    def test_updates_existing_when_newer(self, client, auth_headers, insert_pattern, db_conn):
        insert_pattern(slug="up-pat", updated_at="2025-01-01T00:00:00")
        pattern = _make_pattern(slug="up-pat", name="Updated Name", updated_at="2025-06-01T00:00:00")
        payload = {
            "patterns": {"upsert": [pattern], "delete": []},
            "thread_statuses": {"upsert": [], "delete": []},
        }
        resp = client.post("/api/sync/push", json=payload, headers=auth_headers)
        assert resp.status_code == 200
        assert resp.get_json()["patterns_updated"] == 1
        row = db_conn.execute("SELECT name FROM saved_patterns WHERE slug = 'up-pat'").fetchone()
        assert row["name"] == "Updated Name"

    def test_skips_existing_when_older(self, client, auth_headers, insert_pattern):
        insert_pattern(slug="skip-pat", updated_at="2025-06-01T00:00:00")
        pattern = _make_pattern(slug="skip-pat", updated_at="2025-01-01T00:00:00")
        payload = {
            "patterns": {"upsert": [pattern], "delete": []},
            "thread_statuses": {"upsert": [], "delete": []},
        }
        resp = client.post("/api/sync/push", json=payload, headers=auth_headers)
        assert resp.status_code == 200
        assert resp.get_json()["patterns_skipped"] == 1

    def test_deletes_pattern_when_deleted_at_newer(self, client, auth_headers, insert_pattern, db_conn):
        insert_pattern(slug="del-pat", updated_at="2025-01-01T00:00:00")
        payload = {
            "patterns": {
                "upsert": [],
                "delete": [{"slug": "del-pat", "deleted_at": "2025-06-01T00:00:00"}],
            },
            "thread_statuses": {"upsert": [], "delete": []},
        }
        resp = client.post("/api/sync/push", json=payload, headers=auth_headers)
        assert resp.status_code == 200
        assert resp.get_json()["patterns_deleted"] == 1
        row = db_conn.execute("SELECT * FROM saved_patterns WHERE slug = 'del-pat'").fetchone()
        assert row is None

    def test_creates_thread_status(self, client, auth_headers, db_conn):
        payload = {
            "patterns": {"upsert": [], "delete": []},
            "thread_statuses": {
                "upsert": [{"brand": "DMC", "number": "310", "status": "own",
                            "notes": "nice", "skein_qty": 3, "updated_at": "2025-06-01T00:00:00"}],
                "delete": [],
            },
        }
        resp = client.post("/api/sync/push", json=payload, headers=auth_headers)
        assert resp.status_code == 200
        assert resp.get_json()["threads_created"] == 1
        row = db_conn.execute(
            "SELECT * FROM user_thread_status WHERE user_id = 1 AND thread_id = 1").fetchone()
        assert row["status"] == "own"

    def test_updates_thread_status_when_newer(self, client, auth_headers, db_conn):
        db_conn.execute(
            "INSERT INTO user_thread_status (user_id, thread_id, status, notes, skein_qty, updated_at) "
            "VALUES (1, 1, 'need', '', 0, '2025-01-01T00:00:00')")
        db_conn.commit()
        payload = {
            "patterns": {"upsert": [], "delete": []},
            "thread_statuses": {
                "upsert": [{"brand": "DMC", "number": "310", "status": "own",
                            "notes": "updated", "skein_qty": 5, "updated_at": "2025-06-01T00:00:00"}],
                "delete": [],
            },
        }
        resp = client.post("/api/sync/push", json=payload, headers=auth_headers)
        assert resp.status_code == 200
        assert resp.get_json()["threads_updated"] == 1

    def test_skips_thread_status_when_older(self, client, auth_headers, db_conn):
        db_conn.execute(
            "INSERT INTO user_thread_status (user_id, thread_id, status, notes, skein_qty, updated_at) "
            "VALUES (1, 1, 'own', '', 0, '2025-06-01T00:00:00')")
        db_conn.commit()
        payload = {
            "patterns": {"upsert": [], "delete": []},
            "thread_statuses": {
                "upsert": [{"brand": "DMC", "number": "310", "status": "need",
                            "notes": "", "skein_qty": 0, "updated_at": "2025-01-01T00:00:00"}],
                "delete": [],
            },
        }
        resp = client.post("/api/sync/push", json=payload, headers=auth_headers)
        assert resp.status_code == 200
        assert resp.get_json()["threads_skipped"] == 1

    def test_deletes_thread_status(self, client, auth_headers, db_conn):
        db_conn.execute(
            "INSERT INTO user_thread_status (user_id, thread_id, status, notes, skein_qty, updated_at) "
            "VALUES (1, 1, 'own', '', 0, '2025-01-01T00:00:00')")
        db_conn.commit()
        payload = {
            "patterns": {"upsert": [], "delete": []},
            "thread_statuses": {
                "upsert": [],
                "delete": [{"key": "DMC:310", "deleted_at": "2025-06-01T00:00:00"}],
            },
        }
        resp = client.post("/api/sync/push", json=payload, headers=auth_headers)
        assert resp.status_code == 200
        assert resp.get_json()["threads_deleted"] == 1

    def test_ignores_unknown_thread_combo(self, client, auth_headers):
        payload = {
            "patterns": {"upsert": [], "delete": []},
            "thread_statuses": {
                "upsert": [{"brand": "UNKNOWN", "number": "999", "status": "own",
                            "notes": "", "skein_qty": 0, "updated_at": "2025-06-01T00:00:00"}],
                "delete": [],
            },
        }
        resp = client.post("/api/sync/push", json=payload, headers=auth_headers)
        assert resp.status_code == 200
        # Nothing created for unknown brand/number
        assert resp.get_json()["threads_created"] == 0

    def test_returns_server_time(self, client, auth_headers):
        payload = {
            "patterns": {"upsert": [], "delete": []},
            "thread_statuses": {"upsert": [], "delete": []},
        }
        resp = client.post("/api/sync/push", json=payload, headers=auth_headers)
        assert resp.status_code == 200
        assert resp.get_json()["server_time"]

    def test_no_auth_returns_401(self, client):
        resp = client.post("/api/sync/push", json={})
        assert resp.status_code == 401
