# Maaz Dawakhana — Windows Desktop Edition

The Maaz Dawakhana BOM & Production Control app, converted from the Firebase
website into a **fully offline Windows application**:

- ❌ **No login system** — the app opens straight into the dashboard.
- ✅ **Local data only** — everything is saved in a JSON file in a `data`
  folder **next to the installed app**. No internet, no account, no cloud.
- ✅ **Backup & restore built in** — one click saves a copy of your data
  anywhere (USB, email, another folder), and one click restores it. Backup
  always works, even with an empty workspace.
- ✅ **Clean custom title bar** — the app runs in a frameless window with its
  own minimize / maximize / close buttons that match the app design. Drag the
  top bar to move the window; double-click it to maximize.
- ✅ Everything else works exactly like the website: BOM system, production
  log, sales & inventory, standalone inventory, raw material analytics,
  dashboard with charts, styled **Excel export** (BOM / Production / Sales /
  Inventory / Dashboard / Raw Usage), and **invoice PDF printing** using the
  original template.

---

## Install on Windows

1. Download `Maaz-Dawakhana-Setup-1.0.1.exe`.
2. Double-click it and follow the installer. You can pick your own folder.
3. Launch **Maaz Dawakhana** from the desktop or Start menu.
4. Done — no account, no email, no password.

> Windows may show a blue "Windows protected your PC" (SmartScreen) screen
> because the installer is not code-signed. Click **More info → Run anyway**.
> This only happens with unsigned installers; the app itself is safe and
> works fully offline.

---

## Where your data lives

| Item | Location |
|---|---|
| Main data file | `<install folder>\data\maaz-dawakhana.json` *(or user AppData folder if the install folder is protected, e.g. Program Files)* |
| Automatic backups (last 10, made at every launch) | `<install folder>\data\backups\auto-*.json` |
| Manual backups (your choice) | wherever you save them |

The data file is plain JSON, so you can also read/copy it manually at any time.

## Backup & restore

- **Backup data…** (sidebar button, or menu *File → Backup data…*, or `Ctrl+B`)
  — saves a dated backup file wherever you choose. Keep it on a USB stick,
  email it to yourself, whatever.
- **Restore data…** (`Ctrl+R`) — pick a backup file (or any Maaz Dawakhana
  JSON) and the app replaces the current workspace with it. A safety
  auto-backup of the current data is taken first.
- **Reset workspace** — wipes the workspace to start fresh.

### Moving from the website to this app

If you used the online version and want your existing records here:

1. In the app's sidebar click **Restore data…** and choose any JSON that
   contains your `products`, `production`, `sales` and `inventory` arrays —
   for example a Firestore export of your workspace document. The app will
   import it.

## Uninstalling

When you uninstall the app, your `data` folder is **preserved** at
`%APPDATA%\Maaz Dawakhana\preserved-data` automatically. Reinstall the app
and use **Restore data…** to bring your records back.

---

## For developers

```bash
npm install          # install Electron etc.
npm start            # run the app in dev mode (data saved to ./data)
npm run test:storage # unit tests for the local storage engine
node electron/test-renderer.js   # jsdom boot test of the UI
npm run dist         # build the Windows installer (NSIS) into release/
```

### Project layout

```
electron/
  main.js        # window, menus, file dialogs, download handling, IPC
  preload.js     # safe bridge (window.desktopAPI) exposed to the UI
  storage.js     # local JSON persistence, auto-backups, backup/restore
app/
  index.html     # UI (login screen removed)
  app.js         # the original app logic, patched to local storage
  styles.css     # original styling + locally bundled fonts
  exceljs.min.js # Excel export engine (local)
  pdf-lib.min.js # invoice PDF engine (local)
  template.pdf   # original invoice template
  fonts/         # DM Sans + Space Grotesk (offline)
build/
  icon.ico       # installer icon (from logo.png)
  installer.nsh  # keeps data folder on uninstall
```

The UI is the original website code with these changes:

- Firebase config, auth screens and sign-in/sign-out logic removed.
- `window.desktopAPI` (preload bridge) replaced Firebase reads/writes with
  local file reads/writes via the main process.
- Excel/PDF downloads now use native Windows save dialogs.
- Sidebar now has **Backup data…** and **Restore data…** buttons plus a
  "Local workspace" status showing the data file path.
