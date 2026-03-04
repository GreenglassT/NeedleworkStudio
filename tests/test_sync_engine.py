"""Tests for SyncEngine class (sync_engine.py). All HTTP mocked."""

import json
import sqlite3

import pytest
import requests

from sync_engine import SyncEngine
from tests.conftest import _make_pattern


def _engine(base_db):
    """Create a SyncEngine instance pointed at a fake server."""
    return SyncEngine("https://remote.example.com", "fake-token", base_db)


def _insert_pattern_direct(db_path, slug="local-pat", user_id=1,
                           updated_at="2025-01-01T00:00:00"):
    conn = sqlite3.connect(db_path)
    grid = json.dumps([[0] * 10] * 10)
    legend = json.dumps([{"dmc": "310"}])
    conn.execute(
        """INSERT INTO saved_patterns
               (slug, user_id, name, grid_w, grid_h, color_count,
                grid_data, legend_data, created_at, updated_at, brand)
           VALUES (?, ?, 'Test', 10, 10, 1, ?, ?, '2025-01-01', ?, 'DMC')""",
        (slug, user_id, grid, legend, updated_at))
    conn.commit()
    conn.close()


class TestPull:
    """SyncEngine._pull tests."""

    def test_inserts_new_pattern(self, base_db, mocker):
        engine = _engine(base_db)
        changes_data = {
            "server_time": "2025-06-01T12:00:00",
            "patterns": {
                "upserted": [{"slug": "remote-new", "updated_at": "2025-06-01T00:00:00"}],
                "deleted": [],
            },
            "thread_statuses": {"upserted": [], "deleted": []},
        }
        full_pattern = _make_pattern(slug="remote-new", updated_at="2025-06-01T00:00:00")

        mock_get = mocker.patch("sync_engine.requests.get")
        changes_resp = mocker.Mock()
        changes_resp.status_code = 200
        changes_resp.json.return_value = changes_data

        full_resp = mocker.Mock()
        full_resp.status_code = 200
        full_resp.json.return_value = full_pattern

        mock_get.side_effect = [changes_resp, full_resp]

        result = engine._pull("1970-01-01T00:00:00", user_id=1)
        assert result["patterns_pulled"] == 1

        conn = sqlite3.connect(base_db)
        conn.row_factory = sqlite3.Row
        row = conn.execute("SELECT * FROM saved_patterns WHERE slug = 'remote-new'").fetchone()
        conn.close()
        assert row is not None

    def test_updates_existing_when_server_newer(self, base_db, mocker):
        _insert_pattern_direct(base_db, slug="exist-pat", updated_at="2025-01-01T00:00:00")
        engine = _engine(base_db)

        changes_data = {
            "server_time": "2025-06-01T12:00:00",
            "patterns": {
                "upserted": [{"slug": "exist-pat", "updated_at": "2025-06-01T00:00:00"}],
                "deleted": [],
            },
            "thread_statuses": {"upserted": [], "deleted": []},
        }
        full_pattern = _make_pattern(slug="exist-pat", name="Server Updated", updated_at="2025-06-01T00:00:00")

        mock_get = mocker.patch("sync_engine.requests.get")
        mock_get.side_effect = [
            mocker.Mock(status_code=200, json=lambda: changes_data),
            mocker.Mock(status_code=200, json=lambda: full_pattern),
        ]

        result = engine._pull("1970-01-01T00:00:00", user_id=1)
        assert result["patterns_pulled"] == 1

        conn = sqlite3.connect(base_db)
        conn.row_factory = sqlite3.Row
        row = conn.execute("SELECT name FROM saved_patterns WHERE slug = 'exist-pat' AND user_id = 1").fetchone()
        conn.close()
        assert row["name"] == "Server Updated"

    def test_skips_when_local_newer(self, base_db, mocker):
        _insert_pattern_direct(base_db, slug="newer-local", updated_at="2025-06-01T00:00:00")
        engine = _engine(base_db)

        changes_data = {
            "server_time": "2025-06-01T12:00:00",
            "patterns": {
                "upserted": [{"slug": "newer-local", "updated_at": "2025-01-01T00:00:00"}],
                "deleted": [],
            },
            "thread_statuses": {"upserted": [], "deleted": []},
        }

        mock_get = mocker.patch("sync_engine.requests.get")
        mock_get.return_value = mocker.Mock(status_code=200, json=lambda: changes_data)

        result = engine._pull("1970-01-01T00:00:00", user_id=1)
        assert result["patterns_pulled"] == 0

    def test_deletes_pattern(self, base_db, mocker):
        _insert_pattern_direct(base_db, slug="to-delete")
        engine = _engine(base_db)

        changes_data = {
            "server_time": "2025-06-01T12:00:00",
            "patterns": {"upserted": [], "deleted": ["to-delete"]},
            "thread_statuses": {"upserted": [], "deleted": []},
        }

        mock_get = mocker.patch("sync_engine.requests.get")
        mock_get.return_value = mocker.Mock(status_code=200, json=lambda: changes_data)

        result = engine._pull("1970-01-01T00:00:00", user_id=1)
        assert result["patterns_deleted"] == 1

        conn = sqlite3.connect(base_db)
        row = conn.execute("SELECT * FROM saved_patterns WHERE slug = 'to-delete'").fetchone()
        conn.close()
        assert row is None

    def test_creates_thread_status(self, base_db, mocker):
        engine = _engine(base_db)
        changes_data = {
            "server_time": "2025-06-01T12:00:00",
            "patterns": {"upserted": [], "deleted": []},
            "thread_statuses": {
                "upserted": [{"brand": "DMC", "number": "310", "status": "own",
                              "notes": "from server", "skein_qty": 2,
                              "updated_at": "2025-06-01T00:00:00"}],
                "deleted": [],
            },
        }

        mock_get = mocker.patch("sync_engine.requests.get")
        mock_get.return_value = mocker.Mock(status_code=200, json=lambda: changes_data)

        result = engine._pull("1970-01-01T00:00:00", user_id=1)
        assert result["threads_pulled"] == 1

        conn = sqlite3.connect(base_db)
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT * FROM user_thread_status WHERE user_id = 1 AND thread_id = 1").fetchone()
        conn.close()
        assert row["status"] == "own"

    def test_updates_thread_status_when_newer(self, base_db, mocker):
        conn = sqlite3.connect(base_db)
        conn.execute(
            "INSERT INTO user_thread_status (user_id, thread_id, status, notes, skein_qty, updated_at) "
            "VALUES (1, 1, 'need', '', 0, '2025-01-01T00:00:00')")
        conn.commit()
        conn.close()

        engine = _engine(base_db)
        changes_data = {
            "server_time": "2025-06-01T12:00:00",
            "patterns": {"upserted": [], "deleted": []},
            "thread_statuses": {
                "upserted": [{"brand": "DMC", "number": "310", "status": "own",
                              "notes": "updated", "skein_qty": 5,
                              "updated_at": "2025-06-01T00:00:00"}],
                "deleted": [],
            },
        }

        mock_get = mocker.patch("sync_engine.requests.get")
        mock_get.return_value = mocker.Mock(status_code=200, json=lambda: changes_data)

        result = engine._pull("1970-01-01T00:00:00", user_id=1)
        assert result["threads_pulled"] == 1

    def test_skips_thread_status_when_local_newer(self, base_db, mocker):
        conn = sqlite3.connect(base_db)
        conn.execute(
            "INSERT INTO user_thread_status (user_id, thread_id, status, notes, skein_qty, updated_at) "
            "VALUES (1, 1, 'own', '', 0, '2025-06-01T00:00:00')")
        conn.commit()
        conn.close()

        engine = _engine(base_db)
        changes_data = {
            "server_time": "2025-06-01T12:00:00",
            "patterns": {"upserted": [], "deleted": []},
            "thread_statuses": {
                "upserted": [{"brand": "DMC", "number": "310", "status": "need",
                              "notes": "", "skein_qty": 0,
                              "updated_at": "2025-01-01T00:00:00"}],
                "deleted": [],
            },
        }

        mock_get = mocker.patch("sync_engine.requests.get")
        mock_get.return_value = mocker.Mock(status_code=200, json=lambda: changes_data)

        result = engine._pull("1970-01-01T00:00:00", user_id=1)
        assert result["threads_pulled"] == 0

    def test_deletes_thread_status(self, base_db, mocker):
        conn = sqlite3.connect(base_db)
        conn.execute(
            "INSERT INTO user_thread_status (user_id, thread_id, status, notes, skein_qty, updated_at) "
            "VALUES (1, 1, 'own', '', 0, '2025-01-01T00:00:00')")
        conn.commit()
        conn.close()

        engine = _engine(base_db)
        changes_data = {
            "server_time": "2025-06-01T12:00:00",
            "patterns": {"upserted": [], "deleted": []},
            "thread_statuses": {"upserted": [], "deleted": ["DMC:310"]},
        }

        mock_get = mocker.patch("sync_engine.requests.get")
        mock_get.return_value = mocker.Mock(status_code=200, json=lambda: changes_data)

        result = engine._pull("1970-01-01T00:00:00", user_id=1)
        assert result["threads_deleted"] == 1

    def test_skips_unknown_thread_silently(self, base_db, mocker):
        engine = _engine(base_db)
        changes_data = {
            "server_time": "2025-06-01T12:00:00",
            "patterns": {"upserted": [], "deleted": []},
            "thread_statuses": {
                "upserted": [{"brand": "UNKNOWN", "number": "999", "status": "own",
                              "notes": "", "skein_qty": 0,
                              "updated_at": "2025-06-01T00:00:00"}],
                "deleted": [],
            },
        }

        mock_get = mocker.patch("sync_engine.requests.get")
        mock_get.return_value = mocker.Mock(status_code=200, json=lambda: changes_data)

        result = engine._pull("1970-01-01T00:00:00", user_id=1)
        assert result["threads_pulled"] == 0

    def test_returns_error_on_non_200(self, base_db, mocker):
        engine = _engine(base_db)
        mock_get = mocker.patch("sync_engine.requests.get")
        mock_get.return_value = mocker.Mock(status_code=500, text="Internal Server Error")

        result = engine._pull("1970-01-01T00:00:00", user_id=1)
        assert "error" in result


class TestPush:
    """SyncEngine._push tests."""

    def test_sends_modified_patterns(self, base_db, mocker):
        _insert_pattern_direct(base_db, slug="push-pat", updated_at="2025-06-01T00:00:00")
        engine = _engine(base_db)

        mock_post = mocker.patch("sync_engine.requests.post")
        mock_post.return_value = mocker.Mock(
            status_code=200,
            json=lambda: {"server_time": "2025-06-01T12:00:00"})

        result = engine._push("2025-01-01T00:00:00", user_id=1)
        assert "server_time" in result

        call_args = mock_post.call_args
        payload = call_args.kwargs.get("json") or call_args[1].get("json")
        assert len(payload["patterns"]["upsert"]) == 1
        assert payload["patterns"]["upsert"][0]["slug"] == "push-pat"

    def test_sends_delete_log_entries(self, base_db, mocker):
        conn = sqlite3.connect(base_db)
        conn.execute(
            "INSERT INTO sync_log (entity_type, entity_key, action, user_id, timestamp) "
            "VALUES ('pattern', 'deleted-slug', 'delete', 1, '2025-06-01T00:00:00')")
        conn.commit()
        conn.close()

        engine = _engine(base_db)
        mock_post = mocker.patch("sync_engine.requests.post")
        mock_post.return_value = mocker.Mock(
            status_code=200,
            json=lambda: {"server_time": "2025-06-01T12:00:00"})

        engine._push("2025-01-01T00:00:00", user_id=1)
        call_args = mock_post.call_args
        payload = call_args.kwargs.get("json") or call_args[1].get("json")
        assert len(payload["patterns"]["delete"]) == 1
        assert payload["patterns"]["delete"][0]["slug"] == "deleted-slug"

    def test_sends_thread_status_changes(self, base_db, mocker):
        conn = sqlite3.connect(base_db)
        conn.execute(
            "INSERT INTO user_thread_status (user_id, thread_id, status, notes, skein_qty, updated_at) "
            "VALUES (1, 1, 'own', 'test', 3, '2025-06-01T00:00:00')")
        conn.commit()
        conn.close()

        engine = _engine(base_db)
        mock_post = mocker.patch("sync_engine.requests.post")
        mock_post.return_value = mocker.Mock(
            status_code=200,
            json=lambda: {"server_time": "2025-06-01T12:00:00"})

        engine._push("2025-01-01T00:00:00", user_id=1)
        call_args = mock_post.call_args
        payload = call_args.kwargs.get("json") or call_args[1].get("json")
        assert len(payload["thread_statuses"]["upsert"]) == 1

    def test_returns_error_on_non_200(self, base_db, mocker):
        engine = _engine(base_db)
        mock_post = mocker.patch("sync_engine.requests.post")
        mock_post.return_value = mocker.Mock(status_code=500, text="Server Error")

        result = engine._push("1970-01-01T00:00:00", user_id=1)
        assert "error" in result


class TestSync:
    """SyncEngine.sync integration tests."""

    def test_runs_pull_then_push(self, base_db, mocker):
        engine = _engine(base_db)

        mock_get = mocker.patch("sync_engine.requests.get")
        mock_get.return_value = mocker.Mock(status_code=200, json=lambda: {
            "server_time": "2025-06-01T12:00:00",
            "patterns": {"upserted": [], "deleted": []},
            "thread_statuses": {"upserted": [], "deleted": []},
        })

        mock_post = mocker.patch("sync_engine.requests.post")
        mock_post.return_value = mocker.Mock(status_code=200, json=lambda: {
            "server_time": "2025-06-01T12:00:01",
        })

        result = engine.sync(None, user_id=1)
        assert "pull" in result
        assert "push" in result
        assert result["server_time"]

    def test_returns_error_on_connection_error(self, base_db, mocker):
        engine = _engine(base_db)
        mocker.patch("sync_engine.requests.get", side_effect=requests.ConnectionError())

        result = engine.sync(None, user_id=1)
        assert "error" in result
        assert "Could not connect" in result["error"]

    def test_returns_error_on_timeout(self, base_db, mocker):
        engine = _engine(base_db)
        mocker.patch("sync_engine.requests.get", side_effect=requests.Timeout())

        result = engine.sync(None, user_id=1)
        assert "error" in result
        assert "timed out" in result["error"]

    def test_uses_epoch_when_last_sync_none(self, base_db, mocker):
        engine = _engine(base_db)

        mock_get = mocker.patch("sync_engine.requests.get")
        mock_get.return_value = mocker.Mock(status_code=200, json=lambda: {
            "server_time": "2025-06-01T12:00:00",
            "patterns": {"upserted": [], "deleted": []},
            "thread_statuses": {"upserted": [], "deleted": []},
        })

        mock_post = mocker.patch("sync_engine.requests.post")
        mock_post.return_value = mocker.Mock(status_code=200, json=lambda: {
            "server_time": "2025-06-01T12:00:01",
        })

        engine.sync(None, user_id=1)
        # Pull should have been called with epoch
        call_args = mock_get.call_args
        assert "1970-01-01T00:00:00" in str(call_args)
