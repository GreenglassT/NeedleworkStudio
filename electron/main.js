const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const { spawn } = require('child_process');
const path = require('path');
const net = require('net');

// ── Configuration ──────────────────────────────────────────────
const APP_ROOT = path.resolve(__dirname, '..');
const IS_DEV = process.argv.includes('--dev');

let flaskProcess = null;
let mainWindow = null;
let flaskPort = null;
let updateCheckInterval = null;
let isUpdating = false;

// ── Find a free port ───────────────────────────────────────────
function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

// ── Wait for Flask to respond ──────────────────────────────────
function waitForFlask(port, timeoutMs = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function check() {
      if (Date.now() - start > timeoutMs) {
        return reject(new Error('Flask backend did not start within timeout'));
      }
      const req = require('http').get(`http://127.0.0.1:${port}/`, (res) => {
        // Any response (even 302 redirect to login) means Flask is up
        resolve();
      });
      req.on('error', () => {
        setTimeout(check, 200);
      });
      req.setTimeout(2000, () => {
        req.destroy();
        setTimeout(check, 200);
      });
    }
    check();
  });
}

// ── Start Flask backend ────────────────────────────────────────
function startFlask(port) {
  const env = {
    ...process.env,
    PORT: String(port),
    DESKTOP_MODE: '1',
    FLASK_DEBUG: '0',
  };

  // Set NEEDLEWORK_DATA_DIR to the OS user-data directory so the
  // DB, uploads, and secret key live outside the app bundle.
  const userDataDir = app.getPath('userData');
  env.NEEDLEWORK_DATA_DIR = userDataDir;

  const binaryName = process.platform === 'win32' ? 'needlework-backend.exe' : 'needlework-backend';
  let cmd, args, cwd;

  if (IS_DEV) {
    // Dev mode: use the system Python to run app.py directly.
    cmd = process.platform === 'win32' ? 'python' : 'python3';
    args = [path.join(APP_ROOT, 'app.py')];
    cwd = APP_ROOT;
  } else if (app.isPackaged) {
    // Packaged app: backend is in the Resources directory alongside the asar.
    const bundleDir = path.join(process.resourcesPath, 'needlework-backend');
    cmd = path.join(bundleDir, binaryName);
    args = [];
    cwd = bundleDir;
  } else {
    // Unpackaged production: PyInstaller output in the project dist/ folder.
    const bundleDir = path.join(APP_ROOT, 'dist', 'needlework-backend');
    cmd = path.join(bundleDir, binaryName);
    args = [];
    cwd = bundleDir;
  }

  console.log(`[electron] Starting Flask: ${cmd} ${args.join(' ')}`);
  console.log(`[electron] Port: ${port}, Data dir: ${userDataDir}`);

  flaskProcess = spawn(cmd, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  flaskProcess.stdout.on('data', (data) => {
    process.stdout.write(`[flask] ${data}`);
  });

  flaskProcess.stderr.on('data', (data) => {
    process.stderr.write(`[flask] ${data}`);
  });

  flaskProcess.on('error', (err) => {
    console.error('[electron] Failed to start Flask:', err.message);
    dialog.showErrorBox(
      'Needlework Studio',
      `Could not start the application backend.\n\n${err.message}`
    );
    app.quit();
  });

  flaskProcess.on('exit', (code, signal) => {
    console.log(`[electron] Flask exited (code=${code}, signal=${signal})`);
    flaskProcess = null;
    // If the window is still open and we're not updating, the backend crashed
    if (!isUpdating && mainWindow && !mainWindow.isDestroyed()) {
      dialog.showErrorBox(
        'Needlework Studio',
        'The application backend has stopped unexpectedly. The app will now close.'
      );
      app.quit();
    }
  });

  return flaskProcess;
}

// ── Create the main window ─────────────────────────────────────
function createWindow(port) {
  const isMac = process.platform === 'darwin';
  const isWin = process.platform === 'win32';

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 800,
    minHeight: 600,
    title: 'Needlework Studio',
    titleBarStyle: isMac ? 'hiddenInset' : isWin ? 'hidden' : undefined,
    ...(isWin ? {
      titleBarOverlay: {
        color: '#181410',
        symbolColor: '#ede4d0',
        height: 32,
      },
    } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    show: false,
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}/`);

  // Show window once content has loaded (avoids blank flash)
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (!IS_DEV) {
      setupAutoUpdater();
    }
  });

  // Open devtools in dev mode
  if (IS_DEV) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── Auto-update via electron-updater ──────────────────────────
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function setupAutoUpdater() {
  const isMac = process.platform === 'darwin';

  // macOS: skip background download since quitAndInstall doesn't work
  // with ad-hoc signing — we direct to the releases page instead.
  autoUpdater.autoDownload = !isMac;
  autoUpdater.autoInstallOnAppQuit = !isMac;

  autoUpdater.on('update-available', (info) => {
    console.log(`[electron] Update available: v${info.version}`);
    if (!mainWindow || mainWindow.isDestroyed()) return;

    if (isMac) {
      // macOS: download the correct DMG directly via native save dialog
      const archSuffix = process.arch === 'arm64' ? 'arm64-Apple' : 'x64-Intel';
      const dmgName = `Needlework-Studio-${info.version}-${archSuffix}.dmg`;
      const dmgUrl = `https://github.com/GreenglassT/NeedleworkStudio/releases/download/v${info.version}/${dmgName}`;

      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Update Available',
        message: `Version v${info.version} is available.`,
        detail: `Click "Download Update" to save the installer for your Mac (${archSuffix}).`,
        buttons: ['Download Update', 'Later'],
        defaultId: 0,
        cancelId: 1,
      }).then(({ response }) => {
        if (response === 0) {
          mainWindow.webContents.downloadURL(dmgUrl);
        }
      });
    } else {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Update Available',
        message: `A new version (v${info.version}) is available.`,
        detail: 'It will be downloaded in the background.',
        buttons: ['OK'],
      });
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[electron] Update downloaded: v${info.version}`);
    if (!mainWindow || mainWindow.isDestroyed()) return;
    // Only Windows/Linux reach here (macOS has autoDownload=false)
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Update Ready',
      message: `Version v${info.version} has been downloaded.`,
      detail: 'Restart now to install the update?',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => {
      if (response === 0) {
        isUpdating = true;
        try {
          autoUpdater.quitAndInstall(false, true);
        } catch (e) {
          console.error('[electron] quitAndInstall failed:', e);
          isUpdating = false;
          shell.openExternal('https://github.com/GreenglassT/NeedleworkStudio/releases/latest');
        }
      }
    });
  });

  autoUpdater.on('error', (err) => {
    console.log('[electron] Auto-update error:', err.message);
  });

  // Check on launch, then once every 24 hours
  autoUpdater.checkForUpdates().catch((err) => {
    console.log('[electron] Update check failed:', err.message);
  });

  updateCheckInterval = setInterval(() => {
    console.log('[electron] Periodic update check');
    autoUpdater.checkForUpdates().catch((err) => {
      console.log('[electron] Periodic update check failed:', err.message);
    });
  }, ONE_DAY_MS);
}

function checkForUpdatesManual() {
  autoUpdater.once('update-not-available', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'No Updates',
      message: 'You are running the latest version.',
    });
  });

  autoUpdater.checkForUpdates().catch((err) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'Update Check Failed',
      message: `Could not check for updates.\n\n${err.message}`,
    });
  });
}

// ── Application menu ──────────────────────────────────────────
function buildAppMenu() {
  const isMac = process.platform === 'darwin';

  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { label: 'Check for Updates…', click: checkForUpdatesManual },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    ...(!isMac ? [{
      label: 'Help',
      submenu: [
        { label: 'Check for Updates…', click: checkForUpdatesManual },
      ],
    }] : []),
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── App lifecycle ──────────────────────────────────────────────
app.on('ready', async () => {
  try {
    buildAppMenu();
    flaskPort = await findFreePort();
    startFlask(flaskPort);
    await waitForFlask(flaskPort);
    createWindow(flaskPort);
  } catch (err) {
    console.error('[electron] Startup failed:', err.message);
    dialog.showErrorBox(
      'Needlework Studio',
      `Failed to start: ${err.message}`
    );
    app.quit();
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('will-quit', () => {
  if (updateCheckInterval) clearInterval(updateCheckInterval);
  killFlask();
});

// ── Graceful shutdown ──────────────────────────────────────────
function killFlask() {
  if (!flaskProcess) return;

  console.log('[electron] Shutting down Flask...');

  // Try graceful termination first
  if (process.platform === 'win32') {
    // Windows: no SIGTERM support, use taskkill
    spawn('taskkill', ['/pid', String(flaskProcess.pid), '/f', '/t']);
  } else {
    flaskProcess.kill('SIGTERM');

    // Force kill after 3 seconds if still running
    const forceKillTimer = setTimeout(() => {
      if (flaskProcess) {
        console.log('[electron] Force killing Flask...');
        flaskProcess.kill('SIGKILL');
      }
    }, 3000);

    flaskProcess.on('exit', () => {
      clearTimeout(forceKillTimer);
    });
  }

  flaskProcess = null;
}

// macOS: re-create window when dock icon clicked and no windows open
app.on('activate', () => {
  if (mainWindow === null && flaskPort) {
    createWindow(flaskPort);
  }
});
