// test-storage.js — quick unit test of the storage module (plain node, no Electron)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { createStorage } = require('./storage');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-storage-'));
const storage = createStorage({ preferredDir: dir, fallbackDir: null });

const sample = {
  groups: [],
  products: [{ id: 'p1', name: 'Sharbat Rose', batchOutput: 360, materials: [{ name: 'Sugar', qty: 2, unit: 'kg' }] }],
  production: [{ id: 'r1', date: '2026-08-21', productId: 'p1', batches: 2, bottles: 720 }],
  sales: [{ id: 's1', date: '2026-08-21', customer: 'Test Shop', items: [{ productId: 'p1', dozen: 10 }] }],
  inventory: [{ id: 'i1', date: '2026-08-21', itemName: 'Sugar', movement: 'received', quantity: 50, unit: 'kg', notes: '' }]
};

// 1. empty load
assert.strictEqual(storage.loadData(), null);

// 1b. ensureInitialized creates an empty workspace on first launch (fixes "no backup data found")
const init = storage.ensureInitialized();
assert.ok(init && Array.isArray(init.products) && init.products.length === 0);
assert.ok(fs.existsSync(path.join(dir, 'maaz-dawakhana.json')), 'data file created on first launch');

// 2. save + load round-trip
storage.saveData(sample);
const loaded = storage.loadData();
assert.deepStrictEqual(loaded, sample);

// 3. file exists on disk next to app data dir
assert.ok(fs.existsSync(path.join(dir, 'maaz-dawakhana.json')));

// 4. autoBackup creates dated copy and prunes
for (let i = 0; i < 14; i++) storage.autoBackup();
const backups = fs.readdirSync(path.join(dir, 'backups')).filter((f) => f.startsWith('auto-'));
assert.ok(backups.length <= 10, `expected <=10 auto backups, got ${backups.length}`);

// 5. backup payload wraps data with schema
const payload = storage.makeBackupPayload(sample);
assert.strictEqual(payload.app, 'Maaz Dawakhana');
assert.strictEqual(payload.format, 'maaz-dawakhana-backup');
assert.strictEqual(payload.schemaVersion, 1);
assert.strictEqual(payload.generatedBy, 'windows');
assert.deepStrictEqual(payload.data.products, sample.products);
assert.deepStrictEqual(payload.data.groups, []);

// 6. parseBackupFile accepts wrapped backup (normalized shape)
const backupPath = path.join(dir, 'manual-backup.json');
fs.writeFileSync(backupPath, JSON.stringify(payload, null, 2));
const parsedManual = storage.parseBackupFile(backupPath);
assert.strictEqual(parsedManual.products[0].name, 'Sharbat Rose');
assert.strictEqual(parsedManual.products[0].id, 'p1');
assert.strictEqual(parsedManual.products[0].groupId, '');
assert.strictEqual(parsedManual.sales[0].customer, 'Test Shop');
assert.strictEqual(parsedManual.sales[0].items[0].dozen, 10);
assert.deepStrictEqual(parsedManual.groups, []);

// 7. parseBackupFile rejects garbage
fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({ foo: 1 }));
assert.throws(() => storage.parseBackupFile(path.join(dir, 'bad.json')));

// 8. paths()
const p = storage.paths();
assert.strictEqual(p.dataDir, dir);
assert.ok(p.dataFile.endsWith('maaz-dawakhana.json'));

// 9. invalid save rejected
assert.throws(() => storage.saveData({ products: 'nope' }));

// 10. tolerant raw workspace JSON load (old web export shape)
fs.writeFileSync(path.join(dir, 'maaz-dawakhana.json'), JSON.stringify(sample));
assert.deepStrictEqual(storage.loadData(), sample);

// 11. unwritable preferred dir -> automatic fallback (fixes EPERM restore in Program Files)
const blocker = path.join(os.tmpdir(), 'md-blocker-' + Date.now());
fs.writeFileSync(blocker, 'x'); // a FILE where a folder is expected
const fallbackDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-fallback-'));
const fbStorage = createStorage({ preferredDir: path.join(blocker, 'data'), fallbackDir });
fbStorage.ensureInitialized();
const fp = fbStorage.paths();
assert.strictEqual(fp.location, 'appdata', 'should report appdata fallback');
assert.ok(fs.existsSync(path.join(fallbackDir, 'maaz-dawakhana.json')), 'data saved in fallback dir');
fbStorage.saveData(sample);
assert.deepStrictEqual(fbStorage.loadData(), sample, 'fallback storage round-trips');
fs.unlinkSync(blocker);


// ---- v1.0.4 additions: BOM groups + shared backup format ----

// 10. groups round-trip
const withGroups = {
  groups: [{ id: 'g1', name: 'Syrups' }, { id: 'g2', name: 'Lozenges' }],
  products: [{ id: 'p1', name: 'Sharbat Rose', groupId: 'g1', batchOutput: 360, materials: [{ name: 'Sugar', qty: 2, unit: 'kg' }] }],
  production: [{ id: 'r1', date: '2026-08-21', productId: 'p1', batches: 2, bottles: 720 }],
  sales: [{ id: 's1', date: '2026-08-21', customer: 'Test Shop', items: [{ productId: 'p1', dozen: 10 }] }],
  inventory: [{ id: 'i1', date: '2026-08-21', itemName: 'Sugar', movement: 'received', quantity: 50, unit: 'kg', notes: '' }]
};
storage.saveData(withGroups);
assert.deepStrictEqual(storage.loadData(), withGroups, 'groups survive save/load round-trip');

// 11. legacy data without groups still loads (groups defaulted to [])
const legacy = JSON.parse(JSON.stringify(sample));
delete legacy.groups;
storage.saveData(legacy);
assert.deepStrictEqual(storage.loadData().groups, [], 'missing groups default to []');

// 12. shared backup format payload
const payload2 = storage.makeBackupPayload(withGroups);
assert.strictEqual(payload2.format, 'maaz-dawakhana-backup');
assert.strictEqual(payload2.schemaVersion, 1);
assert.strictEqual(payload2.generatedBy, 'windows');
assert.strictEqual(payload2.counts.groups, 2);
assert.deepStrictEqual(payload2.data.groups, withGroups.groups);

// 13. parseBackupFile accepts shared-format file
const sharedPath = path.join(dir, 'shared-backup.json');
fs.writeFileSync(sharedPath, JSON.stringify(payload2, null, 2));
const parsed = storage.parseBackupFile(sharedPath);
assert.strictEqual(parsed.groups.length, 2, 'groups parsed from shared backup');
assert.strictEqual(parsed.products[0].groupId, 'g1', 'product groupId resolved');

// 14. group-by-name resolution: product referencing a group name gets a real id
const byNamePath = path.join(dir, 'byname-backup.json');
fs.writeFileSync(byNamePath, JSON.stringify({
  format: 'maaz-dawakhana-backup', schemaVersion: 1,
  data: {
    groups: [{ id: 'gx', name: 'Syrups' }],
    products: [{ id: 'p9', name: 'Sharbat Mint', group: 'Syrups', materials: [] }],
    production: [], sales: [], inventory: []
  }
}));
const parsedByName = storage.parseBackupFile(byNamePath);
assert.ok(parsedByName.products[0].groupId, 'group resolved by name');
assert.strictEqual(parsedByName.products[0].groupId, 'gx', 'name matched to existing group id');

// 15. PascalCase + dd/mm/yyyy leniency (website-export style)
const pascalPath = path.join(dir, 'pascal-backup.json');
fs.writeFileSync(pascalPath, JSON.stringify({
  format: 'maaz-dawakhana-backup',
  data: {
    Groups: [{ Id: 'gg1', Name: 'Tablets' }],
    Products: [{ Id: 'pp1', Name: 'Panadol', GroupId: 'Tablets', BatchOutput: 500, Materials: [{ Name: 'Paracetamol', Qty: 1, Unit: 'kg' }] }],
    Production: [{ Id: 'rr1', ProductId: 'pp1', Date: '21/08/2026', Batches: 3, Bottles: 1500 }],
    Sales: [{ Id: 'ss1', Date: '21/08/2026', Customer: 'Pharma Store', ProductId: 'pp1', Dozen: 20 }],
    Inventory: [{ Id: 'ii1', ItemName: 'Paracetamol', Date: '21/08/2026', Movement: 'Received', Quantity: 100, Unit: 'kg' }]
  }
}));
const parsedPascal = storage.parseBackupFile(pascalPath);
assert.strictEqual(parsedPascal.products[0].name, 'Panadol');
assert.strictEqual(parsedPascal.products[0].groupId, 'gg1', 'PascalCase GroupId resolved via name map');
assert.strictEqual(parsedPascal.production[0].date, '2026-08-21', 'dd/mm/yyyy normalized to ISO');
assert.strictEqual(parsedPascal.sales[0].date, '2026-08-21');
assert.strictEqual(parsedPascal.inventory[0].date, '2026-08-21');
assert.strictEqual(parsedPascal.inventory[0].quantity, 100);

console.log('storage tests (incl. groups + shared backup format): ALL PASS');

console.log('ALL STORAGE TESTS PASSED (incl. groups + shared backup format)');
fs.rmSync(dir, { recursive: true, force: true });
