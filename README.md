<p align="center">
  <img src="static/logo.svg" alt="Needlework Studio" height="80">
</p>

<p align="center">
  A self-hosted cross-stitch pattern management and design tool.
</p>

---

Track your thread inventory across DMC and Anchor brands, convert images into cross-stitch patterns, design patterns from scratch with a full-featured editor, and manage your stitching projects — all in one app. Multi-user, fully self-contained, no external dependencies.

Built with Python/Flask, SQLite, and vanilla JavaScript. No npm, no build step, no external JS frameworks.

## Getting Started

### Desktop App

Download the installer for your platform from the [Releases page](https://github.com/GreenglassT/NeedleworkStudio/releases) — available for macOS, Windows, and Linux. No Python, server setup, or terminal required.

The desktop app stores data locally and works fully offline. To sync with a self-hosted server, see [Desktop Sync](#desktop-sync).

### Self-Hosted with Docker

The easiest way to run your own server. Requires [Docker](https://docs.docker.com/get-docker/) and [Docker Compose](https://docs.docker.com/compose/install/).

Create a `docker-compose.yml`:

```yaml
services:
  needlework-studio:
    image: ghcr.io/greenglasst/needleworkstudio:latest
    ports:
      - "6969:6969"
    volumes:
      - needlework-data:/data
    restart: unless-stopped

volumes:
  needlework-data:
```

```bash
docker compose up -d

# Create your first user account
docker compose exec needlework-studio python manage_users.py create
```

Open **http://localhost:6969** and log in.

### Self-Hosted Manual Setup

**Prerequisites:** Python 3.10+ and pip

```bash
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
python3 init_db.py               # Seed 744 DMC + 400+ Anchor threads
python3 manage_users.py create   # Create your first user

# Development
python3 app.py

# Production (single worker required for in-memory rate limiter)
gunicorn -w 1 --threads 4 -b 0.0.0.0:6969 app:app
```

Open **http://localhost:6969** and log in.

> **Note:** `init_db.py` drops and recreates the database. Only run it for first-time setup or to reset all data.

## Features

### Thread Inventory

- Browse 744 DMC and 400+ Anchor threads with instant search by number or name
- Filter by brand, thread category, and ownership status
- Mark threads as **Own**, **Need**, or **Don't Own** with single-click status buttons
- Track skein quantities per thread
- Find similar colors using CIEDE2000 perceptual color matching
- Grid and list views, batch selection, print-friendly thread list

### Pattern Design

- **Image-to-pattern** — upload any image, configure grid size and color count (2-34), apply dithering and preprocessing, crop inline
- **Blank canvas** — create patterns from scratch with custom dimensions
- **11 drawing tools** with keyboard shortcuts — pencil, eraser, fill, line, rectangle, ellipse, eyedropper, replace, select, stitch, and text
- **6 stitch types** — full, half, quarter, three-quarter, backstitch, and French knot
- Mirror/symmetry modes, 50-level undo/redo, canvas resize with anchor positioning
- Inline color management with add, replace, and batch operations

### Pattern Viewer

- **Chart mode** with symbol overlays and four-sided rulers, **thread mode** with realistic stitch rendering
- **Zen mode** — distraction-free fullscreen viewing
- Searchable legend, per-color progress tracking, zoom 10%-400%
- Resizable legend sidebar, toggleable gridlines/symbols/stitches

### Import and Export

**Import:** PDF (auto-parsed charts), JSON (native format), OXS (Open Cross Stitch XML)

**Export:** PDF (cover + tiled grid + legend), SVG (vector chart), OXS, JSON

### Project Management

- Track pattern status: Not Started, In Progress, or Completed
- Per-color completion tracking with visual progress bars
- Saved patterns gallery with thumbnails, search, sort, and batch actions
- Fork (duplicate) any pattern to create an independent copy
- **Materials calculator** — calculate skein requirements by pattern, stitch count, or fabric size

### Desktop Sync

The desktop app can sync bidirectionally with a self-hosted server, keeping patterns and thread inventory in sync across devices.

1. Click the cloud icon in the header and enter your server URL and credentials
2. The server issues a long-lived API token (credentials are not stored)
3. Sync runs automatically on launch and manually via "Sync Now"
4. Conflicts resolved with last-write-wins based on timestamps

Syncs: saved patterns (all stitch data, progress, thumbnails), thread inventory (status, quantities, notes), and deletions. Status indicator in the header shows state at a glance — gray (unpaired), green (paired), gold pulse (syncing), red (error).

## Administration

### User Management

```bash
python3 manage_users.py create     # Create a new user
python3 manage_users.py list       # List all users
python3 manage_users.py password   # Reset a user's password
python3 manage_users.py toggle     # Enable or disable an account
python3 manage_users.py delete     # Delete a user
python3 manage_users.py tokens     # List active API tokens (desktop sync)
python3 manage_users.py revoke ID  # Revoke an API token by ID
```

In Docker: prefix commands with `docker compose exec needlework-studio`.

### Backups

All persistent data (database, uploads, session secret) lives in a single directory — the Docker volume at `/data`, or the app directory for manual installs.

```bash
# Docker backup
docker compose exec needlework-studio tar czf - /data > needlework-backup-$(date +%F).tar.gz

# Docker restore
docker compose down
docker run --rm -v needleworkstudio_needlework-data:/data -v $(pwd):/backup alpine \
  sh -c "cd / && tar xzf /backup/needlework-backup-*.tar.gz"
docker compose up -d
```

### Reverse Proxy / HTTPS

For public-facing deployments, place the app behind a reverse proxy with SSL and set `HTTPS=true`. Minimal [Caddy](https://caddyserver.com/) example:

```yaml
# docker-compose.yml
services:
  needlework-studio:
    image: ghcr.io/greenglasst/needleworkstudio:latest
    environment:
      - HTTPS=true
    volumes:
      - needlework-data:/data
    restart: unless-stopped

  caddy:
    image: caddy:2
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy-data:/data
    restart: unless-stopped

volumes:
  needlework-data:
  caddy-data:
```

```
# Caddyfile
needlework.example.com {
    reverse_proxy needlework-studio:6969
}
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `6969` | Application port |
| `SECRET_KEY` | auto-generated | Session encryption key (persisted on first run) |
| `HTTPS` | `false` | Secure session cookies (set `true` behind SSL proxy) |
| `FLASK_DEBUG` | `0` | Debug mode (development only) |
| `NEEDLEWORK_DATA_DIR` | app directory | Override data/DB storage location |
| `DESKTOP_MODE` | `false` | Auto-login without credentials (desktop app only) |

### Running as a Service

```ini
# /etc/systemd/system/needlework-studio.service
[Unit]
Description=Needlework Studio
After=network.target

[Service]
Type=simple
User=your-username
WorkingDirectory=/path/to/needlework-studio
ExecStart=/path/to/needlework-studio/venv/bin/gunicorn -w 1 --threads 4 -b 0.0.0.0:6969 app:app
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable needlework-studio
sudo systemctl start needlework-studio
```

Docker deployments with `restart: unless-stopped` auto-restart after crashes and reboots.

## Technical Details

| Component | Technology |
|-----------|------------|
| Backend | Python 3, Flask |
| Database | SQLite |
| Frontend | Vanilla JavaScript, Jinja2 |
| Auth | Flask-Login, Argon2 |
| Image Processing | Pillow, colormath (CIEDE2000) |
| PDF | pdfplumber + pypdfium2 (import), jsPDF (export) |
| Icons | Tabler Icons |
| Desktop | Electron, PyInstaller |
| Production | Gunicorn, Docker |

**Security:** CSRF protection (Flask-WTF), Argon2 password hashing, rate limiting, HTTP security headers (CSP, HSTS, X-Frame-Options), secure session cookies, upload size limits (25 MB), decompression bomb protection (50 MP).

**Data storage:** All data in `dmc_threads.db` (SQLite) — fully self-contained with no external service dependencies. Patterns include full grid, legend, part stitches, backstitches, French knots, progress state, and thumbnails.
