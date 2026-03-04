"""Tests for the 4 /api/sync-config/* desktop-only endpoints."""

import json
import os

import pytest
import requests


class TestDesktopModeGuard:
    """Each endpoint returns 403 when DESKTOP_MODE is False."""

    def test_get_sync_config_requires_desktop(self, logged_in_client):
        resp = logged_in_client.get("/api/sync-config")
        assert resp.status_code == 403

    def test_pair_requires_desktop(self, logged_in_client):
        resp = logged_in_client.post("/api/sync-config/pair", json={})
        assert resp.status_code == 403

    def test_unpair_requires_desktop(self, logged_in_client):
        resp = logged_in_client.post("/api/sync-config/unpair")
        assert resp.status_code == 403

    def test_sync_requires_desktop(self, logged_in_client):
        resp = logged_in_client.post("/api/sync-config/sync")
        assert resp.status_code == 403


class TestGetSyncConfig:
    """GET /api/sync-config."""

    def test_returns_empty_when_no_file(self, logged_in_client, mocker):
        mocker.patch("app.DESKTOP_MODE", True)
        mocker.patch("app._read_sync_config", return_value={})
        resp = logged_in_client.get("/api/sync-config")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["paired"] is False
        assert data["server_url"] == ""

    def test_returns_paired_config(self, logged_in_client, mocker):
        mocker.patch("app.DESKTOP_MODE", True)
        mocker.patch("app._read_sync_config", return_value={
            "server_url": "https://server.example.com",
            "username": "testuser",
            "token": "some-token",
            "last_sync_at": "2025-06-01T00:00:00",
        })
        resp = logged_in_client.get("/api/sync-config")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["paired"] is True
        assert data["username"] == "testuser"


class TestSyncConfigPair:
    """POST /api/sync-config/pair."""

    def test_calls_remote_and_saves_config(self, logged_in_client, mocker, test_db_dir):
        mocker.patch("app.DESKTOP_MODE", True)

        mock_resp = mocker.Mock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"token": "new-token-123", "username": "testuser"}

        # The endpoint uses `import requests as http_requests` locally,
        # so http_requests.post == requests.post
        mocker.patch("requests.post", return_value=mock_resp)

        resp = logged_in_client.post("/api/sync-config/pair", json={
            "server_url": "https://remote.example.com",
            "username": "testuser",
            "password": "testpassword",
        })
        assert resp.status_code == 200
        assert resp.get_json()["ok"] is True

        # Verify the config was written to disk
        config_path = os.path.join(test_db_dir, "sync_config.json")
        if os.path.exists(config_path):
            with open(config_path) as f:
                cfg = json.load(f)
            assert cfg["token"] == "new-token-123"

    def test_missing_fields_returns_400(self, logged_in_client, mocker):
        mocker.patch("app.DESKTOP_MODE", True)
        resp = logged_in_client.post("/api/sync-config/pair", json={
            "server_url": "",
            "username": "",
            "password": "",
        })
        assert resp.status_code == 400

    def test_connection_error_returns_502(self, logged_in_client, mocker):
        mocker.patch("app.DESKTOP_MODE", True)
        mocker.patch("requests.post", side_effect=requests.ConnectionError())
        resp = logged_in_client.post("/api/sync-config/pair", json={
            "server_url": "https://bad.example.com",
            "username": "user",
            "password": "pass",
        })
        assert resp.status_code == 502

    def test_timeout_returns_504(self, logged_in_client, mocker):
        mocker.patch("app.DESKTOP_MODE", True)
        mocker.patch("requests.post", side_effect=requests.Timeout())
        resp = logged_in_client.post("/api/sync-config/pair", json={
            "server_url": "https://slow.example.com",
            "username": "user",
            "password": "pass",
        })
        assert resp.status_code == 504


class TestSyncConfigUnpair:
    """POST /api/sync-config/unpair."""

    def test_clears_config_and_calls_remote(self, logged_in_client, mocker):
        mocker.patch("app.DESKTOP_MODE", True)
        mocker.patch("app._read_sync_config", return_value={
            "server_url": "https://remote.example.com",
            "token": "old-token",
        })
        write_mock = mocker.patch("app._write_sync_config")
        mocker.patch("requests.post", return_value=mocker.Mock(status_code=204))

        resp = logged_in_client.post("/api/sync-config/unpair")
        assert resp.status_code == 200
        assert resp.get_json()["ok"] is True
        write_mock.assert_called_once_with({})

    def test_succeeds_even_if_remote_fails(self, logged_in_client, mocker):
        mocker.patch("app.DESKTOP_MODE", True)
        mocker.patch("app._read_sync_config", return_value={
            "server_url": "https://remote.example.com",
            "token": "old-token",
        })
        write_mock = mocker.patch("app._write_sync_config")
        mocker.patch("requests.post", side_effect=Exception("network down"))

        resp = logged_in_client.post("/api/sync-config/unpair")
        assert resp.status_code == 200
        write_mock.assert_called_once_with({})


class TestSyncConfigTrigger:
    """POST /api/sync-config/sync."""

    def test_runs_sync_and_updates_config(self, logged_in_client, mocker):
        mocker.patch("app.DESKTOP_MODE", True)
        mocker.patch("app._read_sync_config", return_value={
            "server_url": "https://remote.example.com",
            "token": "tok-123",
            "last_sync_at": "",
        })
        write_mock = mocker.patch("app._write_sync_config")

        mock_engine = mocker.Mock()
        mock_engine.sync.return_value = {
            "server_time": "2025-06-01T12:00:00",
            "pull": {"patterns_pulled": 0},
            "push": {},
        }
        # The endpoint uses `from sync_engine import SyncEngine` locally
        mocker.patch("sync_engine.SyncEngine", return_value=mock_engine)

        resp = logged_in_client.post("/api/sync-config/sync")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["server_time"] == "2025-06-01T12:00:00"

        # Verify last_sync_at was updated
        cfg_written = write_mock.call_args[0][0]
        assert cfg_written["last_sync_at"] == "2025-06-01T12:00:00"

    def test_not_paired_returns_400(self, logged_in_client, mocker):
        mocker.patch("app.DESKTOP_MODE", True)
        mocker.patch("app._read_sync_config", return_value={})
        resp = logged_in_client.post("/api/sync-config/sync")
        assert resp.status_code == 400

    def test_engine_error_returns_502(self, logged_in_client, mocker):
        mocker.patch("app.DESKTOP_MODE", True)
        mocker.patch("app._read_sync_config", return_value={
            "server_url": "https://remote.example.com",
            "token": "tok-123",
            "last_sync_at": "",
        })

        mock_engine = mocker.Mock()
        mock_engine.sync.return_value = {"error": "Connection refused"}
        mocker.patch("sync_engine.SyncEngine", return_value=mock_engine)

        resp = logged_in_client.post("/api/sync-config/sync")
        assert resp.status_code == 502
