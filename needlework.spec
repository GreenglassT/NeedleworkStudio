# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for Needlework Studio Flask backend."""

import os
import sys

# Platform-aware icon (Windows only — macOS/Linux use Electron shell icon)
_icon = None
if sys.platform == 'win32':
    _ico = os.path.join('electron', 'resources', 'icon.ico')
    if os.path.exists(_ico):
        _icon = _ico

block_cipher = None

a = Analysis(
    ['app.py'],
    pathex=[],
    binaries=[],
    datas=[
        ('schema.sql', '.'),
        ('templates', 'templates'),
        ('static', 'static'),
    ],
    hiddenimports=[
        # App modules (traced as imports, not needed as datas)
        'anchor_threads',
        'init_db',
        # numpy (colormath dependency)
        'numpy',
        # PDF handling
        'pypdfium2',
        'pypdfium2._helpers',
        'pdfplumber',
        # Auth
        'argon2',
        'argon2.low_level',
        'argon2._password_hasher',
        # Color matching
        'colormath',
        'colormath.color_objects',
        'colormath.color_conversions',
        'colormath.color_diff',
        'colormath.chromatic_adaptation',
        # Image processing
        'PIL',
        'PIL.Image',
        'PIL.ImageEnhance',
        'PIL.ImageDraw',
        # Flask extensions
        'flask_login',
        'flask_wtf',
        'flask_wtf.csrf',
        'flask_limiter',
        'flask_limiter.util',
        # Werkzeug internals
        'werkzeug',
        'werkzeug.serving',
        'werkzeug.debug',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'gunicorn',
        'tkinter',
        'unittest',
        'test',
        'pytest',
    ],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='needlework-backend',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    icon=_icon,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='needlework-backend',
)
