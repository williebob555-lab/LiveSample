// Electron host. The renderer holds the whole app; main only provides the
// things a browser cannot: native dialogs and direct filesystem access for
// .sinst instrument folders (which hold hundreds of MB of samples and must
// never be copied through IndexedDB).
const { app, BrowserWindow, ipcMain, dialog, utilityProcess } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');

const DEV_URL = process.env.SAMPLER_DEV_URL || '';

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
