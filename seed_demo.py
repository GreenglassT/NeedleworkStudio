"""Seed sample patterns for demo mode users."""

import json
import string
import secrets
import sqlite3
import os


def _generate_slug(length=8):
    chars = string.ascii_letters + string.digits
    return ''.join(secrets.choice(chars) for _ in range(length))


def _insert_pattern(db, user_id, name, grid_w, grid_h, grid_data, legend_data):
    """Insert a pattern with auto-generated slug."""
    grid_json = json.dumps(grid_data)
    legend_json = json.dumps(legend_data)
    color_count = len(legend_data)
    for _ in range(5):
        slug = _generate_slug()
        try:
            db.execute(
                """INSERT INTO saved_patterns
                   (slug, user_id, name, grid_w, grid_h, color_count,
                    grid_data, legend_data)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (slug, user_id, name, grid_w, grid_h, color_count,
                 grid_json, legend_json)
            )
            return slug
        except sqlite3.IntegrityError:
            continue
    return None


def _make_heart_pattern():
    """A 15x15 red heart on white background."""
    W, H = 15, 15
    heart_cells = {
        (1, 2), (2, 1), (3, 0), (4, 1), (5, 2),
        (6, 1), (7, 0), (8, 1), (9, 2), (10, 1), (11, 2), (12, 3), (13, 2),
        (1, 3), (2, 2), (3, 1), (4, 2), (5, 3),
        (6, 2), (7, 1), (8, 2), (9, 3), (10, 2), (11, 3), (12, 4), (13, 3),
        (0, 4), (1, 4), (2, 3), (3, 2), (4, 3), (5, 4), (6, 3), (7, 2),
        (8, 3), (9, 4), (10, 3), (11, 4), (12, 5), (13, 4), (14, 4),
        (0, 5), (1, 5), (2, 4), (3, 3), (4, 4), (5, 5), (6, 4), (7, 3),
        (8, 4), (9, 5), (10, 4), (11, 5), (12, 6), (13, 5), (14, 5),
        (0, 6), (1, 6), (2, 5), (3, 4), (4, 5), (5, 6), (6, 5), (7, 4),
        (8, 5), (9, 6), (10, 5), (11, 6), (12, 7), (13, 6), (14, 6),
    }
    # Build a proper heart shape
    grid = []
    heart = [
        "...XXX...XXX...",
        "..XXXXX.XXXXX..",
        ".XXXXXXXXXXXXX.",
        ".XXXXXXXXXXXXX.",
        "..XXXXXXXXXXX..",
        "...XXXXXXXXX...",
        "....XXXXXXX....",
        ".....XXXXX.....",
        "......XXX......",
        ".......X.......",
    ]
    # Pad to 15 rows
    while len(heart) < H:
        heart.append("." * W)

    for row in heart:
        row = row.ljust(W, '.')[:W]
        for ch in row:
            grid.append("321" if ch == 'X' else "Blanc")

    legend = [
        {"dmc": "321", "name": "Red", "hex": "#C72B36", "count": grid.count("321")},
        {"dmc": "Blanc", "name": "White", "hex": "#FCFBF8", "count": grid.count("Blanc")},
    ]
    return "Heart Sampler", W, H, grid, legend


def _make_checkerboard_pattern():
    """An 8x8 checkerboard like a chess board."""
    W, H = 16, 16
    grid = []
    for y in range(H):
        for x in range(W):
            if (x // 2 + y // 2) % 2 == 0:
                grid.append("310")
            else:
                grid.append("Ecru")

    legend = [
        {"dmc": "310", "name": "Black", "hex": "#000000", "count": grid.count("310")},
        {"dmc": "Ecru", "name": "Ecru", "hex": "#F0EADA", "count": grid.count("Ecru")},
    ]
    return "Checkerboard", W, H, grid, legend


def _make_rainbow_stripes():
    """Horizontal rainbow stripes pattern."""
    W, H = 20, 14
    colors = [
        ("321", "Red", "#C72B36"),
        ("740", "Tangerine", "#FF8313"),
        ("307", "Lemon", "#FDED54"),
        ("907", "Parrot Green Light", "#C6E26C"),
        ("996", "Electric Blue Medium", "#30BFBF"),
        ("797", "Royal Blue", "#1D3E8C"),
        ("550", "Violet Very Dark", "#5B2561"),
    ]
    grid = []
    for y in range(H):
        color_idx = y * len(colors) // H
        dmc = colors[color_idx][0]
        for x in range(W):
            grid.append(dmc)

    legend = []
    for dmc, name, hex_val in colors:
        count = grid.count(dmc)
        if count > 0:
            legend.append({"dmc": dmc, "name": name, "hex": hex_val, "count": count})

    return "Rainbow Stripes", W, H, grid, legend


def _make_border_sampler():
    """A decorative border frame pattern."""
    W, H = 20, 20
    grid = ["Blanc"] * (W * H)

    def set_cell(x, y, dmc):
        if 0 <= x < W and 0 <= y < H:
            grid[y * W + x] = dmc

    # Outer border in navy
    for x in range(W):
        set_cell(x, 0, "797")
        set_cell(x, H - 1, "797")
    for y in range(H):
        set_cell(0, y, "797")
        set_cell(W - 1, y, "797")

    # Inner border in gold
    for x in range(2, W - 2):
        set_cell(x, 2, "726")
        set_cell(x, H - 3, "726")
    for y in range(2, H - 2):
        set_cell(2, y, "726")
        set_cell(W - 3, y, "726")

    # Corner diamonds in red
    corners = [(1, 1), (W - 2, 1), (1, H - 2), (W - 2, H - 2)]
    for cx, cy in corners:
        set_cell(cx, cy, "321")

    # Center cross
    mid_x, mid_y = W // 2, H // 2
    for d in range(-2, 3):
        set_cell(mid_x + d, mid_y, "321")
        set_cell(mid_x, mid_y + d, "321")

    legend = [
        {"dmc": "797", "name": "Royal Blue", "hex": "#1D3E8C", "count": grid.count("797")},
        {"dmc": "726", "name": "Topaz Light", "hex": "#FDD54A", "count": grid.count("726")},
        {"dmc": "321", "name": "Red", "hex": "#C72B36", "count": grid.count("321")},
        {"dmc": "Blanc", "name": "White", "hex": "#FCFBF8", "count": grid.count("Blanc")},
    ]
    return "Border Sampler", W, H, grid, legend


def seed_demo_patterns(user_id, db):
    """Insert sample patterns for a new demo user. Safe to call multiple times."""
    # Check if user already has patterns
    row = db.execute(
        "SELECT COUNT(*) as c FROM saved_patterns WHERE user_id = ?",
        (user_id,)
    ).fetchone()
    if row and row['c'] > 0:
        return

    patterns = [
        _make_heart_pattern(),
        _make_checkerboard_pattern(),
        _make_rainbow_stripes(),
        _make_border_sampler(),
    ]

    for name, w, h, grid, legend in patterns:
        _insert_pattern(db, user_id, name, w, h, grid, legend)

    db.commit()
