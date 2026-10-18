// stamp-exe.js — set icon + version metadata on the Windows exe without wine.
// Pure-JS PE resource editing (resedit + pe-library).
'use strict';
const fs = require('fs');
const PELibrary = require('pe-library');
const ResEdit = require('resedit');

const [exePath, icoPath] = process.argv.slice(2);
if (!exePath || !icoPath) {
  console.error('usage: node stamp-exe.js <app.exe> <icon.ico>');
  process.exit(1);
}

const exe = PELibrary.NtExecutable.from(fs.readFileSync(exePath));
const res = PELibrary.NtExecutableResource.from(exe);

// --- icon ---
const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(icoPath));
const groupIds = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries).map((entry) => entry.id);
if (!groupIds.length) { console.error('no icon groups found in exe'); process.exit(1); }
groupIds.forEach((id) => {
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
    res.entries, id, 1033, iconFile.icons.map((item) => item.data)
  );
});
console.log('replaced icon groups:', groupIds.join(', '));

// --- version info ---
const viList = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
if (!viList.length) { console.error('no version info found'); process.exit(1); }
viList.forEach((vi) => {
  vi.setFileVersion(1, 0, 8, 0, 1033);
  vi.setProductVersion(1, 0, 8, 0, 1033);
  vi.setStringValues({ lang: 1033, codepage: 1200 }, {
    FileDescription: 'Demo BOM & Production Control',
    ProductName: 'Demo',
    CompanyName: 'Demo',
    LegalCopyright: 'Demo',
    InternalName: 'Demo',
    OriginalFilename: 'Demo.exe'
  });
  vi.outputToResourceEntries(res.entries);
});
console.log('version info set');

res.outputResource(exe);
const out = Buffer.from(exe.generate());
fs.writeFileSync(exePath, out);
console.log(`stamped ${exePath} (${out.length} bytes)`);
