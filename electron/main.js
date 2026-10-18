// main.js — Demo (BOM & Production) for Windows (Electron main process)
'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { createStorage } = require('./storage');

const APP_NAME = 'Demo';

// Data lives in a "data" folder next to the installed app by preference.
// If that folder is not writable (typical when installed under
// C:\Program Files), it automatically falls back to the user's AppData
// folder, which Windows always allows writing to.
function dataDir() {
  if (app.isPackaged) {
    return {
      preferredDir: path.join(path.dirname(process.execPath), 'data'),
      fallbackDir: path.join(app.getPath('appData'), 'Demo', 'data'),
      // Data folder of pre-rebrand builds, scanned once during migration.
      legacyDirs: [path.join(app.getPath('appData'), 'Maaz Dawakhana', 'data')]
    };
  }
  return { preferredDir: path.join(__dirname, '..', 'data'), fallbackDir: null, legacyDirs: [] };
}

const storage = createStorage(dataDir());

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1080,
    minHeight: 680,
    title: `${APP_NAME} — BOM & Production`,
    icon: path.join(__dirname, '..', 'app', 'logo.png'),
    frame: false, // custom title bar with own minimize/maximize/close buttons
    transparent: true, // lets the CSS rounded corners + shadow show through
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'app', 'index.html'));

  // Open external links in the default browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Excel / PDF downloads: intercept and ask where to save.
  mainWindow.webContents.session.on('will-download', (event, item) => {
    // Stop Electron's default "save to Downloads" behaviour — we decide where
    // the file goes via our own dialog below (exactly one save window).
    event.preventDefault();
    const filename = item.getFilename();
    const ext = path.extname(filename).toLowerCase() || '.xlsx';
    const base = path.basename(filename, ext);
    const filterName = ext === '.pdf' ? 'PDF document' : ext === '.json' ? 'JSON backup' : 'Excel workbook';
    dialog.showSaveDialog(mainWindow, {
      title: `Save ${ext === '.pdf' ? 'PDF' : 'Excel'} file`,
      defaultPath: path.join(app.getPath('downloads'), `${base}${ext}`),
      filters: [{ name: filterName, extensions: [ext.slice(1)] }]
    }).then(({ canceled, filePath }) => {
      if (canceled || !filePath) { item.cancel(); return; }
      item.setSavePath(filePath);
      item.once('done', (event, state) => {
        if (state === 'completed' && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('download-done', filePath);
        }
      });
    }).catch((err) => console.error('download dialog failed:', err));
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  // Tell the renderer whenever the maximized state changes (to swap the icon).
  const sendMaximized = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window-maximized', mainWindow.isMaximized());
    }
  };
  mainWindow.on('maximize', sendMaximized);
  mainWindow.on('unmaximize', sendMaximized);
  mainWindow.webContents.once('did-finish-load', sendMaximized);
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Backup data…', accelerator: 'Ctrl+B', click: () => sendMenu('backup') },
        { label: 'Restore data…', accelerator: 'Ctrl+R', click: () => sendMenu('restore') },
        { type: 'separator' },
        { label: 'Export Excel…', accelerator: 'Ctrl+E', click: () => sendMenu('export-excel') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit', label: 'Exit' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload', label: 'Reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Data location…',
          click: () => {
            const p = storage.paths();
            const note = p.location === 'appdata'
              ? '\n\nThe install folder is protected by Windows (e.g. Program Files), so your data is saved in your user profile folder instead — this is normal and safe.'
              : '';
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'Data location',
              message: 'Your data is saved locally on this PC',
              detail: `Data file:\n${p.dataFile}\n\nAuto backups:\n${p.backupsDir} (${p.autoBackupCount} kept)\n\nTip: use File → Backup data… to save a copy anywhere (USB drive, email, etc.).${note}`,
              buttons: ['OK', 'Open folder']
            }).then(({ response }) => {
              if (response === 1) shell.openPath(p.dataDir);
            });
          }
        },
        {
          label: 'About Demo',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'About',
              message: `${APP_NAME} — Production Control`,
              detail: `Version ${app.getVersion()}\n\nLocal desktop edition: no account, no internet needed.\nAll data is stored in a file next to this app.\n\nBuilt on Electron.`
            });
          }
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function sendMenu(action) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('menu', action);
  }
}

// ---- IPC: renderer <-> main ----
ipcMain.handle('desktop:load', () => storage.loadData());
ipcMain.handle('desktop:save', (_event, data) => {
  try {
    storage.saveData(data);
    return { ok: true };
  } catch (err) {
    console.error('save failed:', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('desktop:backup', async (_event, payloadText) => {
  try {
    // The renderer passes the exact live workspace payload. If absent, fall
    // back to whatever is on disk (or an empty workspace — the action never
    // fails with "no data").
    let data;
    if (typeof payloadText === 'string' && payloadText) {
      const parsed = JSON.parse(payloadText);
      data = parsed && parsed.data && storage.isValidWorkspace(parsed.data) ? parsed.data : parsed;
    } else {
      data = storage.loadData() || { products: [], production: [], sales: [], inventory: [], groups: [] };
    }
    if (!storage.isValidWorkspace(data)) throw new Error('No workspace data to back up');
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const defaultPath = path.join(app.getPath('documents'), `${APP_NAME}-Backup-${stamp}.json`);
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Backup data',
      defaultPath,
      filters: [{ name: 'Demo backup', extensions: ['json'] }]
    });
    if (canceled || !filePath) return { cancelled: true };
    const payload = storage.makeBackupPayload(data);
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
    return { ok: true, path: filePath, counts: payload.counts };
  } catch (err) {
    console.error('backup failed:', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('desktop:restore', async () => {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Restore data',
      filters: [
        { name: 'Demo backup or data JSON', extensions: ['json'] },
        { name: 'All files', extensions: ['*'] }
      ],
      properties: ['openFile']
    });
    if (canceled || !filePaths || !filePaths.length) return { cancelled: true };
    const data = storage.parseBackupFile(filePaths[0]);
    // Safety: keep an auto backup of current data before replacing it.
    storage.autoBackup();
    storage.saveData(data);
    return { ok: true, data, path: filePaths[0] };
  } catch (err) {
    console.error('restore failed:', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('desktop:savePdf', async (_event, bytes, saleId, customerName) => {
  try {
    const safeCustomer = String(customerName || 'invoice').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'invoice';
    const defaultName = `Invoice_${safeCustomer}_${String(saleId).slice(0, 8)}.pdf`;
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Save invoice PDF',
      defaultPath: path.join(app.getPath('documents'), defaultName),
      filters: [{ name: 'PDF document', extensions: ['pdf'] }]
    });
    if (canceled || !filePath) return { cancelled: true };
    fs.writeFileSync(filePath, Buffer.from(bytes));
    shell.openPath(filePath);
    return { ok: true, path: filePath };
  } catch (err) {
    console.error('savePdf failed:', err);
    return { ok: false, error: err.message };
  }
});

// Optional print: open the PDF in a hidden window and send it to the system
// print dialog. The temp file is removed as soon as the dialog closes.
ipcMain.handle('desktop:printPdf', async (_event, bytes) => {
  const tmpPath = path.join(app.getPath('temp'), `demo-print-${Date.now()}.pdf`);
  try {
    fs.writeFileSync(tmpPath, Buffer.from(bytes));
    const printWin = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: false }
    });
    await printWin.loadFile(tmpPath);
    // Give the PDF viewer a moment to rasterize, then open the print dialog.
    setTimeout(() => {
      printWin.webContents.print({ silent: false }, () => {
        if (!printWin.isDestroyed()) printWin.destroy();
        try { fs.unlinkSync(tmpPath); } catch { /* already gone */ }
      });
    }, 900);
    return { ok: true };
  } catch (err) {
    console.error('printPdf failed:', err);
    try { fs.unlinkSync(tmpPath); } catch { /* already gone */ }
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('desktop:paths', () => storage.paths());
ipcMain.handle('desktop:version', () => app.getVersion());

// ---- Custom window controls (frameless window) ----
ipcMain.handle('desktop:winMinimize', () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.handle('desktop:winToggleMaximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.handle('desktop:winClose', () => { if (mainWindow) mainWindow.close(); });
ipcMain.handle('desktop:winIsMaximized', () => (mainWindow ? mainWindow.isMaximized() : false));

ipcMain.handle('desktop:showDataLocation', async () => {
  try {
    const p = storage.paths();
    const note = p.location === 'appdata'
      ? '\n\nThe install folder is protected by Windows (e.g. Program Files), so your data is saved in your user profile folder instead — this is normal and safe.'
      : '';
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Data location',
      message: 'Your data is saved locally on this PC',
      detail: `Data file:\n${p.dataFile}\n\nAuto backups:\n${p.backupsDir} (${p.autoBackupCount} kept)\n\nTip: use Backup data… to save a copy anywhere (USB drive, email, etc.).${note}`,
      buttons: ['OK', 'Open folder']
    });
    if (response === 1) shell.openPath(p.dataDir);
  } catch (err) {
    console.error('showDataLocation failed:', err.message);
  }
});

// ---- App lifecycle ----
app.setName(APP_NAME);

app.whenReady().then(() => {
  buildMenu();
  createWindow();

  // Make sure the data file exists (creates an empty workspace on first
  // launch), then roll an automatic backup (keeps the last 10). Never let a
  // storage problem crash the app at startup.
  try {
    storage.ensureInitialized();
    const backup = storage.autoBackup();
    console.log(backup ? `Auto backup: ${backup}` : 'Nothing to back up yet.');
  } catch (err) {
    console.error('Startup data init failed:', err.message);
  }

  // Smoke-test hook: run the app, let it boot, then exit with a marker file.
  if (process.env.SMOKE_TEST) {
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        const viewLen = await mainWindow.webContents.executeJavaScript(
          'document.querySelector("#appView") ? document.querySelector("#appView").innerHTML.length : -1'
        );
        const hasAPI = await mainWindow.webContents.executeJavaScript('typeof window.desktopAPI');
        const paths = await mainWindow.webContents.executeJavaScript('window.desktopAPI.paths()');
        const result = { viewLen, hasAPI, paths, ok: viewLen > 100 && hasAPI === 'object' && !!paths.dataFile };
        console.log('SMOKE RESULT:', JSON.stringify(result, null, 2));
        fs.writeFileSync(process.env.SMOKE_TEST, JSON.stringify(result));
      } catch (err) {
        const result = { error: err.message, ok: false };
        console.log('SMOKE ERROR:', err.message);
        fs.writeFileSync(process.env.SMOKE_TEST, JSON.stringify(result));
      }
      app.quit();
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
