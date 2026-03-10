"""Desktop-side sync engine for bidirectional sync with a remote Needlework Studio server.

Handles:
- Pull: fetch changes from server, apply to local DB (patterns + thread inventory)
- Push: send local changes to server
- Conflict resolution: last-write-wins on updated_at, capped to server_time
"""

import json
import sqlite3
import requests
from datetime import datetime, timezone


_VALID_BRANDS = ('DMC', 'Anchor')
_VALID_STATUSES = ('dont_own', 'own', 'need')
_VALID_PROJECT_STATUSES = ('not_started', 'in_progress', 'completed')
_MAX_NAME_LEN = 120
_MAX_GRID_DIM = 500
_MAX_THUMBNAIL = 500_000
_MAX_STITCH_ITEMS = 250_000  # 500*500


def _clamp_timestamp(ts, ceiling):
    """Reject timestamps beyond ceiling (server_time). Returns ts or ceiling."""
    if not ts or not ceiling:
        return ts
    return min(ts, ceiling)


def _valid_grid_dims(w, h):
    """Return True if grid dimensions are valid integers in range."""
    return (isinstance(w, int) and not isinstance(w, bool) and
            isinstance(h, int) and not isinstance(h, bool) and
            1 <= w <= _MAX_GRID_DIM and 1 <= h <= _MAX_GRID_DIM)


class SyncEngine:
    def __init__(self, server_url, token, db_path):
        self.server_url = server_url.rstrip('/')
        self.token = token
        self.db_path = db_path
        self.headers = {'Authorization': f'Bearer {token}'}

    def _get_db(self):
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def sync(self, last_sync_at, user_id):
        """Run full sync: pull then push. Returns result dict."""
        try:
            pull_result = self._pull(last_sync_at or '1970-01-01T00:00:00', user_id)
            if pull_result.get('error'):
                return pull_result
            push_result = self._push(last_sync_at or '1970-01-01T00:00:00', user_id)
            if push_result.get('error'):
                return push_result

            server_time = push_result.get('server_time') or pull_result.get('server_time', '')
            return {
                'server_time': server_time,
                'pull': pull_result,
                'push': push_result,
            }
        except requests.ConnectionError:
            return {'error': 'Could not connect to remote server'}
        except requests.Timeout:
            return {'error': 'Connection timed out'}
        except Exception as e:
            return {'error': 'Sync failed unexpectedly'}

    def _pull(self, since, user_id):
        """Pull changes from server and apply locally."""
        resp = requests.get(
            f"{self.server_url}/api/sync/changes",
            params={'since': since},
            headers=self.headers,
            timeout=30)
        if resp.status_code != 200:
            return {'error': f'Server returned status {resp.status_code}'}

        data = resp.json()
        server_time = data.get('server_time', '')
        conn = self._get_db()
        cursor = conn.cursor()
        stats = {'patterns_pulled': 0, 'patterns_deleted': 0,
                 'threads_pulled': 0, 'threads_deleted': 0}

        # --- Pull pattern upserts ---
        for p_meta in data.get('patterns', {}).get('upserted', []):
            slug = p_meta.get('slug')
            if not slug or not isinstance(slug, str) or len(slug) > 16:
                continue
            server_updated = _clamp_timestamp(p_meta.get('updated_at', ''), server_time)
            local = cursor.execute(
                "SELECT id, updated_at FROM saved_patterns WHERE slug = ? AND user_id = ?",
                (slug, user_id)).fetchone()
            if local and server_updated <= (local['updated_at'] or ''):
                continue  # Local is newer or same — skip
            # Fetch full pattern data
            full_resp = requests.get(
                f"{self.server_url}/api/sync/pattern/{slug}",
                headers=self.headers,
                timeout=30)
            if full_resp.status_code != 200:
                continue
            p = full_resp.json()

            # -- Validate pulled pattern data --
            grid_w = p.get('grid_w')
            grid_h = p.get('grid_h')
            if not _valid_grid_dims(grid_w, grid_h):
                continue  # skip invalid pattern

            name = str(p.get('name', 'Untitled'))[:_MAX_NAME_LEN]
            brand = p.get('brand', 'DMC')
            if brand not in _VALID_BRANDS:
                brand = 'DMC'
            project_status = p.get('project_status', 'not_started')
            if project_status not in _VALID_PROJECT_STATUSES:
                project_status = 'not_started'
            color_count = p.get('color_count', 0)
            if not isinstance(color_count, int) or color_count < 0 or color_count > 34:
                color_count = 0

            # Validate grid_data length matches dimensions
            grid_data = p.get('grid_data', [])
            if not isinstance(grid_data, list) or len(grid_data) != grid_w * grid_h:
                continue  # corrupted grid
            grid_json = json.dumps(grid_data)

            legend_data = p.get('legend_data', [])
            legend_json = json.dumps(legend_data) if isinstance(legend_data, list) else '[]'

            # Validate stitch layer sizes
            ps = p.get('part_stitches_data', [])
            bs = p.get('backstitches_data', [])
            kn = p.get('knots_data', [])
            bd = p.get('beads_data', [])
            ps_json = json.dumps(ps) if isinstance(ps, list) and len(ps) <= _MAX_STITCH_ITEMS else '[]'
            bs_json = json.dumps(bs) if isinstance(bs, list) and len(bs) <= _MAX_STITCH_ITEMS else '[]'
            kn_json = json.dumps(kn) if isinstance(kn, list) and len(kn) <= _MAX_STITCH_ITEMS else '[]'
            bd_json = json.dumps(bd) if isinstance(bd, list) and len(bd) <= _MAX_STITCH_ITEMS else '[]'

            progress_json = json.dumps(p['progress_data']) if isinstance(p.get('progress_data'), dict) else p.get('progress_data')

            # Validate thumbnail size
            thumbnail = p.get('thumbnail')
            if thumbnail and (not isinstance(thumbnail, str) or len(thumbnail) > _MAX_THUMBNAIL):
                thumbnail = None

            notes = str(p.get('notes', '') or '')[:2000]

            if local:
                cursor.execute(
                    """UPDATE saved_patterns SET name=?, grid_w=?, grid_h=?, color_count=?,
                              grid_data=?, legend_data=?, thumbnail=?, updated_at=?,
                              progress_data=?, project_status=?,
                              part_stitches_data=?, backstitches_data=?, knots_data=?, beads_data=?, brand=?, notes=?
                       WHERE id=? AND user_id=?""",
                    (name, grid_w, grid_h, color_count,
                     grid_json, legend_json, thumbnail,
                     server_updated, progress_json, project_status,
                     ps_json, bs_json, kn_json, bd_json, brand, notes,
                     local['id'], user_id))
            else:
                cursor.execute(
                    """INSERT INTO saved_patterns
                           (slug, user_id, name, grid_w, grid_h, color_count, grid_data, legend_data,
                            thumbnail, created_at, updated_at, progress_data, project_status,
                            part_stitches_data, backstitches_data, knots_data, beads_data, brand, notes)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (slug, user_id, name, grid_w, grid_h,
                     color_count, grid_json, legend_json, thumbnail,
                     _clamp_timestamp(p.get('created_at', server_updated), server_time),
                     server_updated, progress_json,
                     project_status, ps_json, bs_json, kn_json, bd_json, brand, notes))
            stats['patterns_pulled'] += 1

        # --- Pull pattern deletes ---
        for slug in data.get('patterns', {}).get('deleted', []):
            local = cursor.execute(
                "SELECT id FROM saved_patterns WHERE slug = ? AND user_id = ?",
                (slug, user_id)).fetchone()
            if local:
                cursor.execute("DELETE FROM saved_patterns WHERE id = ? AND user_id = ?",
                               (local['id'], user_id))
                stats['patterns_deleted'] += 1

        # --- Pull thread status upserts ---
        for ts in data.get('thread_statuses', {}).get('upserted', []):
            brand = ts.get('brand', 'DMC')
            if brand not in _VALID_BRANDS:
                continue
            number = ts.get('number', '')
            if not number or not isinstance(number, str) or len(number) > 10:
                continue
            server_updated = _clamp_timestamp(ts.get('updated_at', ''), server_time)

            # Validate status and notes
            status = ts.get('status', 'dont_own')
            if status not in _VALID_STATUSES:
                status = 'dont_own'
            notes = str(ts.get('notes', ''))[:1000]
            skein_qty = ts.get('skein_qty', 0)
            if not isinstance(skein_qty, (int, float)) or skein_qty < 0 or skein_qty > 9999:
                skein_qty = 0

            # Resolve (brand, number) → local thread_id
            thread_row = cursor.execute(
                "SELECT id FROM threads WHERE brand = ? AND number = ?",
                (brand, number)).fetchone()
            if not thread_row:
                continue
            tid = thread_row['id']
            local = cursor.execute(
                "SELECT updated_at FROM user_thread_status WHERE user_id = ? AND thread_id = ?",
                (user_id, tid)).fetchone()
            if local and server_updated <= (local['updated_at'] or ''):
                continue
            if local:
                cursor.execute(
                    "UPDATE user_thread_status SET status=?, notes=?, skein_qty=?, updated_at=? WHERE user_id=? AND thread_id=?",
                    (status, notes, skein_qty, server_updated, user_id, tid))
            else:
                cursor.execute(
                    "INSERT INTO user_thread_status (user_id, thread_id, status, notes, skein_qty, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                    (user_id, tid, status, notes, skein_qty, server_updated))
            stats['threads_pulled'] += 1

        # --- Pull thread status deletes ---
        for key in data.get('thread_statuses', {}).get('deleted', []):
            if ':' not in key:
                continue
            brand, number = key.split(':', 1)
            thread_row = cursor.execute(
                "SELECT id FROM threads WHERE brand = ? AND number = ?",
                (brand, number)).fetchone()
            if not thread_row:
                continue
            tid = thread_row['id']
            cursor.execute(
                "DELETE FROM user_thread_status WHERE user_id = ? AND thread_id = ?",
                (user_id, tid))
            if cursor.rowcount > 0:
                stats['threads_deleted'] += 1

        conn.commit()
        conn.close()
        stats['server_time'] = server_time
        return stats

    def _push(self, since, user_id):
        """Push local changes to server."""
        conn = self._get_db()
        cursor = conn.cursor()

        # Collect patterns modified since last sync
        pattern_rows = cursor.execute(
            """SELECT slug, name, grid_w, grid_h, color_count, grid_data, legend_data,
                      thumbnail, created_at, updated_at, progress_data, project_status,
                      part_stitches_data, backstitches_data, knots_data, beads_data, brand, notes
               FROM saved_patterns WHERE user_id = ? AND updated_at > ?""",
            (user_id, since)).fetchall()

        patterns_upsert = []
        for row in pattern_rows:
            p = dict(row)
            for field in ('grid_data', 'legend_data', 'part_stitches_data', 'backstitches_data', 'knots_data', 'beads_data'):
                if p.get(field):
                    try:
                        p[field] = json.loads(p[field])
                    except (json.JSONDecodeError, TypeError):
                        pass
            if p.get('progress_data'):
                try:
                    p['progress_data'] = json.loads(p['progress_data'])
                except (json.JSONDecodeError, TypeError):
                    pass
            patterns_upsert.append(p)

        # Collect pattern deletes from sync_log
        delete_rows = cursor.execute(
            "SELECT entity_key, timestamp FROM sync_log WHERE user_id = ? AND entity_type = 'pattern' AND action = 'delete' AND timestamp > ?",
            (user_id, since)).fetchall()
        patterns_delete = [{'slug': r['entity_key'], 'deleted_at': r['timestamp']} for r in delete_rows]

        # Collect thread status changes
        thread_rows = cursor.execute(
            """SELECT t.brand, t.number, u.status, u.notes, u.skein_qty, u.updated_at
               FROM user_thread_status u
               JOIN threads t ON t.id = u.thread_id
               WHERE u.user_id = ? AND u.updated_at > ?""",
            (user_id, since)).fetchall()
        threads_upsert = [dict(r) for r in thread_rows]

        # Collect thread status deletes from sync_log
        thread_delete_rows = cursor.execute(
            "SELECT entity_key, timestamp FROM sync_log WHERE user_id = ? AND entity_type = 'thread_status' AND action = 'delete' AND timestamp > ?",
            (user_id, since)).fetchall()
        threads_delete = [{'key': r['entity_key'], 'deleted_at': r['timestamp']} for r in thread_delete_rows]

        conn.close()

        payload = {
            'patterns': {
                'upsert': patterns_upsert,
                'delete': patterns_delete,
            },
            'thread_statuses': {
                'upsert': threads_upsert,
                'delete': threads_delete,
            }
        }

        resp = requests.post(
            f"{self.server_url}/api/sync/push",
            json=payload,
            headers=self.headers,
            timeout=60)
        if resp.status_code != 200:
            return {'error': f'Push failed with status {resp.status_code}'}

        return resp.json()
