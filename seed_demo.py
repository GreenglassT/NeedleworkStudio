"""Seed sample patterns for demo mode users."""

import json
import string
import secrets
import sqlite3
import base64
import io
import os

from PIL import Image


_MAX_THUMB = 120
_PATTERN_SYMBOLS = "+×#@*!=?%&~^$●■▲◆★§¶†‡±÷◎⊕⊗≠√∞⊞⬡¤※"


def _hex_to_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))


def _generate_thumbnail(grid_data, legend_data, grid_w, grid_h):
    """Render grid colors to a small PNG thumbnail as a data URI."""
    color_map = {}
    for entry in legend_data:
        color_map[entry["dmc"]] = _hex_to_rgb(entry["hex"])
    bg = (255, 255, 255)

    sc = min(_MAX_THUMB / grid_w, _MAX_THUMB / grid_h, 1)
    out_w = max(1, round(grid_w * sc))
    out_h = max(1, round(grid_h * sc))

    img = Image.new("RGB", (out_w, out_h), bg)
    pixels = img.load()
    for py in range(out_h):
        for px in range(out_w):
            gx = min(grid_w - 1, int(px / sc))
            gy = min(grid_h - 1, int(py / sc))
            val = grid_data[gy * grid_w + gx]
            pixels[px, py] = color_map.get(val, bg) if val != "BG" else bg

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def _generate_slug(length=8):
    chars = string.ascii_letters + string.digits
    return ''.join(secrets.choice(chars) for _ in range(length))


def _insert_pattern(db, user_id, name, grid_w, grid_h, grid_data, legend_data):
    """Insert a pattern with auto-generated slug and thumbnail."""
    # Auto-assign symbols if missing
    for i, entry in enumerate(legend_data):
        if "symbol" not in entry:
            entry["symbol"] = _PATTERN_SYMBOLS[i % len(_PATTERN_SYMBOLS)]
    grid_json = json.dumps(grid_data)
    legend_json = json.dumps(legend_data)
    color_count = len(legend_data)
    thumbnail = _generate_thumbnail(grid_data, legend_data, grid_w, grid_h)
    for _ in range(5):
        slug = _generate_slug()
        try:
            db.execute(
                """INSERT INTO saved_patterns
                   (slug, user_id, name, grid_w, grid_h, color_count,
                    grid_data, legend_data, thumbnail)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (slug, user_id, name, grid_w, grid_h, color_count,
                 grid_json, legend_json, thumbnail)
            )
            return slug
        except sqlite3.IntegrityError:
            continue
    return None


def _make_heart_pattern():
    """A 15x15 red heart on white background."""
    W, H = 15, 15
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


def _make_floral_mandala():
    """A 40x40 symmetric floral mandala with 8 colors."""
    import math
    W, H = 41, 41
    cx, cy = W // 2, H // 2

    colors = [
        ("550", "Violet Very Dark", "#5B2561"),
        ("553", "Violet", "#A363A9"),
        ("3607", "Plum Light", "#C44D80"),
        ("3609", "Plum Ultra Light", "#E898B2"),
        ("907", "Parrot Green Light", "#C6E26C"),
        ("702", "Kelly Green", "#226B30"),
        ("726", "Topaz Light", "#FDD54A"),
        ("740", "Tangerine", "#FF8313"),
    ]
    bg_dmc = "Ecru"

    grid = [bg_dmc] * (W * H)

    def sym_set(x, y, dmc):
        """Set pixel with 4-fold symmetry."""
        pts = [(cx+x, cy+y), (cx-x, cy+y), (cx+x, cy-y), (cx-x, cy-y)]
        for px, py in pts:
            if 0 <= px < W and 0 <= py < H:
                grid[py * W + px] = dmc

    # Center flower (tangerine core)
    for dy in range(-1, 2):
        for dx in range(-1, 2):
            sym_set(dx, dy, "740")

    # Inner petals (plum)
    for d in range(2, 5):
        sym_set(d, 0, "3607")
        sym_set(0, d, "3607")
    # Diagonal petals (violet)
    for d in range(2, 4):
        sym_set(d, d, "553")
        sym_set(d, -d, "553")

    # Gold ring
    for angle_deg in range(0, 360, 5):
        a = math.radians(angle_deg)
        r = 6
        sym_set(round(r * math.cos(a)), round(r * math.sin(a)), "726")

    # Green leaves (diagonal axes)
    for d in range(5, 10):
        sym_set(d, d, "702")
        sym_set(d + 1, d, "907")
        sym_set(d, d + 1, "907")

    # Outer petals (pink light, at cardinal axes)
    for d in range(7, 13):
        sym_set(d, 0, "3609")
        sym_set(d, 1, "3609")
        sym_set(d, -1, "3609")
        sym_set(0, d, "3609")
        sym_set(1, d, "3609")
        sym_set(-1, d, "3609")

    # Outer petal tips (dark plum)
    for d in range(12, 15):
        sym_set(d, 0, "3607")
        sym_set(0, d, "3607")

    # Violet corner accents
    for d in range(12, 16):
        sym_set(d, d, "550")
    for d in range(10, 13):
        sym_set(d + 1, d, "553")
        sym_set(d, d + 1, "553")

    # Outer ring (dark violet)
    for angle_deg in range(0, 360, 3):
        a = math.radians(angle_deg)
        r = 17
        x, y = round(r * math.cos(a)), round(r * math.sin(a))
        sym_set(x, y, "550")

    all_dmcs = [c[0] for c in colors] + [bg_dmc]
    legend = []
    for dmc, name, hex_val in colors:
        count = grid.count(dmc)
        if count > 0:
            legend.append({"dmc": dmc, "name": name, "hex": hex_val, "count": count})
    bg_count = grid.count(bg_dmc)
    if bg_count > 0:
        legend.append({"dmc": bg_dmc, "name": "Ecru", "hex": "#F0EADA", "count": bg_count})

    return "Floral Mandala", W, H, grid, legend


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
        _make_floral_mandala(),
        _make_heart_pattern(),
        _make_checkerboard_pattern(),
        _make_rainbow_stripes(),
        _make_border_sampler(),
    ]

    for name, w, h, grid, legend in patterns:
        _insert_pattern(db, user_id, name, w, h, grid, legend)

    db.commit()
