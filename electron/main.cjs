// Electron host. The renderer holds the whole app; main only provides the
// things a browser cannot: native dialogs and direct filesystem access for
// .sinst instrument folders (which hold hundreds of MB of samples and must
// never be copied through IndexedDB).
const { app, BrowserWindow, ipcMain, dialog, utilityProcess, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');

const DEV_URL = process.env.SAMPLER_DEV_URL || '';

if (process.platform === 'linux') {
  // Run natively on Wayland (KDE Plasma's default session) rather than through
  // XWayland, which blurs the UI on fractional scaling. Falls back to X11 on
  // its own when there is no Wayland compositor.
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
  app.commandLine.appendSwitch('enable-features', 'WaylandWindowDecorations');
  // Matches the installed .desktop file, so Plasma groups the window under the
  // right launcher and taskbar entry instead of a generic Electron one.
  app.setDesktopName('livesample.desktop');
}

let win = null;

// Unsaved-changes state, mirrored from the renderer. The check lives here
// rather than in a renderer `beforeunload`, because preventing default there
// does not prompt in Electron — it silently refuses to close and the app
// becomes unquittable.
let isDirty = false;
let forceClose = false;

function confirmClose(e) {
  if (forceClose || !isDirty) return;
  e.preventDefault();

  const choice = dialog.showMessageBoxSync(win, {
    type: 'warning',
    buttons: ['Save', "Don't save", 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
    title: 'Unsaved changes',
    message: 'This instrument has unsaved changes.',
    detail: 'Save before closing?',
  });

  if (choice === 2) return;
  if (choice === 1) {
    forceClose = true;
    win.close();
    return;
  }

  // Only the renderer can save — it owns the audio. Ask it to, but never let a
  // wedged or slow save trap the user in an app they cannot close.
  win.webContents.send('app:closeRequest', 'save');
  setTimeout(() => {
    if (win && !win.isDestroyed() && !forceClose) {
      forceClose = true;
      win.close();
    }
  }, 20000);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1040,
    minHeight: 680,
    backgroundColor: '#0e0f11',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.on('close', confirmClose);
  if (DEV_URL) win.loadURL(DEV_URL);
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

app.whenReady().then(() => {
  // No handler existed before, which in Electron means every permission is
  // granted. Keep that behaviour (the microphone for Web Audio capture depends
  // on it) but spell 'midi' out, and refuse sysex, which nothing here uses.
  const allow = (permission) => permission !== 'midiSysex';
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) =>
    callback(allow(permission)),
  );
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allow(permission));
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopAudioHost();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  forceClose = true;
  stopAudioHost();
});

// Last resort. A native audio driver that refuses to release can leave the
// process alive with no window, which looks exactly like "the app won't close".
app.on('will-quit', () => {
  stopAudioHost();
  setTimeout(() => process.exit(0), 3000).unref();
});

// ---------------------------------------------------------------------------
// Audio host process
//
// RtAudio lives in its own utilityProcess. Feeding an audio output queue on the
// main thread, alongside window management and GC, is how you get dropouts.
// ---------------------------------------------------------------------------

let audioHost = null;

function startAudioHost() {
  if (audioHost) return audioHost;
  const hostPath = path.join(__dirname, '..', 'dist-host', 'host.cjs');
  audioHost = utilityProcess.fork(hostPath, [], {
    serviceName: 'sampler-audio',
    stdio: 'ignore',
  });
  audioHost.on('message', (msg) => {
    if (win && !win.isDestroyed()) win.webContents.send('audio:event', msg);
  });
  audioHost.on('exit', (code) => {
    audioHost = null;
    if (win && !win.isDestroyed())
      win.webContents.send('audio:event', {
        type: 'error',
        message: `Audio host exited (code ${code}). Reopen the audio device to restart it.`,
      });
  });
  return audioHost;
}

function stopAudioHost() {
  if (!audioHost) return;
  const host = audioHost;
  audioHost = null;
  try {
    // Ask it to release the driver first — killing a process mid-stream can
    // leave an exclusive ASIO device claimed until the driver times out.
    host.postMessage({ type: 'close' });
  } catch {
    /* already gone */
  }
  try {
    host.kill();
  } catch {
    /* already gone */
  }
}

ipcMain.handle('audio:start', () => {
  startAudioHost();
  return true;
});

ipcMain.on('audio:send', (_e, msg) => {
  startAudioHost().postMessage(msg);
});

ipcMain.handle('audio:stop', () => {
  stopAudioHost();
  return true;
});

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

const AUDIO_EXTS = ['wav', 'wave', 'aif', 'aiff', 'flac', 'mp3', 'ogg', 'm4a', 'aac', 'opus'];

ipcMain.handle('dlg:openAudio', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Import audio',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Audio', extensions: AUDIO_EXTS }, { name: 'All files', extensions: ['*'] }],
  });
  return r.canceled ? null : r.filePaths;
});

ipcMain.handle('dlg:openFolder', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Import folder of samples',
    properties: ['openDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  return listAudioFiles(r.filePaths[0]);
});

ipcMain.handle('dlg:chooseDir', async (_e, title) => {
  const r = await dialog.showOpenDialog(win, {
    title: title || 'Choose folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('dlg:saveFile', async (_e, defaultName, filters) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: defaultName, filters: filters || [] });
  return r.canceled ? null : r.filePath;
});

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

async function listAudioFiles(dir) {
  const out = [];
  async function walk(d, depth) {
    if (depth > 4) return;
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (AUDIO_EXTS.includes(path.extname(e.name).slice(1).toLowerCase())) out.push(p);
    }
  }
  await walk(dir, 0);
  out.sort();
  return out;
}

ipcMain.handle('fs:read', async (_e, p) => {
  const buf = await fs.readFile(p);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
});

ipcMain.handle('fs:write', async (_e, p, data) => {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, Buffer.from(data));
  return true;
});

ipcMain.handle('fs:mkdir', async (_e, p) => {
  await fs.mkdir(p, { recursive: true });
  return true;
});

ipcMain.handle('fs:exists', async (_e, p) => {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('fs:listAudio', async (_e, dir) => listAudioFiles(dir));

ipcMain.handle('fs:join', (_e, ...parts) => path.join(...parts));
ipcMain.handle('fs:basename', (_e, p) => path.basename(p));

ipcMain.on('app:setDirty', (_e, dirty) => {
  isDirty = !!dirty;
});

ipcMain.on('app:closeReady', () => {
  forceClose = true;
  if (win && !win.isDestroyed()) win.close();
});

ipcMain.handle('app:userData', () => app.getPath('userData'));
ipcMain.handle('app:documents', () => app.getPath('documents'));

// ---------------------------------------------------------------------------
// In-app updates
//
// electron-updater against GitHub Releases (`publish` in electron-builder.yml).
// Only installed builds can update: the NSIS installer on Windows and the
// AppImage on Linux — electron-builder writes the update feed (latest.yml /
// latest-linux.yml) for those targets, and they are the ones electron-updater
// knows how to replace in place. A dev checkout or an unpacked dir reports
// `unsupported` and updates by `git pull` instead.
// ---------------------------------------------------------------------------

let updater = null; // required lazily: absent from the dev flow's hot path
let updateReady = null; // version string once the update is on disk

function updatesSupported() {
  if (process.env.SAMPLER_UPDATE_DEV) return true;
  if (!app.isPackaged) return false;
  // On Linux only the AppImage can replace itself; electron-updater finds it
  // through this variable, which the AppImage runtime sets.
  if (process.platform === 'linux') return !!process.env.APPIMAGE;
  return process.platform === 'win32';
}

function sendToRenderer(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function getUpdater() {
  if (updater) return updater;
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = false; // the user opts in
  // A downloaded update still lands if the user just quits instead of
  // restarting from the prompt.
  autoUpdater.autoInstallOnAppQuit = true;
  if (process.env.SAMPLER_UPDATE_DEV) autoUpdater.forceDevUpdateConfig = true;
  autoUpdater.on('download-progress', (p) => {
    sendToRenderer('updates:progress', {
      percent: p.percent || 0,
      transferred: p.transferred || 0,
      total: p.total || 0,
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    updateReady = info.version || '';
  });
  updater = autoUpdater;
  return updater;
}

ipcMain.handle('updates:check', async () => {
  const current = app.getVersion();
  if (!updatesSupported()) return { state: 'unsupported', current };
  if (updateReady !== null) return { state: 'downloaded', current, version: updateReady };
  try {
    const r = await getUpdater().checkForUpdates();
    // electron-updater signals "nothing newer" by echoing the current version,
    // not by returning null.
    const info = r && r.updateInfo;
    if (!info || !info.version || info.version === current || r.isUpdateAvailable === false)
      return { state: 'none', current };
    const notes = typeof info.releaseNotes === 'string' ? info.releaseNotes : '';
    return { state: 'available', current, version: info.version, notes, date: info.releaseDate || '' };
  } catch (e) {
    return { state: 'error', current, error: describeUpdateError(e) };
  }
});

/** electron-updater errors carry full HTTP headers; keep what a person needs. */
function describeUpdateError(e) {
  const raw = (e && e.message) || String(e);
  if (/\b404\b/.test(raw))
    return 'No release feed found. Either nothing has been released yet, or the repository is private ' +
      '(the app downloads anonymously, so releases must be public).';
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|net::/.test(raw)) return 'No connection to github.com.';
  return raw.split('\n')[0];
}

ipcMain.handle('updates:download', async () => {
  if (!updatesSupported()) return { ok: false, error: 'Not an installed build.' };
  if (updateReady !== null) return { ok: true, version: updateReady };
  try {
    await getUpdater().downloadUpdate();
    // `update-downloaded` normally fires first; don't let a missed event leave
    // a finished download uninstallable.
    if (updateReady === null) updateReady = '';
    return { ok: true, version: updateReady };
  } catch (e) {
    return { ok: false, error: describeUpdateError(e) };
  }
});

ipcMain.handle('updates:install', async () => {
  if (updateReady === null) return { ok: false, error: 'No update has been downloaded.' };
  // The renderer refuses to get here with unsaved changes, so skipping the
  // close prompt is safe. Release the audio driver before the process goes.
  forceClose = true;
  stopAudioHost();
  setImmediate(() => getUpdater().quitAndInstall(true, true));
  return { ok: true };
});

ipcMain.handle('app:version', () => app.getVersion());
