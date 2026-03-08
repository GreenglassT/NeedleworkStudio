<p align="center">
  <img src="static/logo.svg" alt="Needlework Studio" height="80">
</p>

<p align="center">
  A self-hosted cross-stitch pattern management and design tool.
</p>

<p align="center">
  <a href="https://github.com/GreenglassT/NeedleworkStudio/releases/latest"><img src="https://img.shields.io/github/v/release/GreenglassT/NeedleworkStudio" alt="Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/GreenglassT/NeedleworkStudio" alt="License"></a>
</p>

---

Track your thread inventory across DMC and Anchor brands, convert images into cross-stitch patterns, design patterns from scratch with a full-featured editor, and manage your stitching projects — all in one app. Multi-user, fully self-contained, no external dependencies.

Built with Python/Flask, SQLite, and vanilla JavaScript. No npm, no build step, no external JS frameworks.

## Install

### Desktop App

Download the installer for your platform from the [Releases page](https://github.com/GreenglassT/NeedleworkStudio/releases/latest) — available for macOS (Apple Silicon & Intel), Windows, and Linux (.AppImage, .deb). No server setup required.

### Docker

```bash
docker run -d -p 6969:6969 -v needlework-data:/data --name needlework \
  ghcr.io/greenglasst/needleworkstudio:latest
docker exec needlework python manage_users.py create
```

Open **http://localhost:6969** and log in.

### Manual

**Prerequisites:** Python 3.10+

```bash
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
python3 init_db.py
python3 manage_users.py create
python3 app.py
```

Open **http://localhost:6969** and log in. For production, use `gunicorn -w 1 --threads 4 -b 0.0.0.0:6969 app:app`.

## Features

- **Thread inventory** — 744 DMC and 400+ Anchor threads with search, filtering, ownership tracking, quantity management, and similar color matching (CIEDE2000)
- **Image-to-pattern** — upload any image, configure grid size and color count, dithering, inline crop
- **Pattern editor** — 11 drawing tools, 6 stitch types (full, half, quarter, three-quarter, backstitch, French knot), mirror modes, 50-level undo/redo
- **Pattern viewer** — chart mode with symbols, thread mode with realistic rendering, zen mode, per-color progress tracking, zoom 10%-400%
- **Import/Export** — PDF, OXS, SVG, JSON; backup all patterns as ZIP
- **Project management** — status tracking, progress bars, materials calculator, skein estimates
- **Desktop sync** — bidirectional sync between desktop app and self-hosted server
- **Multi-user** — Argon2 auth, CSRF protection, rate limiting, security headers

## Documentation

> **📖 [Read the Wiki](https://github.com/GreenglassT/NeedleworkStudio/wiki)** — Getting started, administration, deployment, desktop sync, and more.

## License

[GPL-3.0](LICENSE)
