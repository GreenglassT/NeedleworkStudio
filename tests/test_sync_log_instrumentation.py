"""Tests verifying existing routes write sync audit trail."""

import sqlite3


class TestPatternDeleteSyncLog:

    def test_pattern_delete_writes_sync_log(self, logged_in_client, insert_pattern, db_conn):
        insert_pattern(slug="del-me")
        resp = logged_in_client.delete("/api/saved-patterns/del-me")
        assert resp.status_code == 204
        row = db_conn.execute(
            "SELECT * FROM sync_log WHERE entity_type = 'pattern' AND entity_key = 'del-me'"
        ).fetchone()
        assert row is not None
        assert row["action"] == "delete"
        assert row["user_id"] == 1

    def test_batch_delete_writes_sync_log(self, logged_in_client, insert_pattern, db_conn):
        insert_pattern(slug="batch-1")
        insert_pattern(slug="batch-2")
        resp = logged_in_client.post(
            "/api/saved-patterns/batch",
            json={"action": "delete", "slugs": ["batch-1", "batch-2"]},
        )
        assert resp.status_code == 200
        rows = db_conn.execute(
            "SELECT entity_key FROM sync_log WHERE entity_type = 'pattern' AND action = 'delete'"
        ).fetchall()
        keys = {r["entity_key"] for r in rows}
        assert "batch-1" in keys
        assert "batch-2" in keys


class TestThreadStatusUpdatedAt:

    def test_thread_status_update_sets_updated_at(self, logged_in_client, db_conn):
        """UPDATE path: insert first, then update."""
        db_conn.execute(
            "INSERT INTO user_thread_status (user_id, thread_id, status, notes, skein_qty) "
            "VALUES (1, 1, 'need', '', 0)")
        db_conn.commit()
        resp = logged_in_client.patch(
            "/api/threads/1",
            json={"status": "own"},
        )
        assert resp.status_code == 200
        row = db_conn.execute(
            "SELECT updated_at FROM user_thread_status WHERE user_id = 1 AND thread_id = 1"
        ).fetchone()
        assert row["updated_at"] is not None

    def test_thread_status_insert_sets_updated_at(self, logged_in_client, db_conn):
        """INSERT path: no existing row."""
        resp = logged_in_client.patch(
            "/api/threads/1",
            json={"status": "own"},
        )
        assert resp.status_code == 200
        row = db_conn.execute(
            "SELECT updated_at FROM user_thread_status WHERE user_id = 1 AND thread_id = 1"
        ).fetchone()
        assert row is not None
        assert row["updated_at"] is not None
