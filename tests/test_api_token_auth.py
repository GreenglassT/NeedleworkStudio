"""Tests for the @api_token_required decorator (app.py:338)."""

import sqlite3

from tests.conftest import _create_api_token


class TestApiTokenAuth:
    """Verify Bearer token authentication on sync endpoints."""

    def test_valid_token_authenticates_user(self, client, auth_headers):
        """Bearer token → user loaded, 200 response."""
        resp = client.get("/api/sync/changes?since=1970-01-01T00:00:00",
                          headers=auth_headers)
        assert resp.status_code == 200
        data = resp.get_json()
        assert "server_time" in data

    def test_missing_authorization_header_returns_401(self, client):
        """No header → 401."""
        resp = client.get("/api/sync/changes")
        assert resp.status_code == 401

    def test_non_bearer_scheme_returns_401(self, client):
        """Authorization: Basic xxx → 401."""
        resp = client.get("/api/sync/changes",
                          headers={"Authorization": "Basic dXNlcjpwYXNz"})
        assert resp.status_code == 401

    def test_invalid_token_returns_401(self, client):
        """Bogus token string → 401."""
        resp = client.get("/api/sync/changes",
                          headers={"Authorization": "Bearer bogus-token-xyz"})
        assert resp.status_code == 401

    def test_disabled_user_token_returns_403(self, client, base_db):
        """Token for is_active=0 user → 403."""
        token = _create_api_token(base_db, user_id=2)  # disableduser
        resp = client.get("/api/sync/changes",
                          headers={"Authorization": f"Bearer {token}"})
        assert resp.status_code == 403

    def test_token_last_used_at_updated(self, client, auth_token, base_db):
        """After request, last_used_at is set."""
        client.get("/api/sync/changes", headers={"Authorization": f"Bearer {auth_token}"})
        conn = sqlite3.connect(base_db)
        conn.row_factory = sqlite3.Row
        row = conn.execute("SELECT last_used_at FROM api_tokens WHERE token = ?",
                           (auth_token,)).fetchone()
        conn.close()
        assert row["last_used_at"] is not None
