// storage.js — pure Node module: local file persistence, backups, restore.
// No Electron imports so it can be unit-tested with plain node.
// The data location is resolved with a fallback: it prefers a "data" folder
// next to the installed app, but if that location is not writable (e.g. the
// app is installed under C:\Program Files), it automatically falls back to a
// user-writable folder (AppData).
//
// Backup files use the shared "maaz-dawakhana-backup" format (schema v1) so
// the same .json file works in the desktop app and the website: groups,
// products, production, sales and inventory in one payload. The parser is
// lenient: it accepts our own payload, a bare workspace object, a
// { data: {...} } wrapper, PascalCase keys, and dd/mm/yyyy or ISO dates.
'use strict';

const fs = require('fs');
const path = require('path');

const SCHEMA = 1;
const MAX_AUTO_BACKUPS = 10;
const BACKUP_FORMAT = 'maaz-dawakhana-backup';
const BACKUP_SCHEMA_VERSION = 1;
const BACKUP_SECTIONS = ['groups', 'products', 'production', 'sales', 'inventory'];

function newId() {
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// Case-insensitive property lookup so PascalCase files work.
function pick(source, ...keys) {
  if (!source || typeof source !== 'object') return undefined;
  const lower = {};
  Object.keys(source).forEach((key) => { lower[key.toLowerCase()] = source[key]; });
  for (const key of keys) {
    const value = lower[String(key).toLowerCase()];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function toISODate(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

function normalizeBackupDate(value) {
  if (!value) return '';
  if (value instanceof Date) return toISODate(value);
  const text = String(value).trim();
  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);                 // ISO / ISO date-time
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  match = text.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/);       // dd/mm/yyyy
  if (match) return `${match[3]}-${String(match[2]).padStart(2, '0')}-${String(match[1]).padStart(2, '0')}`;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? '' : toISODate(parsed);
}

function num(value, fallback = 0) {
  const parsed = Number(String(value ?? '').toString().replace(/[,\s]/g, ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeProductRecord(raw) {
  const name = String(pick(raw, 'name', 'productName', 'product') ?? '').trim();
  if (!name) return null;
  const materialsRaw = pick(raw, 'materials', 'rawMaterials', 'bom') || [];
  const materials = (Array.isArray(materialsRaw) ? materialsRaw : []).map((material) => ({
    name: String(pick(material, 'name', 'materialName', 'material') ?? '').trim(),
    qty: pick(material, 'qty', 'quantity', 'amount') ?? '',
    unit: String(pick(material, 'unit', 'uom') ?? '').trim()
  })).filter((material) => material.name);
  const groupValue = pick(raw, 'groupId', 'group', 'groupName', 'category');
  const record = { id: String(pick(raw, 'id', 'productId', 'guid') ?? newId()), name, groupId: '', batchOutput: num(pick(raw, 'batchOutput', 'outputPerBatch', 'bottlesPerBatch')), materials };
  if (groupValue !== undefined) record.__group = String(groupValue);   // resolved to a real group id below
  return record;
}

function normalizeGroupRecord(raw) {
  if (typeof raw === 'string') { const name = raw.trim(); return name ? { id: newId(), name } : null; }
  const name = String(pick(raw, 'name', 'groupName', 'title') ?? '').trim();
  if (!name) return null;
  return { id: String(pick(raw, 'id', 'groupId', 'guid') ?? newId()), name };
}

function normalizeProductionRecord(raw) {
  const date = normalizeBackupDate(pick(raw, 'date', 'productionDate', 'createdAt'));
  const productId = String(pick(raw, 'productId', 'product', 'productid') ?? '').trim();
  if (!date && !productId) return null;
  return {
    id: String(pick(raw, 'id', 'guid') ?? newId()),
    date,
    productId,
    batches: num(pick(raw, 'batches', 'batchCount')),
    bottles: num(pick(raw, 'bottles', 'bottlesProduced', 'quantity'))
  };
}

function normalizeSaleRecord(raw) {
  const date = normalizeBackupDate(pick(raw, 'date', 'saleDate', 'shippedOn'));
  let items = pick(raw, 'items', 'lines', 'products');
  if (!Array.isArray(items) || !items.length) {
    items = [{ productId: pick(raw, 'productId', 'product'), dozen: pick(raw, 'dozen', 'quantity', 'qty'), customName: pick(raw, 'customName', 'productName') }];
  }
  const cleanItems = items.map((item) => {
    const customName = String(pick(item, 'customName', 'productName', 'name') ?? '').trim();
    let productId = String(pick(item, 'productId', 'product', 'id') ?? '').trim();
    if (!productId && customName) productId = `external:${customName.toLowerCase()}`;
    const record = { productId, dozen: num(pick(item, 'dozen', 'quantity', 'qty')) };
    if (customName && (productId.startsWith('external:') || pick(item, 'customName'))) record.customName = customName;
    return record;
  }).filter((item) => item.productId && item.dozen > 0);
  if (!cleanItems.length) return null;
  return {
    id: String(pick(raw, 'id', 'guid') ?? newId()),
    date,
    customer: String(pick(raw, 'customer', 'customerName', 'client') ?? ''),
    phone: String(pick(raw, 'phone', 'phoneNumber', 'contact') ?? ''),
    address: String(pick(raw, 'address') ?? ''),
    proforma: String(pick(raw, 'proforma', 'proformaNo', 'invoiceNo') ?? ''),
    productId: cleanItems[0].productId,
    dozen: cleanItems.reduce((sum, item) => sum + item.dozen, 0),
    items: cleanItems,
    receipt: pick(raw, 'receipt', 'total', 'amount') ?? ''
  };
}

function normalizeInventoryRecord(raw) {
  const itemName = String(pick(raw, 'itemName', 'name', 'material', 'productName') ?? '').trim();
  if (!itemName) return null;
  const movementRaw = String(pick(raw, 'movement', 'type', 'direction') ?? 'received').toLowerCase();
  const movement = /use|out|issue|consum|-/.test(movementRaw) ? 'used' : 'received';
  return {
    id: String(pick(raw, 'id', 'guid') ?? newId()),
    date: normalizeBackupDate(pick(raw, 'date', 'movementDate')),
    itemName,
    movement,
    quantity: num(pick(raw, 'quantity', 'qty', 'amount')),
    unit: String(pick(raw, 'unit', 'uom') ?? ''),
    notes: String(pick(raw, 'notes', 'note', 'remarks') ?? '')
  };
}

// Legacy inventory records with separate bottle/box/carton counts expand into
// one received movement per unit (same behaviour as the renderer).
function migrateInventory(records) {
  return records.flatMap((item) => {
    if (item.quantity !== undefined) return [item];
    const name = item.productName || 'Inventory item';
    return [['bottles', item.bottles], ['boxes', item.boxes], ['cartons', item.cartons]]
      .filter(([, qty]) => Number(qty) > 0)
      .map(([unit, qty]) => ({ id: `${item.id}-${unit}`, date: item.date, itemName: name, movement: 'received', quantity: Number(qty), unit, notes: item.notes || 'Imported opening stock' }));
  });
}

// A product may reference its group by id or simply by name (the Windows app
// may store just a text category). Turn either one into a real group record.
function resolveImportedGroups(normalized) {
  const byId = new Map(normalized.groups.map((group) => [String(group.id), group]));
  const byName = new Map(normalized.groups.map((group) => [group.name.trim().toLowerCase(), group]));
  normalized.products.forEach((product) => {
    const raw = product.__group;
    delete product.__group;
    if (!raw) { product.groupId = ''; return; }
    const key = String(raw).trim();
    if (!key) { product.groupId = ''; return; }
    let group = byId.get(key) || byName.get(key.toLowerCase());
    if (!group) { group = { id: newId(), name: key }; normalized.groups.push(group); byId.set(group.id, group); byName.set(group.name.toLowerCase(), group); }
    product.groupId = group.id;
  });
  return normalized;
}

function createStorage({ preferredDir, fallbackDir }) {
  let activeDir = null;
  let usingFallback = false;

  function writable(dir) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });
      const probe = path.join(dir, '.probe');
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      return true;
    } catch (err) {
      return false;
    }
  }

  function resolveDir() {
    if (activeDir) return activeDir;
    if (preferredDir && writable(preferredDir)) {
      activeDir = preferredDir;
      usingFallback = false;
      return activeDir;
    }
    if (fallbackDir && writable(fallbackDir)) {
      activeDir = fallbackDir;
      usingFallback = true;
      return activeDir;
    }
    throw new Error('No writable data location found');
  }

  function dataFile() { return path.join(resolveDir(), 'maaz-dawakhana.json'); }
  function backupsDir() { return path.join(resolveDir(), 'backups'); }

  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
  }

  // groups is optional (older files predate it); everything else is required.
  function isValidWorkspace(data) {
    return !!data &&
      Array.isArray(data.products) &&
      Array.isArray(data.production) &&
      Array.isArray(data.sales) &&
      Array.isArray(data.inventory);
  }

  function normalizeWorkspace(data) {
    return {
      groups: Array.isArray(data.groups) ? data.groups : [],
      products: data.products,
      production: data.production,
      sales: data.sales,
      inventory: data.inventory
    };
  }

  function loadData() {
    try {
      const file = dataFile();
      if (!fs.existsSync(file)) return null;
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && parsed.schema && parsed.data && isValidWorkspace(parsed.data)) {
        return normalizeWorkspace(parsed.data);
      }
      if (isValidWorkspace(parsed)) return normalizeWorkspace(parsed); // tolerate raw workspace JSON
      return null;
    } catch (err) {
      console.error('loadData failed:', err.message);
      return null;
    }
  }

  function saveData(data) {
    if (!isValidWorkspace(data)) throw new Error('Invalid workspace data');
    const payload = { schema: SCHEMA, savedAt: new Date().toISOString(), data: normalizeWorkspace(data) };
    // Two attempts: first in the preferred dir; if that fails (e.g. EPERM in
    // Program Files), reset and retry in the fallback dir.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const dir = resolveDir();
        const tmp = path.join(dir, 'maaz-dawakhana.json.tmp');
        fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
        fs.renameSync(tmp, path.join(dir, 'maaz-dawakhana.json')); // atomic-ish replace
        return path.join(dir, 'maaz-dawakhana.json');
      } catch (err) {
        if (attempt === 0 && !usingFallback && fallbackDir) {
          activeDir = null;
          usingFallback = false;
          continue;
        }
        throw err;
      }
    }
    throw new Error('save failed');
  }

  // Make sure a data file exists (creates an empty workspace on first launch).
  function ensureInitialized() {
    if (!fs.existsSync(dataFile())) {
      saveData({ products: [], production: [], sales: [], inventory: [], groups: [] });
    }
    return loadData();
  }

  // Roll a dated copy of the current data file into data/backups (kept on every launch).
  function autoBackup() {
    if (!fs.existsSync(dataFile())) return null;
    try {
      const dir = resolveDir();
      const target = path.join(dir, 'backups', `auto-${stamp()}.json`);
      fs.copyFileSync(dataFile(), target);
      // Prune old auto backups.
      const files = fs.readdirSync(path.join(dir, 'backups'))
        .filter((f) => f.startsWith('auto-') && f.endsWith('.json'))
        .sort();
      while (files.length > MAX_AUTO_BACKUPS) {
        fs.unlinkSync(path.join(dir, 'backups', files.shift()));
      }
      return target;
    } catch (err) {
      console.error('autoBackup failed:', err.message);
      return null;
    }
  }

  // Shared backup format (identical to the website's export).
  function makeBackupPayload(data) {
    if (!isValidWorkspace(data)) throw new Error('Invalid workspace data');
    const normalized = normalizeWorkspace(data);
    return {
      format: BACKUP_FORMAT,
      schemaVersion: BACKUP_SCHEMA_VERSION,
      app: 'Maaz Dawakhana',
      generatedBy: 'windows',
      exportedAt: new Date().toISOString(),
      counts: BACKUP_SECTIONS.reduce((counts, key) => ({ ...counts, [key]: normalized[key].length }), {}),
      data: normalized
    };
  }

  // Lenient parser: accepts our payload, a bare workspace object, a
  // { data: {...} } wrapper, PascalCase keys, and foreign date formats.
  // Returns normalized { groups, products, production, sales, inventory }.
  function parseBackupFile(filePath) {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      throw new Error('This file is not valid JSON.');
    }
    if (Array.isArray(raw)) throw new Error('This JSON file does not contain a workspace backup.');
    const wrapped = pick(raw, 'data', 'workspace', 'payload');
    const container = (wrapped && typeof wrapped === 'object' && !Array.isArray(wrapped)) ? wrapped : raw;
    const section = (key, ...aliases) => {
      const value = pick(container, key, ...aliases);
      return Array.isArray(value) ? value : [];
    };
    const data = {
      groups: section('groups', 'group', 'productGroups', 'categories'),
      products: section('products', 'product', 'bom'),
      production: section('production', 'productions', 'productionLog'),
      sales: section('sales', 'sale', 'salesRecords'),
      inventory: section('inventory', 'inventoryMovements', 'stock')
    };
    if (['products', 'production', 'sales', 'inventory'].every((key) => !data[key].length)) {
      throw new Error('No products, production, sales, or inventory records were found in this file.');
    }
    const normalized = {
      groups: data.groups.map(normalizeGroupRecord).filter(Boolean),
      products: data.products.map(normalizeProductRecord).filter(Boolean),
      production: data.production.map(normalizeProductionRecord).filter(Boolean),
      sales: data.sales.map(normalizeSaleRecord).filter(Boolean),
      inventory: migrateInventory(data.inventory.map(normalizeInventoryRecord).filter(Boolean))
    };
    resolveImportedGroups(normalized);
    if (!isValidWorkspace(normalized)) {
      throw new Error('Not a valid Maaz Dawakhana workspace');
    }
    return normalized;
  }

  function paths() {
    const dir = resolveDir();
    let count = 0;
    try {
      count = fs.readdirSync(path.join(dir, 'backups')).filter((f) => f.startsWith('auto-')).length;
    } catch { /* ignore */ }
    return {
      dataDir: dir,
      dataFile: path.join(dir, 'maaz-dawakhana.json'),
      backupsDir: path.join(dir, 'backups'),
      autoBackupCount: count,
      location: usingFallback ? 'appdata' : 'app'
    };
  }

  return { loadData, saveData, ensureInitialized, autoBackup, makeBackupPayload, parseBackupFile, paths, isValidWorkspace, normalizeWorkspace };
}

module.exports = { createStorage, isValidWorkspace: (d) => d && Array.isArray(d.products) && Array.isArray(d.production) && Array.isArray(d.sales) && Array.isArray(d.inventory) };
