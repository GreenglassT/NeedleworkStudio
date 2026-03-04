"""Tests for CLI token management functions in manage_users.py."""

import sqlite3
import io


class TestListTokens:

    def test_list_tokens_shows_all(self, base_db, mocker, capsys):
        # Insert a test token
        conn = sqlite3.connect(base_db)
        conn.execute(
            "INSERT INTO api_tokens (user_id, token, name) VALUES (1, 'abcd1234efgh5678', 'Desktop Sync')")
        conn.commit()
        conn.close()

        import manage_users
        mocker.patch.object(manage_users, "DB_PATH", base_db)
        manage_users.list_tokens()

        captured = capsys.readouterr()
        assert "testuser" in captured.out
        assert "abcd" in captured.out  # first 4 chars
        assert "5678" in captured.out  # last 4 chars

    def test_list_tokens_empty(self, base_db, mocker, capsys):
        import manage_users
        mocker.patch.object(manage_users, "DB_PATH", base_db)
        manage_users.list_tokens()

        captured = capsys.readouterr()
        assert "No API tokens found" in captured.out


class TestRevokeToken:

    def test_revoke_token_deletes(self, base_db, mocker, capsys):
        conn = sqlite3.connect(base_db)
        conn.execute(
            "INSERT INTO api_tokens (id, user_id, token, name) VALUES (99, 1, 'revoke-me-token', 'Test')")
        conn.commit()
        conn.close()

        import manage_users
        mocker.patch.object(manage_users, "DB_PATH", base_db)
        mocker.patch("builtins.input", return_value="99")

        result = manage_users.revoke_token()
        assert result is True

        conn = sqlite3.connect(base_db)
        row = conn.execute("SELECT * FROM api_tokens WHERE id = 99").fetchone()
        conn.close()
        assert row is None

    def test_revoke_invalid_id(self, base_db, mocker, capsys):
        import manage_users
        mocker.patch.object(manage_users, "DB_PATH", base_db)
        mocker.patch("builtins.input", return_value="99999")

        result = manage_users.revoke_token()
        assert result is False

        captured = capsys.readouterr()
        assert "not found" in captured.out
