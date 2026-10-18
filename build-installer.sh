#!/usr/bin/env bash
# build-installer.sh — one-shot build of the Windows installer (no wine needed):
#   1. electron-builder packages the app (stops before the wine-only step, but
#      produces win-unpacked, the uninstaller stub, and the logged NSIS script)
#   2. generate the NSIS language message includes
#   3. finish-nsis.sh: stamp exe+uninstaller, rebuild payload, final makensis pass
set -euo pipefail
cd "$(dirname "$0")"

echo "== A. electron-builder packaging (expect it to stop at the wine step) =="
CSC_IDENTITY_AUTO_DISCOVERY=false DEBUG=electron-builder npx electron-builder --win nsis --x64 2>&1 | tail -2 || true

echo "== B. regenerate language message includes =="
node generate-messages.js

echo "== C. extract the logged NSIS script and repoint temp includes =="
node -e "
const yaml = require('js-yaml');
const fs = require('fs');
const data = yaml.load(fs.readFileSync('release/builder-debug.yml', 'utf8'));
if (!data.nsis || !data.nsis.script) { console.error('nsis.script not in debug log'); process.exit(1); }
fs.writeFileSync('release/nsis-script.nsi', data.nsis.script);
console.log('script extracted:', data.nsis.script.length, 'chars');
"
sed -i "s|/tmp/t-[A-Za-z0-9]*/0-messages.nsh|$(pwd)/release/0-messages.nsh|; s|/tmp/t-[A-Za-z0-9]*/1-messages.nsh|$(pwd)/release/1-messages.nsh|" release/nsis-script.nsi

echo "== D. finish the installer =="
./finish-nsis.sh

echo
echo "INSTALLER READY: release/Maaz-Dawakhana-Setup-1.0.7.exe"
