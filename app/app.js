const initialState = { products: [], production: [], sales: [], inventory: [], groups: [] };
let state = JSON.parse(JSON.stringify(initialState));
let currentView = 'dashboard';
// Dashboard date-range filter (UI-only, not persisted to Firestore)
let dashboardFilter = { preset: 'all', start: null, end: null };
let productionFilter = { preset: 'all', start: null, end: null };
let salesFilter = { preset: 'all', start: null, end: null };
let inventoryFilter = { preset: 'all', start: null, end: null };
let bomSearch = '';
let bomGroupSearch = {};      // per-group search text, keyed by group id ('' = ungrouped)
let collapsedBomGroups = {};  // per-group collapsed flag

const $ = (selector) => document.querySelector(selector);
const appView = $('#appView');
const today = new Date();
$('#todayLabel').textContent = today.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

// ---- Local storage (desktop app) ----
// Maaz Dawakhana for Windows saves everything in a local JSON file next to the
// installed app (or the user profile folder when the install folder is
// protected). No account, no internet, no cloud. Backup & restore are built in.
const Desktop = window.desktopAPI || {
  // Browser fallback (preview only): keep data in localStorage.
  loadData: async () => { try { return JSON.parse(localStorage.getItem('maaz-local-data') || 'null'); } catch { return null; } },
  saveData: async (data) => { try { localStorage.setItem('maaz-local-data', JSON.stringify(data)); } catch { } },
  backup: async () => ({ cancelled: true, error: 'Desktop app only' }),
  restore: async () => ({ cancelled: true, error: 'Desktop app only' }),
  paths: async () => ({ dataDir: 'browser preview', dataFile: '' }),
  onMenu: () => {}
};
let saveTimer = null;

function migrateInventory(records) {
  return records.flatMap((item) => {
    if (item.quantity !== undefined) return [item];
    const name = item.productName || 'Inventory item';
    return [['bottles', item.bottles], ['boxes', item.boxes], ['cartons', item.cartons]]
      .filter(([, qty]) => Number(qty) > 0)
      .map(([unit, qty]) => ({ id: `${item.id}-${unit}`, date: item.date, itemName: name, movement: 'received', quantity: Number(qty), unit, notes: item.notes || 'Imported opening stock' }));
  });
}
function inventoryBalances(records = state.inventory) {
  const balances = {};
  records.forEach((item) => {
    const name = String(item.itemName || '').trim(); const unit = String(item.unit || '').trim();
    if (!name || !unit) return;
    const key = `${name.toLowerCase()}|||${unit.toLowerCase()}`;
    if (!balances[key]) balances[key] = { itemName: name, unit, received: 0, used: 0, balance: 0 };
    const qty = Number(item.quantity || 0);
    if (item.movement === 'used') balances[key].used += qty; else balances[key].received += qty;
    balances[key].balance = balances[key].received - balances[key].used;
  });
  return Object.values(balances).sort((a,b) => a.itemName.localeCompare(b.itemName) || a.unit.localeCompare(b.unit));
}

async function loadState() {
  const saved = await Desktop.loadData();
  if (saved && Array.isArray(saved.products) && Array.isArray(saved.production) && Array.isArray(saved.sales)) {
    return { products: saved.products || [], production: saved.production || [], sales: saved.sales || [], inventory: migrateInventory(saved.inventory || []), groups: saved.groups || [] };
  }
  return JSON.parse(JSON.stringify(initialState));
}

function saveState() {
  // Debounced so rapid edits don't spam disk writes.
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const result = await Desktop.saveData(state);
      if (result && result.ok === false) notify('Save failed: ' + (result.error || 'Unknown error'));
    } catch (err) { notify('Save failed: ' + err.message); }
  }, 250);
}

async function bootApp() {
  state = await loadState();
  render();
}

function updateAccountUI(info) {
  const el = $('#sidebarAccountEmail');
  if (el) el.textContent = (info && info.dataFile) ? info.dataFile : 'Saved on this PC';
  const status = document.querySelector('#localStatus');
  if (status && info && info.dataDir) status.title = 'Data folder: ' + info.dataDir;
}

function closeAccountMenu() {
  $('#accountMenu')?.classList.remove('open');
  $('#accountToggle')?.setAttribute('aria-expanded', 'false');
  $('#accountDropdown')?.setAttribute('aria-hidden', 'true');
}







function formatNumber(value) { return new Intl.NumberFormat().format(value || 0); }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }
function capitalizeFirst(value) { const text = String(value ?? ''); return text ? text.charAt(0).toUpperCase() + text.slice(1) : text; }
// Splits text into lines so each fits within maxWidth (in points), breaking on spaces.
function wrapTextToFit(text, font, size, maxWidth) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? line + ' ' + word : word;
    if (!line || font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}
function dateLabel(value) { return value ? new Date(`${value}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '-'; }
function saleItems(sale) { return Array.isArray(sale.items) ? sale.items : [{ productId: sale.productId, dozen: Number(sale.dozen || 0) }]; }
function itemProductName(item) { return item.customName || productName(item.productId); }
function saleProductLabel(sale) { return saleItems(sale).map(itemProductName).join(', '); }
function saleVolume(sale) { return saleItems(sale).reduce((sum, item) => sum + Number(item.dozen || 0), 0); }
function productStock(productId) { const produced = state.production.filter((item) => item.productId === productId).reduce((sum, item) => sum + Number(item.bottles || 0), 0); const sold = state.sales.reduce((sum, sale) => sum + saleItems(sale).filter((item) => item.productId === productId).reduce((itemSum, item) => itemSum + Number(item.dozen || 0) * 12, 0), 0); return { produced, sold, current: produced - sold }; }
function productStockFrom(productId, productionRecords, salesRecords) { const produced = productionRecords.filter((item) => item.productId === productId).reduce((sum, item) => sum + Number(item.bottles || 0), 0); const sold = salesRecords.reduce((sum, sale) => sum + saleItems(sale).filter((item) => item.productId === productId).reduce((itemSum, item) => itemSum + Number(item.dozen || 0) * 12, 0), 0); return { produced, sold, current: produced - sold }; }
function totalProduced() { return state.production.reduce((sum, item) => sum + Number(item.bottles || 0), 0); }
function totalSold() { return state.sales.reduce((sum, sale) => sum + saleItems(sale).reduce((itemSum, item) => itemSum + Number(item.dozen || 0) * 12, 0), 0); }
function receiptValue(value) { const normalized = String(value || '').replace(/[$€£,\s]/g, ''); const number = Number(normalized); return Number.isFinite(number) ? number : 0; }
function totalReceipts() { return state.sales.reduce((sum, item) => sum + receiptValue(item.receipt), 0); }
function formatReceipt(value) { return value ? (Number.isFinite(Number(value)) ? Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : escapeHtml(value)) : '-'; }
function productSalesRanking() { const totals = state.sales.reduce((ranking, sale) => { saleItems(sale).forEach((item) => { const product = itemProductName(item); ranking[product] = (ranking[product] || 0) + Number(item.dozen || 0); }); return ranking; }, {}); return Object.entries(totals).sort((a, b) => b[1] - a[1]); }

// ---- Complete Excel workbook export ----
const EXCEL_THEME = {
  ink: 'FF202522', paper: 'FFFBFAF7', canvas: 'FFF2F1EB', line: 'FFDEDFD7',
  sage: 'FFA8C4A2', sageDeep: 'FF52715A', yellow: 'FFF0CE66', coral: 'FFE6816E',
  white: 'FFFFFFFF', muted: 'FF737A73', red: 'FFB76050', softRed: 'FFF6E5E1'
};

function excelDate(value) {
  if (!value) return null;
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function excelColumnLetter(index) {
  let value = index, label = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    value = Math.floor((value - 1) / 26);
  }
  return label;
}

function styleExcelCell(cell, options = {}) {
  if (options.fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: options.fill } };
  if (options.font) cell.font = options.font;
  if (options.alignment) cell.alignment = options.alignment;
  if (options.border) cell.border = options.border;
}

function addExcelReportHeader(sheet, title, subtitle, columnCount, metrics = []) {
  sheet.mergeCells(1, 1, 1, columnCount);
  const titleCell = sheet.getCell(1, 1);
  titleCell.value = title;
  styleExcelCell(titleCell, {
    fill: EXCEL_THEME.ink,
    font: { name: 'Aptos Display', size: 22, bold: true, color: { argb: EXCEL_THEME.white } },
    alignment: { vertical: 'middle', horizontal: 'left' }
  });
  sheet.getRow(1).height = 38;

  sheet.mergeCells(2, 1, 2, columnCount);
  const subtitleCell = sheet.getCell(2, 1);
  subtitleCell.value = subtitle;
  styleExcelCell(subtitleCell, {
    fill: EXCEL_THEME.ink,
    font: { name: 'Aptos', size: 10, color: { argb: 'FFD7DDD7' } },
    alignment: { vertical: 'middle', horizontal: 'left' }
  });
  sheet.getRow(2).height = 22;
  sheet.getRow(3).height = 9;

  metrics.slice(0, Math.floor(columnCount / 2)).forEach(([label, value], index) => {
    const labelCell = sheet.getCell(4, index * 2 + 1);
    const valueCell = sheet.getCell(4, index * 2 + 2);
    labelCell.value = label;
    valueCell.value = value;
    styleExcelCell(labelCell, {
      fill: EXCEL_THEME.sage,
      font: { name: 'Aptos', size: 10, bold: true, color: { argb: EXCEL_THEME.ink } },
      alignment: { vertical: 'middle', horizontal: 'left' }
    });
    styleExcelCell(valueCell, {
      fill: EXCEL_THEME.paper,
      font: { name: 'Aptos Display', size: 13, bold: true, color: { argb: EXCEL_THEME.ink } },
      alignment: { vertical: 'middle', horizontal: 'right' },
      border: { bottom: { style: 'thin', color: { argb: EXCEL_THEME.sage } } }
    });
  });
  sheet.getRow(4).height = 27;
  sheet.getRow(5).height = 8;
}

function createExcelDataSheet(workbook, config) {
  const sheet = workbook.addWorksheet(config.name, {
    views: [{ state: 'frozen', ySplit: 7, showGridLines: false }],
    properties: { defaultRowHeight: 19 },
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: .25, right: .25, top: .5, bottom: .5, header: .2, footer: .2 } }
  });
  const count = config.columns.length;
  config.columns.forEach((column, index) => {
    sheet.getColumn(index + 1).width = column.width || 16;
  });
  const exportStamp = new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const account = 'Local workspace';
  addExcelReportHeader(sheet, config.title, `Maaz Dawakhana  •  ${config.scopeLabel || 'All time'}  •  Exported ${exportStamp}  •  ${account}`, count, config.metrics || []);

  const headerRowNumber = 7;
  const headerRow = sheet.getRow(headerRowNumber);
  config.columns.forEach((column, index) => { headerRow.getCell(index + 1).value = column.header; });
  headerRow.height = 29;
  headerRow.eachCell((cell) => {
    styleExcelCell(cell, {
      fill: EXCEL_THEME.ink,
      font: { name: 'Aptos', size: 10, bold: true, color: { argb: EXCEL_THEME.white } },
      alignment: { vertical: 'middle', horizontal: 'left', wrapText: true },
      border: { bottom: { style: 'medium', color: { argb: EXCEL_THEME.yellow } } }
    });
  });
  sheet.autoFilter = { from: { row: headerRowNumber, column: 1 }, to: { row: headerRowNumber, column: count } };

  const startRow = headerRowNumber + 1;
  if (config.rows.length) {
    config.rows.forEach((values, rowIndex) => {
      const row = sheet.getRow(startRow + rowIndex);
      values.forEach((value, columnIndex) => { row.getCell(columnIndex + 1).value = value; });
      row.height = 22;
      row.eachCell({ includeEmpty: true }, (cell, columnIndex) => {
        styleExcelCell(cell, {
          fill: rowIndex % 2 ? EXCEL_THEME.canvas : EXCEL_THEME.paper,
          font: { name: 'Aptos', size: 10, color: { argb: EXCEL_THEME.ink } },
          alignment: { vertical: 'middle', horizontal: 'left', wrapText: columnIndex === 4 },
          border: { bottom: { style: 'hair', color: { argb: EXCEL_THEME.line } } }
        });
        const column = config.columns[columnIndex - 1];
        if (column?.numFmt) cell.numFmt = column.numFmt;
      });
      if (config.decorateRow) config.decorateRow(row, values, rowIndex);
    });
  } else {
    sheet.mergeCells(startRow, 1, startRow + 1, count);
    const emptyCell = sheet.getCell(startRow, 1);
    emptyCell.value = 'No records were available when this workbook was exported.';
    styleExcelCell(emptyCell, {
      fill: EXCEL_THEME.canvas,
      font: { name: 'Aptos', size: 11, italic: true, color: { argb: EXCEL_THEME.muted } },
      alignment: { vertical: 'middle', horizontal: 'center' }
    });
    sheet.getRow(startRow).height = 24;
  }

  sheet.headerFooter.oddFooter = '&LMaaz Dawakhana&CConfidential workspace export&RPage &P of &N';
  return { sheet, headerRow: headerRowNumber, startRow, endRow: config.rows.length ? startRow + config.rows.length - 1 : startRow };
}

function createExcelBomSheet(workbook, products) {
  const sheet = workbook.addWorksheet('BOM', {
    views: [{ state: 'frozen', ySplit: 5, showGridLines: false }],
    properties: { defaultRowHeight: 19 },
    pageSetup: { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: .3, right: .3, top: .5, bottom: .5, header: .2, footer: .2 } }
  });
  [22, 22, 22, 19, 14, 38].forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
  const materialCount = products.reduce((sum, product) => sum + (product.materials || []).length, 0);
  const exportStamp = new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const account = 'Local workspace';
  addExcelReportHeader(
    sheet,
    'Bill of materials — product directory',
    `Each product has its own separate BOM section  •  Current configuration  •  Exported ${exportStamp}  •  ${account}`,
    6,
    [['Products', products.length], ['Raw material lines', materialCount], ['Configured output', products.reduce((sum, product) => sum + Number(product.batchOutput || 0), 0)]]
  );

  let rowNumber = 7;
  const sortedProducts = products.slice().sort((a, b) => a.name.localeCompare(b.name));
  if (!sortedProducts.length) {
    sheet.mergeCells(rowNumber, 1, rowNumber + 2, 6);
    const emptyCell = sheet.getCell(rowNumber, 1);
    emptyCell.value = 'No BOM products have been configured yet.';
    styleExcelCell(emptyCell, {
      fill: EXCEL_THEME.canvas,
      font: { name: 'Aptos', size: 11, italic: true, color: { argb: EXCEL_THEME.muted } },
      alignment: { vertical: 'middle', horizontal: 'center' }
    });
  }

  sortedProducts.forEach((product, productIndex) => {
    const materials = product.materials || [];
    sheet.mergeCells(rowNumber, 1, rowNumber, 6);
    const productCell = sheet.getCell(rowNumber, 1);
    productCell.value = `${String(productIndex + 1).padStart(2, '0')}  /  ${product.name}`;
    styleExcelCell(productCell, {
      fill: EXCEL_THEME.ink,
      font: { name: 'Aptos Display', size: 15, bold: true, color: { argb: EXCEL_THEME.white } },
      alignment: { vertical: 'middle', horizontal: 'left' },
      border: { bottom: { style: 'medium', color: { argb: [EXCEL_THEME.yellow, EXCEL_THEME.sage, EXCEL_THEME.coral][productIndex % 3] } } }
    });
    sheet.getRow(rowNumber).height = 30;
    rowNumber += 1;

    const summaryRow = sheet.getRow(rowNumber);
    const summaryValues = [
      'Output / batch', Number(product.batchOutput || 0),
      'Equivalent dozen', Number(product.batchOutput || 0) / 12,
      'Raw materials', materials.length
    ];
    summaryValues.forEach((value, index) => { summaryRow.getCell(index + 1).value = value; });
    summaryRow.eachCell({ includeEmpty: true }, (cell, columnIndex) => {
      const isLabel = columnIndex % 2 === 1;
      styleExcelCell(cell, {
        fill: isLabel ? EXCEL_THEME.sage : EXCEL_THEME.paper,
        font: { name: 'Aptos', size: 10, bold: true, color: { argb: EXCEL_THEME.ink } },
        alignment: { vertical: 'middle', horizontal: isLabel ? 'left' : 'right' },
        border: { bottom: { style: 'thin', color: { argb: EXCEL_THEME.line } } }
      });
    });
    summaryRow.getCell(2).numFmt = '#,##0';
    summaryRow.getCell(4).numFmt = '#,##0.00';
    summaryRow.getCell(6).numFmt = '0';
    summaryRow.height = 25;
    rowNumber += 2;

    sheet.mergeCells(rowNumber, 1, rowNumber, 3);
    sheet.getCell(rowNumber, 1).value = 'RAW MATERIAL';
    sheet.getCell(rowNumber, 4).value = 'QTY / BATCH';
    sheet.getCell(rowNumber, 5).value = 'UNIT';
    sheet.getCell(rowNumber, 6).value = 'PRODUCT ID';
    sheet.getRow(rowNumber).height = 24;
    sheet.getRow(rowNumber).eachCell({ includeEmpty: true }, (cell) => {
      styleExcelCell(cell, {
        fill: EXCEL_THEME.sageDeep,
        font: { name: 'Aptos', size: 9, bold: true, color: { argb: EXCEL_THEME.white } },
        alignment: { vertical: 'middle', horizontal: 'left' }
      });
    });
    rowNumber += 1;

    if (!materials.length) {
      sheet.mergeCells(rowNumber, 1, rowNumber + 1, 6);
      const noMaterialCell = sheet.getCell(rowNumber, 1);
      noMaterialCell.value = 'No raw materials have been added for this product.';
      styleExcelCell(noMaterialCell, {
        fill: EXCEL_THEME.canvas,
        font: { name: 'Aptos', size: 10, italic: true, color: { argb: EXCEL_THEME.muted } },
        alignment: { vertical: 'middle', horizontal: 'center' }
      });
      sheet.getRow(rowNumber).height = 22;
      rowNumber += 2;
    } else {
      materials.forEach((material, materialIndex) => {
        sheet.mergeCells(rowNumber, 1, rowNumber, 3);
        const values = [material.name || '', Number(material.qty || 0), material.unit || '', product.id];
        sheet.getCell(rowNumber, 1).value = values[0];
        sheet.getCell(rowNumber, 4).value = values[1];
        sheet.getCell(rowNumber, 5).value = values[2];
        sheet.getCell(rowNumber, 6).value = values[3];
        sheet.getRow(rowNumber).height = 22;
        sheet.getRow(rowNumber).eachCell({ includeEmpty: true }, (cell) => {
          styleExcelCell(cell, {
            fill: materialIndex % 2 ? EXCEL_THEME.canvas : EXCEL_THEME.paper,
            font: { name: 'Aptos', size: 10, color: { argb: EXCEL_THEME.ink } },
            alignment: { vertical: 'middle', horizontal: 'left' },
            border: { bottom: { style: 'hair', color: { argb: EXCEL_THEME.line } } }
          });
        });
        sheet.getCell(rowNumber, 4).numFmt = '#,##0.00000';
        rowNumber += 1;
      });
    }
    sheet.getRow(rowNumber).height = 10;
    rowNumber += 1;
  });

  sheet.headerFooter.oddFooter = '&LMaaz Dawakhana&CSeparate BOM product sections&RPage &P of &N';
  return sheet;
}

function addExcelTotalsRow(report, label, formulaColumns) {
  if (report.endRow < report.startRow || report.sheet.getCell(report.startRow, 1).value === 'No records were available when this workbook was exported.') return;
  const rowNumber = report.endRow + 2;
  const row = report.sheet.getRow(rowNumber);
  row.getCell(1).value = label;
  row.getCell(1).font = { name: 'Aptos', size: 10, bold: true, color: { argb: EXCEL_THEME.white } };
  row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: EXCEL_THEME.sageDeep } };
  formulaColumns.forEach((column) => {
    const letter = excelColumnLetter(column);
    const cell = row.getCell(column);
    cell.value = { formula: `SUM(${letter}${report.startRow}:${letter}${report.endRow})` };
    cell.numFmt = column === 3 ? '0.00000' : '#,##0.00';
    styleExcelCell(cell, {
      fill: EXCEL_THEME.sageDeep,
      font: { name: 'Aptos', size: 10, bold: true, color: { argb: EXCEL_THEME.white } },
      alignment: { horizontal: 'right' }
    });
  });
  row.height = 24;
}

function chartRoundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function excelBarChartImage(title, subtitle, items, color = '#52715a', suffix = '') {
  const canvas = document.createElement('canvas');
  canvas.width = 1100; canvas.height = 500;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f2f1eb'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  chartRoundedRect(ctx, 10, 10, 1080, 480, 20); ctx.fillStyle = '#fbfaf7'; ctx.fill();
  ctx.fillStyle = '#202522'; ctx.font = '700 28px Arial'; ctx.fillText(title, 42, 58);
  ctx.fillStyle = '#737a73'; ctx.font = '16px Arial'; ctx.fillText(subtitle, 42, 86);
  const rows = items.slice(0, 8);
  if (!rows.length || rows.every((item) => Number(item.value) === 0)) {
    ctx.fillStyle = '#737a73'; ctx.font = '18px Arial'; ctx.fillText('No data available yet.', 42, 155);
    return canvas.toDataURL('image/png');
  }
  const max = Math.max(...rows.map((item) => Number(item.value) || 0), 1);
  const labelX = 42, barX = 300, barMax = 690, top = 120, step = 43;
  rows.forEach((item, index) => {
    const y = top + index * step;
    const rawLabel = String(item.label || '');
    const label = rawLabel.length > 28 ? `${rawLabel.slice(0, 27)}…` : rawLabel;
    ctx.fillStyle = '#202522'; ctx.font = '600 16px Arial'; ctx.fillText(label, labelX, y + 16);
    ctx.fillStyle = '#e7eadf'; chartRoundedRect(ctx, barX, y, barMax, 20, 6); ctx.fill();
    const width = Math.max(5, (Number(item.value) || 0) / max * barMax);
    ctx.fillStyle = color; chartRoundedRect(ctx, barX, y, width, 20, 6); ctx.fill();
    ctx.fillStyle = '#202522'; ctx.font = '700 14px Arial'; ctx.textAlign = 'right';
    ctx.fillText(`${new Intl.NumberFormat().format(Number(item.value) || 0)}${suffix}`, 1055, y + 16);
    ctx.textAlign = 'left';
  });
  return canvas.toDataURL('image/png');
}

function excelLineChartImage(title, subtitle, points, color = '#e6816e') {
  const canvas = document.createElement('canvas');
  canvas.width = 1100; canvas.height = 500;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f2f1eb'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  chartRoundedRect(ctx, 10, 10, 1080, 480, 20); ctx.fillStyle = '#fbfaf7'; ctx.fill();
  ctx.fillStyle = '#202522'; ctx.font = '700 28px Arial'; ctx.fillText(title, 42, 58);
  ctx.fillStyle = '#737a73'; ctx.font = '16px Arial'; ctx.fillText(subtitle, 42, 86);
  if (!points.length || points.every((point) => Number(point.value) === 0)) {
    ctx.fillStyle = '#737a73'; ctx.font = '18px Arial'; ctx.fillText('No sales timeline available yet.', 42, 155);
    return canvas.toDataURL('image/png');
  }
  const x0 = 74, y0 = 420, width = 970, height = 285;
  const max = Math.max(...points.map((point) => Number(point.value) || 0), 1) * 1.08;
  ctx.strokeStyle = '#dedfd7'; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = y0 - i * height / 4;
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + width, y); ctx.stroke();
    ctx.fillStyle = '#737a73'; ctx.font = '13px Arial'; ctx.textAlign = 'right';
    ctx.fillText(new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(max * i / 4), x0 - 9, y + 4);
  }
  const x = (index) => points.length === 1 ? x0 + width / 2 : x0 + index / (points.length - 1) * width;
  const y = (value) => y0 - (Number(value) || 0) / max * height;
  ctx.beginPath();
  points.forEach((point, index) => index ? ctx.lineTo(x(index), y(point.value)) : ctx.moveTo(x(index), y(point.value)));
  ctx.strokeStyle = color; ctx.lineWidth = 5; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke();
  const labelEvery = Math.max(1, Math.ceil(points.length / 7));
  points.forEach((point, index) => {
    if (Number(point.value)) { ctx.beginPath(); ctx.arc(x(index), y(point.value), 6, 0, Math.PI * 2); ctx.fillStyle = '#fbfaf7'; ctx.fill(); ctx.strokeStyle = '#202522'; ctx.lineWidth = 2; ctx.stroke(); }
    if (index % labelEvery === 0 || index === points.length - 1) {
      ctx.fillStyle = '#737a73'; ctx.font = '13px Arial'; ctx.textAlign = 'center'; ctx.fillText(point.label, x(index), 452);
    }
  });
  ctx.textAlign = 'left';
  return canvas.toDataURL('image/png');
}

function exportSalesTimeline(salesRecords = state.sales) {
  const grouped = {};
  salesRecords.filter((sale) => sale.date).forEach((sale) => {
    const key = sale.date.slice(0, 7);
    grouped[key] = (grouped[key] || 0) + receiptValue(sale.receipt);
  });
  return Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => ({
    label: new Date(`${key}-15T12:00:00`).toLocaleDateString(undefined, { month: 'short', year: '2-digit' }), value
  }));
}

function addExcelDashboard(workbook, exportData, scopeLabel) {
  const sheet = workbook.addWorksheet('Dashboard', {
    views: [{ showGridLines: false }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 2 }
  });
  for (let i = 1; i <= 14; i++) sheet.getColumn(i).width = 13;
  for (let i = 1; i <= 58; i++) sheet.getRow(i).height = 19;
  const account = 'Local workspace';
  addExcelReportHeader(sheet, 'Executive dashboard', `${scopeLabel}  •  ${new Date().toLocaleString()}  •  ${account}`, 14, []);

  const producedTotal = totalProducedFrom(exportData.production);
  const soldTotal = totalSoldFrom(exportData.sales);
  const revenueTotal = totalReceiptsFrom(exportData.sales);
  const cards = [
    { range: 'A4:C7', label: 'ACTIVE PRODUCTS', value: state.products.length, color: EXCEL_THEME.yellow },
    { range: 'D4:F7', label: 'PRODUCED', value: `${formatNumber(producedTotal)} bottles`, color: EXCEL_THEME.sage },
    { range: 'G4:I7', label: 'SOLD', value: `${formatNumber(soldTotal)} bottles`, color: EXCEL_THEME.coral },
    { range: 'J4:L7', label: 'REVENUE', value: formatReceipt(revenueTotal), color: EXCEL_THEME.ink },
    { range: 'M4:N7', label: 'INVENTORY ITEMS', value: inventoryBalances(exportData.inventory).length, color: EXCEL_THEME.sageDeep }
  ];
  cards.forEach((card) => {
    sheet.mergeCells(card.range);
    const cell = sheet.getCell(card.range.split(':')[0]);
    cell.value = `${card.label}\n${card.value}`;
    styleExcelCell(cell, {
      fill: card.color,
      font: { name: 'Aptos Display', size: 15, bold: true, color: { argb: card.color === EXCEL_THEME.yellow || card.color === EXCEL_THEME.sage || card.color === EXCEL_THEME.coral ? EXCEL_THEME.ink : EXCEL_THEME.white } },
      alignment: { vertical: 'middle', horizontal: 'center', wrapText: true },
      border: { left: { style: 'thin', color: { argb: EXCEL_THEME.white } }, right: { style: 'thin', color: { argb: EXCEL_THEME.white } } }
    });
  });
  sheet.mergeCells('A8:N8');
  sheet.getCell('A8').value = `Charts are generated only from records in: ${scopeLabel}. BOM remains the current product configuration.`;
  sheet.getCell('A8').font = { name: 'Aptos', size: 9, italic: true, color: { argb: EXCEL_THEME.muted } };

  const producedMap = exportData.production.reduce((totals, item) => {
    const name = productName(item.productId);
    totals[name] = (totals[name] || 0) + Number(item.bottles || 0);
    return totals;
  }, {});
  const producedByProduct = Object.entries(producedMap).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
  const salesByProduct = productSalesRankingFrom(exportData.sales).map(([label, value]) => ({ label, value }));
  const stockByProduct = state.products.map((product) => ({ label: product.name, value: productStockFrom(product.id, exportData.production, exportData.sales).current })).sort((a, b) => b.value - a.value);
  const chartImages = [
    { data: excelBarChartImage('Production by product', `${scopeLabel} · bottles manufactured`, producedByProduct, '#f0ce66', ' btl'), col: 0, row: 9 },
    { data: excelBarChartImage('Sales by product', `${scopeLabel} · dozen volume`, salesByProduct, '#e6816e', ' doz'), col: 7, row: 9 },
    { data: excelLineChartImage('Revenue over time', `${scopeLabel} · monthly receipt totals`, exportSalesTimeline(exportData.sales), '#e6816e'), col: 0, row: 28 },
    { data: excelBarChartImage('Net product movement', `${scopeLabel} · produced minus sold`, stockByProduct, '#52715a', ' btl'), col: 7, row: 28 }
  ];
  chartImages.forEach((chart) => {
    const imageId = workbook.addImage({ base64: chart.data, extension: 'png' });
    sheet.addImage(imageId, { tl: { col: chart.col, row: chart.row }, ext: { width: 650, height: 295 } });
  });
  sheet.headerFooter.oddFooter = '&LMaaz Dawakhana&CExecutive dashboard&RPage &P of &N';
  return sheet;
}

let lastExportFilter = { preset: 'all', start: null, end: null };

function exportPresetRange(preset) {
  const end = toISODate(today);
  if (preset === 'all') return { preset, start: null, end: null };
  if (preset === 'today') return { preset, start: end, end };
  const days = preset === 'month2' ? 60 : 30;
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - (days - 1));
  return { preset, start: toISODate(startDate), end };
}

function exportFilterLabel(filter) {
  if (!filter || filter.preset === 'all') return 'All-time data';
  if (filter.preset === 'today') return `Today · ${dateLabel(filter.start)}`;
  if (filter.preset === 'month1') return `Last 1 month · ${dateLabel(filter.start)} – ${dateLabel(filter.end)}`;
  if (filter.preset === 'month2') return `Last 2 months · ${dateLabel(filter.start)} – ${dateLabel(filter.end)}`;
  if (filter.start === filter.end) return `Selected date · ${dateLabel(filter.start)}`;
  return `Custom dates · ${dateLabel(filter.start)} – ${dateLabel(filter.end)}`;
}

function exportRecordMatches(dateStr, filter) {
  if (!filter || filter.preset === 'all') return true;
  if (!dateStr) return false;
  if (filter.start && dateStr < filter.start) return false;
  if (filter.end && dateStr > filter.end) return false;
  return true;
}

function exportDataForRange(filter) {
  return {
    products: state.products.slice(),
    production: state.production.filter((item) => exportRecordMatches(item.date, filter)),
    sales: state.sales.filter((item) => exportRecordMatches(item.date, filter)),
    inventory: state.inventory.filter((item) => exportRecordMatches(item.date, filter))
  };
}

function readExportFilterForm(form) {
  const preset = form.querySelector('input[name="exportPreset"]:checked')?.value || 'all';
  if (preset !== 'custom') return exportPresetRange(preset);
  return {
    preset: 'custom',
    start: form.querySelector('#exportStart')?.value || null,
    end: form.querySelector('#exportEnd')?.value || null
  };
}

function updateExportDialog() {
  const form = $('#exportRangeForm');
  if (!form) return;
  const filter = readExportFilterForm(form);
  const custom = filter.preset === 'custom';
  $('#exportCustomDates')?.classList.toggle('hidden', !custom);
  form.querySelectorAll('.export-range-card').forEach((card) => card.classList.toggle('selected', Boolean(card.querySelector('input:checked'))));
  const startInput = form.querySelector('#exportStart');
  const endInput = form.querySelector('#exportEnd');
  if (startInput) startInput.required = custom;
  if (endInput) endInput.required = custom;
  const data = exportDataForRange(filter);
  const rangeText = custom && (!filter.start || !filter.end) ? 'Choose both dates to preview the export.' : exportFilterLabel(filter);
  $('#exportRangeTitle').textContent = rangeText;
  $('#exportProductionCount').textContent = data.production.length;
  $('#exportSalesCount').textContent = data.sales.length;
  $('#exportInventoryCount').textContent = data.inventory.length;
}

function openExportModal() {
  closeAccountMenu();
  const customFallback = exportPresetRange('month1');
  const selected = lastExportFilter.preset || 'all';
  const customStart = lastExportFilter.start || customFallback.start;
  const customEnd = lastExportFilter.end || customFallback.end;
  const choices = [
    ['all', 'All data', 'Complete history'],
    ['today', 'Today', dateLabel(toISODate(today))],
    ['month1', 'Last 1 month', 'Most recent 30 days'],
    ['month2', 'Last 2 months', 'Most recent 60 days'],
    ['custom', 'Custom dates', 'Choose start and end']
  ];
  $('#modalEyebrow').textContent = 'EXCEL EXPORT';
  $('#modalTitle').textContent = 'Choose data period';
  $('#modalBody').innerHTML = `<form id="exportRangeForm" class="export-range-form">
    <div class="export-intro"><span class="export-intro-icon">⇩</span><span><strong>Clean, date-filtered workbook</strong><small>BOM is always complete. Production, sales, inventory, dashboard, and raw usage follow your selected dates.</small></span></div>
    <div class="export-range-options">${choices.map(([value, label, help]) => `<label class="export-range-card ${selected === value ? 'selected' : ''}"><input type="radio" name="exportPreset" value="${value}" ${selected === value ? 'checked' : ''}><span class="export-range-dot"></span><span><strong>${label}</strong><small>${help}</small></span></label>`).join('')}</div>
    <div class="export-custom-dates ${selected === 'custom' ? '' : 'hidden'}" id="exportCustomDates">
      <div class="field"><label for="exportStart">Start date</label><input id="exportStart" type="date" value="${customStart}"></div>
      <span class="export-date-arrow">→</span>
      <div class="field"><label for="exportEnd">End date</label><input id="exportEnd" type="date" value="${customEnd}"></div>
      <small>For one exact date, select the same date in both fields.</small>
    </div>
    <div class="export-preview">
      <div><span>Selected period</span><strong id="exportRangeTitle">All-time data</strong></div>
      <div class="export-preview-counts"><span><b id="exportProductionCount">0</b> production</span><span><b id="exportSalesCount">0</b> sales</span><span><b id="exportInventoryCount">0</b> inventory</span></div>
    </div>
    <div class="form-actions"><button type="button" class="outline-button" id="cancelModal">Cancel</button><button class="primary-button export-submit" type="submit"><span>⇩</span> Export Excel</button></div>
  </form>`;
  $('#modalBackdrop').classList.remove('hidden');
  const form = $('#exportRangeForm');
  form.addEventListener('change', updateExportDialog);
  form.addEventListener('input', updateExportDialog);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const filter = readExportFilterForm(form);
    if (filter.preset === 'custom' && (!filter.start || !filter.end)) {
      notify('Choose both a start and end date');
      return;
    }
    if (filter.start && filter.end && filter.start > filter.end) {
      notify('Start date must be before the end date');
      return;
    }
    lastExportFilter = { ...filter };
    closeModal();
    exportAllDataToExcel(filter);
  });
  updateExportDialog();
}

function exportFileRangeSlug(filter) {
  if (!filter || filter.preset === 'all') return `All_Data_${toISODate(new Date())}`;
  if (filter.start === filter.end) return filter.start;
  return `${filter.start || 'Start'}_to_${filter.end || 'End'}`;
}

async function exportAllDataToExcel(filter = { preset: 'all', start: null, end: null }) {
  if (!window.ExcelJS) {
    notify('Excel export library did not load. Refresh and try again.');
    return;
  }
  const buttons = [$('#exportExcel'), $('#accountExport')].filter(Boolean);
  buttons.forEach((button) => { button.classList.add('is-loading'); button.disabled = true; });
  closeAccountMenu();
  const exportData = exportDataForRange(filter);
  const scopeLabel = exportFilterLabel(filter);
  notify(`Building workbook · ${scopeLabel}`);
  try {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Maaz Dawakhana Production Control';
    workbook.lastModifiedBy = 'Maaz Dawakhana (local edition)';
    workbook.created = new Date();
    workbook.modified = new Date();
    workbook.title = 'BOM, Production, Sales and Inventory Export';
    workbook.subject = `${scopeLabel} cloud workspace export`;
    workbook.company = 'Maaz Dawakhana';
    workbook.calcProperties.fullCalcOnLoad = true;

    createExcelBomSheet(workbook, exportData.products);

    const productionRows = exportData.production.slice().sort((a, b) => String(a.date).localeCompare(String(b.date))).map((item) => {
      const product = getProductById(item.productId);
      return [excelDate(item.date), productName(item.productId), Number(item.batches || 0), Number(item.bottles || 0), Number(item.bottles || 0) / 12, Number(product?.batchOutput || 0), item.id];
    });
    const productionReport = createExcelDataSheet(workbook, {
      name: 'Production', title: 'Production log', scopeLabel,
      metrics: [['Entries', exportData.production.length], ['Batches', exportData.production.reduce((sum, item) => sum + Number(item.batches || 0), 0)], ['Bottles', totalProducedFrom(exportData.production)]],
      columns: [
        { header: 'Date', width: 15, numFmt: 'dd-mmm-yyyy' }, { header: 'Product Manufactured', width: 28 },
        { header: 'Batches', width: 15, numFmt: '0.00000' }, { header: 'Bottles Produced', width: 18, numFmt: '#,##0' },
        { header: 'Equivalent Dozen', width: 19, numFmt: '#,##0.00' }, { header: 'Configured Output / Batch', width: 24, numFmt: '#,##0' },
        { header: 'Record ID', width: 38 }
      ], rows: productionRows
    });
    addExcelTotalsRow(productionReport, 'PRODUCTION TOTAL', [3, 4, 5]);

    const salesRows = [];
    exportData.sales.slice().sort((a, b) => String(a.date).localeCompare(String(b.date))).forEach((sale) => {
      saleItems(sale).forEach((item, index) => salesRows.push([
        excelDate(sale.date), sale.customer || '', sale.phone || '', sale.address || '', sale.proforma || '', index + 1,
        itemProductName(item), Number(item.dozen || 0), Number(item.dozen || 0) * 12, index === 0 ? receiptValue(sale.receipt) : '', sale.id
      ]));
    });
    const salesReport = createExcelDataSheet(workbook, {
      name: 'Sales', title: 'Sales and fulfilment', scopeLabel,
      metrics: [['Shipments', exportData.sales.length], ['Dozen sold', totalSoldFrom(exportData.sales) / 12], ['Total receipts', totalReceiptsFrom(exportData.sales)], ['Customers', new Set(exportData.sales.map((sale) => String(sale.customer || '').trim().toLowerCase()).filter(Boolean)).size]],
      columns: [
        { header: 'Date Shipped', width: 15, numFmt: 'dd-mmm-yyyy' }, { header: 'Customer', width: 24 }, { header: 'Phone', width: 19 },
        { header: 'Address', width: 36 }, { header: 'Proforma', width: 17 }, { header: 'Line #', width: 10, numFmt: '0' },
        { header: 'Product Sold', width: 28 }, { header: 'Quantity (Dozen)', width: 18, numFmt: '#,##0.00' },
        { header: 'Quantity (Bottles)', width: 19, numFmt: '#,##0' }, { header: 'Sale Receipt Total', width: 20, numFmt: '#,##0.00' },
        { header: 'Sale ID', width: 38 }
      ], rows: salesRows
    });
    addExcelTotalsRow(salesReport, 'SALES TOTAL', [8, 9, 10]);

    const inventoryRows = exportData.inventory.slice().sort((a, b) => String(a.date).localeCompare(String(b.date))).map((item) => [
      excelDate(item.date), item.itemName || '', item.movement === 'used' ? 'Used' : 'Received', Number(item.quantity || 0), item.unit || '',
      item.movement === 'used' ? -Number(item.quantity || 0) : Number(item.quantity || 0), item.notes || '', item.id
    ]);
    const inventoryReport = createExcelDataSheet(workbook, {
      name: 'Inventory', title: 'Factory inventory movements', scopeLabel,
      metrics: [['Movements', exportData.inventory.length], ['Items tracked', inventoryBalances(exportData.inventory).length], ['Received entries', exportData.inventory.filter((item) => item.movement !== 'used').length], ['Used entries', exportData.inventory.filter((item) => item.movement === 'used').length]],
      columns: [
        { header: 'Date', width: 15, numFmt: 'dd-mmm-yyyy' }, { header: 'Material / Item', width: 30 }, { header: 'Movement', width: 14 },
        { header: 'Quantity', width: 16, numFmt: '#,##0.00000' }, { header: 'Unit', width: 13 }, { header: 'Signed Quantity', width: 18, numFmt: '#,##0.00000;[Red]-#,##0.00000' },
        { header: 'Notes', width: 38 }, { header: 'Record ID', width: 38 }
      ], rows: inventoryRows,
      decorateRow: (row, values) => {
        const movementCell = row.getCell(3);
        const used = values[2] === 'Used';
        movementCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: used ? EXCEL_THEME.softRed : 'FFE4EEE2' } };
        movementCell.font = { name: 'Aptos', size: 10, bold: true, color: { argb: used ? EXCEL_THEME.red : EXCEL_THEME.sageDeep } };
      }
    });
    addExcelTotalsRow(inventoryReport, 'NET MOVEMENT', [6]);

    addExcelDashboard(workbook, exportData, scopeLabel);

    const { totals: rawTotals } = rawMaterialUsage(exportData.production);
    createExcelDataSheet(workbook, {
      name: 'Raw Usage', title: 'Calculated raw material usage', scopeLabel,
      metrics: [['Materials', rawTotals.length], ['Products with BOM use', new Set(rawTotals.flatMap((item) => item.productList)).size], ['Production entries', exportData.production.length]],
      columns: [
        { header: 'Raw Material', width: 30 }, { header: 'Calculated Qty Used', width: 22, numFmt: '#,##0.00000' }, { header: 'Unit', width: 13 },
        { header: 'Used in # Products', width: 20, numFmt: '0' }, { header: 'Products', width: 55 }, { header: 'Calculation Note', width: 42 }
      ],
      rows: rawTotals.map((item) => [item.name, Number(item.qty || 0), item.unit || '', item.productCount, item.productList.join(', '), 'BOM quantity per batch × production batches in selected dates'])
    });

    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `Maaz_Dawakhana_${exportFileRangeSlug(filter)}.xlsx`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    notify(`Excel downloaded · ${scopeLabel}`);
  } catch (err) {
    console.error(err);
    notify('Excel export failed: ' + err.message);
  } finally {
    buttons.forEach((button) => { button.classList.remove('is-loading'); button.disabled = false; });
  }
}

$('#exportExcel')?.addEventListener('click', openExportModal);
$('#accountExport')?.addEventListener('click', openExportModal);

// ---- Dashboard date-range filtering ----
function toISODate(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function computePresetRange(preset) {
  const end = toISODate(today);
  if (preset === 'all') return { start: null, end: null };
  if (preset === 'today') return { start: end, end };
  const days = preset === '7' ? 7 : 30;
  const start = new Date(today);
  start.setDate(start.getDate() - (days - 1));
  return { start: toISODate(start), end };
}
function inDateRange(dateStr) {
  if (dashboardFilter.preset === 'all') return true;
  if (!dateStr) return false;
  if (dashboardFilter.start && dateStr < dashboardFilter.start) return false;
  if (dashboardFilter.end && dateStr > dashboardFilter.end) return false;
  return true;
}
function filteredSales() { return state.sales.filter((sale) => inDateRange(sale.date)); }
function filteredProduction() { return state.production.filter((item) => inDateRange(item.date)); }
function productSalesRankingFrom(sales) { const totals = sales.reduce((ranking, sale) => { saleItems(sale).forEach((item) => { const product = itemProductName(item); ranking[product] = (ranking[product] || 0) + Number(item.dozen || 0); }); return ranking; }, {}); return Object.entries(totals).sort((a, b) => b[1] - a[1]); }
function productSalesRankingIdsFrom(sales) { const totals = sales.reduce((ranking, sale) => { saleItems(sale).forEach((item) => { ranking[item.productId] = (ranking[item.productId] || 0) + Number(item.dozen || 0); }); return ranking; }, {}); return Object.entries(totals).sort((a, b) => b[1] - a[1]); }
function totalProducedFrom(production) { return production.reduce((sum, item) => sum + Number(item.bottles || 0), 0); }
function totalSoldFrom(sales) { return sales.reduce((sum, sale) => sum + saleItems(sale).reduce((itemSum, item) => itemSum + Number(item.dozen || 0) * 12, 0), 0); }
function totalReceiptsFrom(sales) { return sales.reduce((sum, item) => sum + receiptValue(item.receipt), 0); }
function filterRangeLabel() { if (dashboardFilter.preset === 'all') return 'All time'; if (dashboardFilter.preset === 'today') return `Today · ${dateLabel(dashboardFilter.start)}`; if (dashboardFilter.preset === '7') return `Last 7 days · ${dateLabel(dashboardFilter.start)} – ${dateLabel(dashboardFilter.end)}`; if (dashboardFilter.preset === '30') return `Last 30 days · ${dateLabel(dashboardFilter.start)} – ${dateLabel(dashboardFilter.end)}`; if (dashboardFilter.start && dashboardFilter.end) return `${dateLabel(dashboardFilter.start)} – ${dateLabel(dashboardFilter.end)}`; if (dashboardFilter.start) return `From ${dateLabel(dashboardFilter.start)}`; if (dashboardFilter.end) return `Up to ${dateLabel(dashboardFilter.end)}`; return 'Pick a date range'; }
// ---- Sales over time chart ----
let salesChartMetric = 'revenue'; // 'revenue' | 'volume'
function addDays(dateStr, n) { const d = new Date(`${dateStr}T12:00:00`); d.setDate(d.getDate() + n); return toISODate(d); }
function monthKey(dateStr) { return dateStr.slice(0, 7); }
function monthLabel(key) { return new Date(`${key}-15T12:00:00`).toLocaleDateString(undefined, { month: 'short', year: '2-digit' }); }
function shortDayLabel(dateStr) { return new Date(`${dateStr}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
function nextMonthKey(key) { const [y, m] = key.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; }
function salesTimeSeries(sales) {
  const dated = sales.filter((sale) => sale.date);
  if (!dated.length) return { points: [], mode: 'day' };
  const dates = dated.map((sale) => sale.date).sort();
  const minDate = dashboardFilter.preset !== 'all' && dashboardFilter.start ? dashboardFilter.start : dates[0];
  const maxDate = dashboardFilter.preset !== 'all' && dashboardFilter.end ? dashboardFilter.end : dates[dates.length - 1];
  const spanDays = Math.round((new Date(`${maxDate}T12:00:00`) - new Date(`${minDate}T12:00:00`)) / 86400000) + 1;
  const mode = spanDays > 62 ? 'month' : 'day';
  const totals = {};
  dated.forEach((sale) => {
    const key = mode === 'month' ? monthKey(sale.date) : sale.date;
    if (!totals[key]) totals[key] = { revenue: 0, volume: 0 };
    totals[key].revenue += receiptValue(sale.receipt);
    totals[key].volume += saleVolume(sale);
  });
  const points = [];
  if (mode === 'day') {
    for (let d = minDate; d <= maxDate && points.length < 400; d = addDays(d, 1)) points.push({ key: d, label: shortDayLabel(d), ...(totals[d] || { revenue: 0, volume: 0 }) });
  } else {
    for (let k = monthKey(minDate); k <= monthKey(maxDate) && points.length < 400; k = nextMonthKey(k)) points.push({ key: k, label: monthLabel(k), ...(totals[k] || { revenue: 0, volume: 0 }) });
  }
  return { points, mode };
}
function compactNumber(value) { return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value); }
function salesOverTimePanel(sales) {
  const { points, mode } = salesTimeSeries(sales);
  const metric = salesChartMetric;
  const unit = metric === 'revenue' ? '' : ' doz';
  const toggle = `<div class="chart-toggle"><button type="button" class="filter-chip ${metric === 'revenue' ? 'active' : ''}" data-sales-metric="revenue">Revenue</button><button type="button" class="filter-chip ${metric === 'volume' ? 'active' : ''}" data-sales-metric="volume">Volume (doz)</button></div>`;
  let body;
  if (!points.length || points.every((p) => !p[metric])) {
    body = '<div class="empty-state">No sales in the selected range to chart yet.</div>';
  } else {
    const W = 860, H = 250, padL = 52, padR = 16, padT = 14, padB = 34;
    const innerW = W - padL - padR, innerH = H - padT - padB;
    const maxVal = Math.max(...points.map((p) => p[metric]), 1);
    const niceMax = maxVal * 1.1;
    const x = (i) => points.length === 1 ? padL + innerW / 2 : padL + (i / (points.length - 1)) * innerW;
    const y = (v) => padT + innerH - (v / niceMax) * innerH;
    const coords = points.map((p, i) => [x(i), y(p[metric])]);
    const linePath = coords.map(([cx, cy], i) => `${i === 0 ? 'M' : 'L'}${cx.toFixed(1)},${cy.toFixed(1)}`).join(' ');
    const areaPath = `${linePath} L${coords[coords.length - 1][0].toFixed(1)},${(padT + innerH).toFixed(1)} L${coords[0][0].toFixed(1)},${(padT + innerH).toFixed(1)} Z`;
    const gridLines = [0.25, 0.5, 0.75, 1].map((f) => { const gy = y(niceMax * f); return `<line x1="${padL}" y1="${gy.toFixed(1)}" x2="${W - padR}" y2="${gy.toFixed(1)}" class="chart-grid"/><text x="${padL - 8}" y="${(gy + 4).toFixed(1)}" class="chart-axis-label" text-anchor="end">${compactNumber(niceMax * f)}</text>`; }).join('');
    const labelEvery = Math.max(1, Math.ceil(points.length / 8));
    const xLabels = points.map((p, i) => (i % labelEvery === 0 || i === points.length - 1) ? `<text x="${x(i).toFixed(1)}" y="${H - 10}" class="chart-axis-label" text-anchor="middle">${escapeHtml(p.label)}</text>` : '').join('');
    const dots = coords.map(([cx, cy], i) => points[i][metric] > 0 ? `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="4" class="chart-dot"><title>${escapeHtml(points[i].label)}: ${metric === 'revenue' ? formatReceipt(points[i][metric]) : formatNumber(points[i][metric]) + ' doz'}</title></circle>` : '').join('');
    const total = points.reduce((sum, p) => sum + p[metric], 0);
    body = `<div class="chart-summary"><strong>${metric === 'revenue' ? formatReceipt(total) : formatNumber(total) + unit}</strong><span>total ${metric === 'revenue' ? 'revenue' : 'volume'} · ${mode === 'month' ? 'monthly' : 'daily'} buckets</span></div><svg class="sales-chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Sales over time chart"><defs><linearGradient id="salesFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${metric === 'revenue' ? '#e6816e' : '#52715a'}" stop-opacity="0.28"/><stop offset="100%" stop-color="${metric === 'revenue' ? '#e6816e' : '#52715a'}" stop-opacity="0.02"/></linearGradient></defs>${gridLines}<path d="${areaPath}" fill="url(#salesFill)"/><path d="${linePath}" class="chart-line ${metric === 'revenue' ? 'revenue-line' : 'volume-line'}"/>${dots}${xLabels}</svg>`;
  }
  return `<section class="panel sales-time-panel"><div class="panel-heading"><div><h2>Sales over time</h2><small>${salesChartMetric === 'revenue' ? 'Receipt totals' : 'Dozen volume'} per ${dashboardFilter.preset === 'all' ? 'period' : 'day'} in the selected range</small></div>${toggle}</div>${body}</section>`;
}

function dashFilterBar() { const presets = [['today', 'Today'], ['7', '7 days'], ['30', '30 days'], ['all', 'All time'], ['custom', 'Custom']]; return `<div class="dash-filter-bar"><div class="filter-presets">${presets.map(([key, label]) => `<button type="button" class="filter-chip ${dashboardFilter.preset === key ? 'active' : ''}" data-filter-preset="${key}">${label}</button>`).join('')}</div>${dashboardFilter.preset === 'custom' ? `<div class="filter-custom"><input type="date" id="filterStart" value="${dashboardFilter.start || ''}"><span>to</span><input type="date" id="filterEnd" value="${dashboardFilter.end || ''}"></div>` : `<div class="filter-range-label">${escapeHtml(filterRangeLabel())}</div>`}</div>`; }
let salesDetailProductId = null;
function showProductSalesDetail(productId) { salesDetailProductId = productId; const sales = filteredSales().filter((sale) => saleItems(sale).some((item) => item.productId === productId)).slice().reverse(); const rows = sales.map((sale) => { const item = saleItems(sale).find((i) => i.productId === productId); return `<tr><td>${dateLabel(sale.date)}</td><td>${escapeHtml(sale.customer)}</td><td>${escapeHtml(sale.proforma || '-')}</td><td>${formatNumber(item.dozen)} doz <small>(${formatNumber(item.dozen * 12)} bottles)</small></td><td>${formatReceipt(sale.receipt)}</td><td class="row-actions"><button class="small-button" data-edit-sale="${sale.id}" title="Edit this sale">Edit</button><button class="small-button" data-print-sale="${sale.id}" title="Print invoice PDF">Print</button><button class="small-button danger-action" data-delete-sale="${sale.id}" title="Remove this sale">Remove</button></td></tr>`; }).join(''); const totalDozen = sales.reduce((sum, sale) => sum + Number(saleItems(sale).find((i) => i.productId === productId)?.dozen || 0), 0); $('#modalEyebrow').textContent = 'SALES DETAIL'; $('#modalTitle').textContent = `${productName(productId)} — sold to`; $('#modalBody').innerHTML = `<div class="table-wrap"><table class="data-table"><thead><tr><th>Date</th><th>Customer</th><th>Proforma</th><th>Volume</th><th>Receipt</th><th>Actions</th></tr></thead><tbody>${rows || '<tr><td colspan="6"><div class="empty-state">No sales for this product in the selected range.</div></td></tr>'}</tbody>${sales.length ? `<tfoot><tr><th colspan="3">Total</th><th>${formatNumber(totalDozen)} doz</th><th></th><th></th></tr></tfoot>` : ''}</table></div>`; $('#modalBackdrop').classList.remove('hidden'); }
function setView(view) { currentView = view; document.querySelectorAll('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.view === view)); const titles = { dashboard: ['OVERVIEW', 'Good morning, operator.'], bom: ['PRODUCT LIBRARY', 'Bill of materials'], production: ['SHOP FLOOR', 'Production log'], sales: ['FULFILLMENT', 'Sales & inventory out'], inventory: ['FACTORY STOCK', 'Standalone inventory'], raw: ['MATERIALS', 'Raw material analytics'] }; $('#viewEyebrow').textContent = titles[view][0]; $('#viewTitle').textContent = titles[view][1]; $('#quickAction').textContent = view === 'bom' ? '+ Add product' : view === 'sales' ? '+ Record sale' : view === 'inventory' ? '+ Record movement' : view === 'raw' ? '+ Add product' : '+ Add production'; render(); }
function render() { appView.innerHTML = ({ dashboard: dashboardViewSummary, bom: bomView, production: productionView, sales: salesView, inventory: inventoryView, raw: rawView }[currentView])(); }

// ---- Date filters for production, sales, and inventory records ----
function recordInRange(dateStr, filter) { if (filter.preset === 'all') return true; if (!dateStr) return false; if (filter.start && dateStr < filter.start) return false; if (filter.end && dateStr > filter.end) return false; return true; }
function recordFilterLabel(filter) { if (filter.preset === 'all') return 'All time'; if (filter.preset === 'today') return `Today · ${dateLabel(filter.start)}`; if (filter.preset === '7') return `Last 7 days · ${dateLabel(filter.start)} – ${dateLabel(filter.end)}`; if (filter.preset === '30') return `Last 30 days · ${dateLabel(filter.start)} – ${dateLabel(filter.end)}`; if (filter.start && filter.end) return `${dateLabel(filter.start)} – ${dateLabel(filter.end)}`; if (filter.start) return `From ${dateLabel(filter.start)}`; if (filter.end) return `Up to ${dateLabel(filter.end)}`; return 'Pick a date range'; }
function recordFilterBar(scope, filter) { const presets = [['today','Today'],['7','7 days'],['30','30 days'],['all','All time'],['custom','Custom']]; return `<div class="dash-filter-bar record-filter-bar"><div class="filter-presets">${presets.map(([key,label]) => `<button type="button" class="filter-chip ${filter.preset === key ? 'active' : ''}" data-record-filter-scope="${scope}" data-record-filter-preset="${key}">${label}</button>`).join('')}</div>${filter.preset === 'custom' ? `<div class="filter-custom"><input type="date" data-record-filter-date="start" data-record-filter-scope="${scope}" value="${filter.start || ''}"><span>to</span><input type="date" data-record-filter-date="end" data-record-filter-scope="${scope}" value="${filter.end || ''}"></div>` : `<div class="filter-range-label">${escapeHtml(recordFilterLabel(filter))}</div>`}</div>`; }
function filterForScope(scope) { return scope === 'production' ? productionFilter : scope === 'sales' ? salesFilter : inventoryFilter; }

// ---- Raw material analytics ----
function rawMaterialUsage(productionRecords = state.production) {
  const totals = {}; // key -> {name, qty, unit, products:Set}
  const byProduct = {}; // productId -> {product, materials:{key->{name,qty,unit}}, totalBatches}
  productionRecords.forEach(entry => {
    const product = state.products.find(p => p.id === entry.productId);
    if (!product) return;
    const batches = Number(entry.batches || 0);
    if (!batches) return;
    if (!byProduct[product.id]) byProduct[product.id] = { product, materials: {}, totalBatches: 0 };
    byProduct[product.id].totalBatches += batches;
    (product.materials || []).forEach(mat => {
      const rawName = String(mat.name || '').trim();
      if (!rawName) return;
      const key = rawName.toLowerCase();
      const qty = Number(mat.qty || 0) * batches;
      if (!totals[key]) totals[key] = { name: rawName, qty: 0, unit: mat.unit || '', products: new Set() };
      totals[key].qty += qty;
      totals[key].unit = mat.unit || totals[key].unit;
      totals[key].products.add(product.name);
      if (!byProduct[product.id].materials[key]) byProduct[product.id].materials[key] = { name: rawName, qty: 0, unit: mat.unit || '' };
      byProduct[product.id].materials[key].qty += qty;
      byProduct[product.id].materials[key].unit = mat.unit || byProduct[product.id].materials[key].unit;
    });
  });
  const sortedTotals = Object.values(totals).map(t => ({ ...t, productCount: t.products.size, productList: Array.from(t.products) })).sort((a,b) => b.qty - a.qty);
  const byProductArr = Object.values(byProduct).map(bp => ({
    product: bp.product,
    totalBatches: bp.totalBatches,
    materials: Object.values(bp.materials).sort((a,b)=>b.qty-a.qty)
  })).sort((a,b)=>b.totalBatches-a.totalBatches);
  return { totals: sortedTotals, byProduct: byProductArr };
}

function rawView() {
  const { totals, byProduct } = rawMaterialUsage();
  const totalDistinct = totals.length;
  const totalQty = totals.reduce((s,t)=>s+Number(t.qty||0),0);
  const top = totals[0];
  const maxQty = Math.max(...totals.map(t=>t.qty),1);
  const maxBatch = Math.max(...totals.map(t=>t.qty),1);
  const maxRawByProd = Math.max(...byProduct.map(bp=>Object.values(bp.materials).reduce((s,m)=>s+m.qty,0)),1);
  const maxBatchesProd = Math.max(...byProduct.map(bp=>bp.totalBatches),1);

  return `<div class="view-grid">
    <div class="metrics">
      <div class="metric metric-accent"><div class="metric-label">Distinct raw materials</div><div class="metric-value">${formatNumber(totalDistinct)}</div></div>
      <div class="metric metric-accent coral"><div class="metric-label">Total material consumed</div><div class="metric-value">${formatNumber(totalQty)}<span class="metric-unit">units</span></div></div>
      <div class="metric metric-accent sage has-popover" tabindex="0"><div class="metric-label">Highest used material <span class="hint-icon">i</span></div><div class="metric-value" style="font-size:22px">${escapeHtml(top?.name || '-')}</div><div class="metric-popover"><div class="popover-head"><strong>Top material</strong><small>${top ? formatNumber(top.qty)+' '+escapeHtml(top.unit) : 'none'}</small></div><div class="popover-list"><div class="popover-row"><span>${escapeHtml(top?.name || 'No data')}</span><strong>${top ? formatNumber(top.qty)+' '+escapeHtml(top.unit) : '-'}</strong></div><div class="popover-row"><span>Used in products</span><strong>${top ? top.productCount : 0}</strong></div>${top ? `<div class="popover-row"><span>Products</span><span style="text-align:right">${escapeHtml(top.productList.join(', '))}</span></div>` : ''}</div></div></div>
      <div class="metric metric-accent dark"><div class="metric-label">Products using materials</div><div class="metric-value">${byProduct.length}</div></div>
    </div>

    <div class="two-column">
      <section class="panel"><div class="panel-heading"><div><h2>Raw material consumption</h2><small>Total qty used across all production (5-decimal batch precision)</small></div></div>
        <div class="dashboard-bars">${totals.map(t => `<div class="dashboard-bar-row"><div class="dashboard-bar-meta"><strong>${escapeHtml(t.name)} <small>${escapeHtml(t.unit)} · in ${t.productCount} product${t.productCount===1?'':'s'}</small></strong><span>${formatNumber(t.qty)} ${escapeHtml(t.unit)}</span></div><div class="dashboard-bar-track"><div class="dashboard-bar production-bar" style="width:${Math.max(4, t.qty/maxQty*100)}%; background:var(--sage-deep)"></div></div></div>`).join('') || '<div class="empty-state">No production yet – log batches (e.g. 3.69444 for 266 doz / 72 doz) to see material use.</div>'}</div>
      </section>

      <section class="panel"><div class="panel-heading"><div><h2>Products – raw material chart</h2><small>Only product names – click for breakdown</small></div></div>
        <div class="dashboard-bars">${byProduct.map(bp => {
          const totalRaw = Object.values(bp.materials).reduce((s,m)=>s+m.qty,0);
          return `<div class="dashboard-bar-row clickable-row" data-raw-product="${bp.product.id}" role="button" tabindex="0"><div class="dashboard-bar-meta"><strong>${escapeHtml(bp.product.name)}</strong><span>${Number(bp.totalBatches).toFixed(5)} batches ›</span></div><div class="dashboard-bar-track"><div class="dashboard-bar sales-bar" style="width:${Math.max(4, totalRaw/maxRawByProd*100)}%"></div></div></div>`;
        }).join('') || '<div class="empty-state">Add production to see chart.</div>'}</div>
      </section>
    </div>

    <section class="panel"><div class="panel-heading"><div><h2>Detailed raw material table</h2><small>Total consumption + product usage</small></div></div>
      <div class="table-wrap"><table class="data-table"><thead><tr><th>Raw material</th><th>Total used</th><th>Unit</th><th>Used in #products</th><th>Products</th><th>Progress</th></tr></thead><tbody>
        ${totals.map(t => `<tr><td><strong>${escapeHtml(t.name)}</strong></td><td>${formatNumber(t.qty)}</td><td>${escapeHtml(t.unit)}</td><td>${t.productCount}</td><td>${escapeHtml(t.productList.join(', '))}</td><td style="width:30%"><div class="dashboard-bar-track" style="height:8px"><div class="dashboard-bar" style="width:${Math.max(3,t.qty/maxQty*100)}%;background:var(--coral)"></div></div></td></tr>`).join('') || '<tr><td colspan="6"><div class="empty-state">No material usage recorded yet.</div></td></tr>'}
      </tbody></table></div>
    </section>

    <section class="panel"><div class="panel-heading"><div><h2>Top material by product batches</h2><small>Which product consumes most batches (5-decimal)</small></div></div>
      <div class="dashboard-bars">${byProduct.map(bp => `<div class="dashboard-bar-row clickable-row" data-raw-product="${bp.product.id}" role="button" tabindex="0"><div class="dashboard-bar-meta"><strong>${escapeHtml(bp.product.name)}</strong><span>${Number(bp.totalBatches).toFixed(5)} batches · ${formatNumber(Object.values(bp.materials).reduce((s,m)=>s+m.qty,0))} total raw</span></div><div class="dashboard-bar-track"><div class="dashboard-bar production-bar" style="width:${Math.max(4,bp.totalBatches/maxBatchesProd*100)}%; background:var(--yellow)"></div></div></div>`).join('') || '<div class="empty-state">No data</div>'}</div>
    </section>
  </div>`;
}

function showRawMaterialDetail(productId){
  const { byProduct } = rawMaterialUsage();
  const entry = byProduct.find(bp=>bp.product.id===productId);
  if(!entry) { notify('No data for product'); return; }
  const totalRaw = entry.materials.reduce((s,m)=>s+m.qty,0);
  const rows = entry.materials.map(m=>`<tr><td><strong>${escapeHtml(m.name)}</strong></td><td>${formatNumber(m.qty)}</td><td>${escapeHtml(m.unit)}</td><td>${totalRaw?((m.qty/totalRaw)*100).toFixed(1):0}%</td></tr>`).join('');
  $('#modalEyebrow').textContent='RAW MATERIAL DETAIL';
  $('#modalTitle').textContent=`${entry.product.name} — raw use`;
  $('#modalBody').innerHTML=`<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px"><span class="pill">${Number(entry.totalBatches).toFixed(5)} batches</span><span class="pill orange">${formatNumber(totalRaw)} total units</span><span class="pill">${entry.materials.length} materials</span></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Raw material</th><th>Qty used (5-dec)</th><th>Unit</th><th>Share</th></tr></thead><tbody>${rows || '<tr><td colspan=4><div class=empty-state>No materials for this product</div></td></tr>'}</tbody></table></div><div class="dashboard-bars" style="margin-top:18px">${entry.materials.map(m=>`<div class="dashboard-bar-row"><div class="dashboard-bar-meta"><strong>${escapeHtml(m.name)}</strong><span>${formatNumber(m.qty)} ${escapeHtml(m.unit)}</span></div><div class="dashboard-bar-track"><div class="dashboard-bar" style="width:${Math.max(4,m.qty/Math.max(...entry.materials.map(x=>x.qty),1)*100)}%;background:var(--sage-deep)"></div></div></div>`).join('')}</div>`;
  $('#modalBackdrop').classList.remove('hidden');
}

function dashboardView() { const ranking = productSalesRanking(); const sales = state.sales.slice().reverse(); const max = Math.max(...state.production.slice(-7).map((x) => Number(x.bottles)), 1); return `<div class="view-grid"><div class="metrics"><div class="metric metric-accent"><div class="metric-label">Total produced</div><div class="metric-value">${formatNumber(totalProduced())}<span class="metric-unit">bottles</span></div></div><div class="metric metric-accent dark"><div class="metric-label">Active products</div><div class="metric-value">${state.products.length}</div></div></div><div class="two-column"><section class="panel"><div class="panel-heading"><div><h2>Production pulse</h2><small>Last 7 entries</small></div><button class="small-button" data-action="production">View log</button></div><div class="chart">${state.production.slice(-7).map((item) => `<div class="bar-wrap"><div class="bar" style="height:${Math.max(4, Number(item.bottles) / max * 145)}px" title="${formatNumber(item.bottles)} bottles"></div><span class="bar-label">${dateLabel(item.date).split(' ')[0]}</span></div>`).join('') || '<div class="empty-state">No production yet.</div>'}</div></section><section class="panel"><div class="panel-heading"><div><h2>Top products sold</h2><small>Ranked by dozen volume</small></div></div><div class="stock-list">${ranking.map(([name, dozen], index) => `<div class="stock-row"><div><div class="stock-name"><span class="rank-number">${index + 1}</span>${escapeHtml(name)}</div><div class="stock-sub">${formatNumber(dozen * 12)} bottles</div></div><div class="stock-count">${formatNumber(dozen)}<small>doz</small></div></div>`).join('') || '<div class="empty-state">No sales recorded yet.</div>'}</div></section></div><section class="panel"><div class="panel-heading"><div><h2>Customer proformas</h2><small>Sales records and volume</small></div></div>${sales.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Date</th><th>Customer</th><th>Proforma</th><th>Product</th><th>Volume</th><th>Total receipt</th></tr></thead><tbody>${sales.map((item) => `<tr><td>${dateLabel(item.date)}</td><td>${escapeHtml(item.customer)}</td><td>${escapeHtml(item.proforma || '-')}</td><td>${escapeHtml(capitalizeFirst(itemProductName(item)))}</td><td>${formatNumber(item.dozen)} doz <small>(${formatNumber(item.dozen * 12)} bottles)</small></td><td>${formatReceipt(item.receipt)}</td></tr>`).join('')}</tbody><tfoot><tr><th colspan="5">Total receipts</th><th>${formatReceipt(totalReceipts())}</th></tr></tfoot></table></div>` : '<div class="empty-state">No sales recorded yet.</div>'}</section></div>`; }

function closeAllPopovers(){ document.querySelectorAll('.has-popover.popover-open').forEach(el=>el.classList.remove('popover-open')); const bd=document.getElementById('popoverBackdrop'); if(bd) bd.classList.remove('show'); }

function dashboardViewSummary() {
  const sales = filteredSales();
  const production = filteredProduction();
  const productionByName = production.reduce((totals, item) => { const name = productName(item.productId); totals[name] = (totals[name] || 0) + Number(item.batches || 0); return totals; }, {});
  const productionByBottles = production.reduce((totals, item) => { const name = productName(item.productId); totals[name] = (totals[name] || 0) + Number(item.bottles || 0); return totals; }, {});
  const productionRows = Object.entries(productionByName).sort((a, b) => b[1] - a[1]);
  const ranking = productSalesRankingIdsFrom(sales);
  const rankingByName = productSalesRankingFrom(sales);
  const invoices = sales.slice().reverse();
  const maxBatches = Math.max(...productionRows.map(([, batches]) => batches), 1);
  const maxVolume = Math.max(...invoices.map((item) => Number(item.dozen || 0)), 1);
  const totalBatches = production.reduce((sum, item) => sum + Number(item.batches || 0), 0);
  const totalBottlesProd = production.reduce((sum, item) => sum + Number(item.bottles || 0), 0);

  // --- Popover contents ---
  const prodPopoverRows = productionRows.map(([name, batches]) => {
    const bottles = productionByBottles[name] || 0;
    return `<div class="popover-row"><span>${escapeHtml(name)}
<i>${formatNumber(bottles)} bottles</i></span><strong>${formatNumber(batches)} batches</strong></div>`;
  }).join('') || `<div class="popover-empty">No production logged in this range.</div>`;

  const revenueLimit = 10;
  const recentInvoices = invoices.slice(0, revenueLimit);
  const revenuePopoverRows = recentInvoices.map(item => {
    const amt = formatReceipt(item.receipt);
    return `<div class="popover-row"><span>${escapeHtml(dateLabel(item.date))}
<i>${escapeHtml(item.customer)}${item.proforma ? ` · ${escapeHtml(item.proforma)}` : ''}</i></span><strong>${amt}</strong></div>`;
  }).join('') || `<div class="popover-empty">No revenue in selected range.</div>`;

  const soldPopoverRows = ranking.map(([productId, dozen]) => {
    const bottles = dozen * 12;
    const name = productName(productId);
    return `<div class="popover-row"><span>${escapeHtml(name)}</span><strong>${formatNumber(dozen)} doz <small style="color:var(--muted);font-weight:400">(${formatNumber(bottles)} btl)</small></strong></div>`;
  }).join('') || `<div class="popover-empty">No products sold in this range.</div>`;

  const activeProductsRows = state.products.map(product => {
    const stock = productStock(product.id);
    return `<div class="popover-row"><span>${escapeHtml(product.name)}
<i>Output ${formatNumber(product.batchOutput)} btl/batch · Stock ${formatNumber(stock.current)} btl</i></span><strong>${stock.current>0? 'In stock' : 'Out'}</strong></div>`;
  }).join('') || `<div class="popover-empty">No active products yet. Add a product to track.</div>`;

  return `<div class="view-grid">${dashFilterBar()}<div class="metrics">
    <div class="metric metric-accent has-popover" data-popover-key="batches" tabindex="0" role="button" aria-label="Production batches breakdown">
      <div class="metric-label">Production batches <span class="hint-icon">i</span></div>
      <div class="metric-value">${formatNumber(totalBatches)}</div>
      <div class="metric-popover">
        <div class="popover-head"><strong>Batch breakdown</strong><small>${formatNumber(totalBatches)} total · ${formatNumber(totalBottlesProd)} bottles</small></div>
        <div class="popover-list">${prodPopoverRows}</div>
        <div class="popover-foot"><span>Total batches</span><span>${formatNumber(totalBatches)}</span></div>
      </div>
    </div>

    <div class="metric metric-accent coral has-popover" data-popover-key="revenue" tabindex="0" role="button" aria-label="Total revenue breakdown">
      <div class="metric-label">Total revenue <span class="hint-icon">i</span></div>
      <div class="metric-value">${formatReceipt(totalReceiptsFrom(sales))}</div>
      <div class="metric-popover">
        <div class="popover-head"><strong>Revenue by customer</strong><small>${filterRangeLabel()}</small></div>
        <div class="popover-list">${revenuePopoverRows}</div>
        ${recentInvoices.length < invoices.length ? `<div class="popover-foot"><span>Showing ${recentInvoices.length} of ${invoices.length}</span><span>${formatReceipt(totalReceiptsFrom(sales))} total</span></div>` : `<div class="popover-foot"><span>Total revenue</span><span>${formatReceipt(totalReceiptsFrom(sales))}</span></div>`}
      </div>
    </div>

    <div class="metric metric-accent sage has-popover" data-popover-key="sold" tabindex="0" role="button" aria-label="Products sold breakdown">
      <div class="metric-label">Product sold <span class="hint-icon">i</span></div>
      <div class="metric-value">${formatNumber(totalSoldFrom(sales) / 12)}<span class="metric-unit">doz</span></div>
      <div class="metric-popover">
        <div class="popover-head"><strong>Products sold</strong><small>${formatNumber(totalSoldFrom(sales)/12)} doz total</small></div>
        <div class="popover-list">${soldPopoverRows}</div>
        <div class="popover-foot"><span>${ranking.length} product${ranking.length===1?'':'s'} sold</span><span>${formatNumber(totalSoldFrom(sales))} bottles</span></div>
      </div>
    </div>

    <div class="metric metric-accent dark has-popover" data-popover-key="active" tabindex="0" role="button" aria-label="Active products list">
      <div class="metric-label">Active products <span class="hint-icon">i</span></div>
      <div class="metric-value">${state.products.length}</div>
      <div class="metric-popover">
        <div class="popover-head"><strong>Active product list</strong><small>${state.products.length} configured</small></div>
        <div class="popover-list">${activeProductsRows}</div>
        <div class="popover-foot"><span>Total products</span><span>${state.products.length}</span></div>
      </div>
    </div>
  </div>${salesOverTimePanel(sales)}<div class="two-column"><section class="panel"><div class="panel-heading"><div><h2>Production by product</h2><small>Completed batches</small></div><button class="small-button" data-action="production">View log</button></div><div class="dashboard-bars">${productionRows.map(([name, batches]) => `<div class="dashboard-bar-row"><div class="dashboard-bar-meta"><strong>${escapeHtml(name)}</strong><span>${Number(batches).toFixed(5)} batches</span></div><div class="dashboard-bar-track"><div class="dashboard-bar production-bar" style="width:${Math.max(3, batches / maxBatches * 100)}%"></div></div></div>`).join('') || '<div class="empty-state">No production logged in this range.</div>'}</div></section><section class="panel"><div class="panel-heading"><div><h2>Products sold</h2><small>Ranked by total dozen volume · click a product to see who bought it</small></div></div><div class="dashboard-bars">${ranking.map(([productId, dozen], index) => `<div class="dashboard-bar-row clickable-row" data-product-filter="${productId}" role="button" tabindex="0"><div class="dashboard-bar-meta"><strong><span class="rank-number">${index + 1}</span>${escapeHtml(productName(productId))}</strong><span>${formatNumber(dozen)} doz ›</span></div><div class="dashboard-bar-track"><div class="dashboard-bar sales-bar" style="width:${Math.max(3, dozen / Math.max(...ranking.map(([, value]) => value), 1) * 100)}%"></div></div></div>`).join('') || '<div class="empty-state">No sales recorded in this range.</div>'}</div></section></div><section class="panel"><div class="panel-heading"><div><h2>Customer proforma volume history</h2><small>Invoice date, proforma, and dozen volume</small></div></div><div class="dashboard-bars invoice-bars">${invoices.map((item) => `<div class="dashboard-bar-row"><div class="dashboard-bar-meta"><strong>${escapeHtml(item.customer)} <small>${escapeHtml(item.proforma || 'No proforma')}</small></strong><span>${dateLabel(item.date)} · ${formatNumber(item.dozen)} doz</span></div><div class="dashboard-bar-track"><div class="dashboard-bar invoice-bar" style="width:${Math.max(3, Number(item.dozen || 0) / maxVolume * 100)}%"></div></div></div>`).join('') || '<div class="empty-state">No customer invoices in this range.</div>'}</div>${invoices.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Date</th><th>Customer</th><th>Proforma</th><th>Product sold</th><th>Volume</th><th>Total receipt</th></tr></thead><tbody>${invoices.map((item) => `<tr><td>${dateLabel(item.date)}</td><td>${escapeHtml(item.customer)}</td><td>${escapeHtml(item.proforma || '-')}</td><td>${escapeHtml(capitalizeFirst(itemProductName(item)))}</td><td>${formatNumber(item.dozen)} doz <small>(${formatNumber(item.dozen * 12)} bottles)</small></td><td>${formatReceipt(item.receipt)}</td></tr>`).join('')}</tbody><tfoot><tr><th colspan="5">Total receipts</th><th>${formatReceipt(totalReceiptsFrom(sales))}</th></tr></tfoot></table></div>` : ''}</section></div>`; }
function productName(id) { const bomName = state.products.find((product) => product.id === id)?.name; if (bomName) return bomName; for (const sale of state.sales) { const match = saleItems(sale).find((item) => item.productId === id && item.customName); if (match) return match.customName; } return id && String(id).startsWith('external:') ? String(id).slice(9) : 'Deleted product'; }
function groupList() { return (state.groups || []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name))); }
function groupById(id) { return (state.groups || []).find((group) => group.id === id); }
function validGroupId(id) { return groupById(id) ? id : ''; }
function groupLabelForProduct(product) { return groupById(product?.groupId)?.name || 'Ungrouped'; }
function productsInGroup(groupId) { return state.products.filter((product) => validGroupId(product.groupId) === (groupId || '')); }
function productMatches(product, query) {
  if (!query) return true;
  return product.name.toLowerCase().includes(query) || groupLabelForProduct(product).toLowerCase().includes(query);
}
function bomCard(product, showGroup = false) {
  return `<button type="button" class="bom-card bom-name-card" data-bom-product="${product.id}"><span class="bom-card-copy"><span>${escapeHtml(product.name)}</span>${showGroup ? `<small>${escapeHtml(groupLabelForProduct(product))}</small>` : ''}</span><span class="bom-chevron" aria-hidden="true">›</span></button>`;
}
function bomGroupSection(group) {
  const key = group ? group.id : '';
  const name = group ? group.name : 'Ungrouped';
  const all = productsInGroup(key);
  const query = String(bomGroupSearch[key] || '').trim().toLowerCase();
  const shown = query ? all.filter((product) => product.name.toLowerCase().includes(query)) : all;
  const collapsed = Boolean(collapsedBomGroups[key]);
  return `<section class="bom-group ${collapsed ? 'collapsed' : ''}">
    <header class="bom-group-head">
      <button type="button" class="bom-group-toggle" data-group-toggle="${key}" aria-expanded="${!collapsed}"><span class="bom-group-caret" aria-hidden="true">${collapsed ? '▸' : '▾'}</span><strong>${escapeHtml(name)}</strong><span class="bom-group-count">${all.length}</span></button>
      <div class="bom-group-tools">
        <div class="bom-search-wrap group-search"><span aria-hidden="true">⌕</span><input type="search" data-group-search="${key}" value="${escapeHtml(bomGroupSearch[key] || '')}" placeholder="Search in ${escapeHtml(name)}…" aria-label="Search products in ${escapeHtml(name)}"></div>
        ${group ? `<button type="button" class="text-chip" data-rename-group="${group.id}" aria-label="Rename ${escapeHtml(name)}">Rename</button><button type="button" class="text-chip danger" data-delete-group="${group.id}" aria-label="Delete ${escapeHtml(name)}">Delete</button>` : ''}
      </div>
    </header>
    ${collapsed ? '' : `<div class="bom-grid compact-bom-grid">${shown.map((product) => bomCard(product)).join('') || `<div class="panel empty-state compact-empty"><strong>${all.length ? 'No product matches this search.' : 'This group is empty.'}</strong>${all.length ? 'Clear the group search to see all ' + all.length + ' products.' : 'Add a product and choose this group, or edit a product to move it here.'}</div>`}</div>`}
  </section>`;
}
function bomView() {
  const query = bomSearch.trim().toLowerCase();
  const groups = groupList();
  const toolbar = `<div class="section-toolbar"><h2>${state.products.length} product${state.products.length === 1 ? '' : 's'} · ${groups.length} group${groups.length === 1 ? '' : 's'}</h2><div class="toolbar-buttons"><button class="outline-button" data-action="add-group">+ New group</button><button class="outline-button" data-action="add-product">+ New product</button></div></div>`;
  const search = `<div class="bom-search-wrap"><span aria-hidden="true">⌕</span><input id="bomSearch" type="search" value="${escapeHtml(bomSearch)}" placeholder="Search every group by product or group name…" aria-label="Search all BOM products"></div>`;
  if (query) {
    const matches = state.products.filter((product) => productMatches(product, query));
    return `${toolbar}${search}<p class="bom-results-note">${matches.length} match${matches.length === 1 ? '' : 'es'} across all groups for “${escapeHtml(bomSearch.trim())}”.</p><div class="bom-grid compact-bom-grid">${matches.map((product) => bomCard(product, true)).join('') || `<div class="panel empty-state"><strong>No matching products.</strong>Try a different name, or search by group name.</div>`}</div>`;
  }
  if (!state.products.length && !groups.length) {
    return `${toolbar}${search}<div class="panel empty-state"><strong>No products yet.</strong>Create a group such as “Syrups”, then add products into it — or add a product straight away and leave it ungrouped.</div>`;
  }
  const ungrouped = productsInGroup('');
  return `${toolbar}${search}<div class="bom-groups">${groups.map((group) => bomGroupSection(group)).join('')}${ungrouped.length ? bomGroupSection(null) : ''}</div>`;
}

function showBomProductDetail(productId) { const product = state.products.find((item) => item.id === productId); if (!product) return; const materials = product.materials || []; $('#modalEyebrow').textContent = 'PRODUCT DETAILS'; $('#modalTitle').textContent = product.name; $('#modalBody').innerHTML = `<div class="bom-detail"><div class="bom-detail-stat"><span>Group</span><strong>${escapeHtml(groupLabelForProduct(product))}</strong></div><div class="bom-detail-stat"><span>Output per batch</span><strong>${product.batchOutput ? formatNumber(product.batchOutput) + ' bottles' : 'Not added'}</strong></div><div class="bom-detail-section"><h3>Raw materials</h3>${materials.length ? materials.map((material) => `<div class="material-line"><span>${escapeHtml(material.name)}</span><strong>${material.qty ? formatNumber(material.qty) : '—'} ${escapeHtml(material.unit || '')}</strong></div>`).join('') : '<div class="empty-state compact-empty">No raw material details added.</div>'}</div><div class="form-actions"><button type="button" class="outline-button danger" data-delete-product="${product.id}">Delete</button><button type="button" class="primary-button" data-edit-product="${product.id}">Edit details</button></div></div>`; $('#modalBackdrop').classList.remove('hidden'); }
function productionView() {
  const records = state.production.filter((item) => recordInRange(item.date, productionFilter));
  const totals = records.reduce((summary, item) => { const product = summary[item.productId] || { batches: 0, bottles: 0 }; product.batches += Number(item.batches || 0); product.bottles += Number(item.bottles || 0); summary[item.productId] = product; return summary; }, {});
  const rows = state.products.map((product) => ({ product, produced: totals[product.id] || { batches: 0, bottles: 0 }, stock: productStock(product.id) }));
  const maxBottles = Math.max(...rows.map(({ produced }) => produced.bottles), 1);
  return `<div class="view-grid">${recordFilterBar('production', productionFilter)}<div class="production-overview"><section class="panel"><div class="panel-heading"><div><h2>Production by product</h2><small>${recordFilterLabel(productionFilter)}</small></div></div><div class="dashboard-bars">${rows.map(({ product, produced }) => `<div class="dashboard-bar-row"><div class="dashboard-bar-meta"><strong>${escapeHtml(product.name)}</strong><span>${Number(produced.batches).toFixed(5)} batches · ${formatNumber(produced.bottles)} bottles</span></div><div class="dashboard-bar-track"><div class="dashboard-bar production-bar" style="width:${Math.max(3, produced.bottles / maxBottles * 100)}%"></div></div></div>`).join('') || '<div class="empty-state">Add a product and log production to see the chart.</div>'}</div></section><section class="panel"><div class="panel-heading"><div><h2>Available stock by product</h2><small>Current all-time stock after sales</small></div></div><div class="production-stock-list">${rows.map(({ product, stock }) => `<div class="production-product-row"><strong>${escapeHtml(product.name)}</strong><span><b>${formatNumber(stock.produced)}</b> produced</span><span><b>${formatNumber(stock.current)} bottles</b> available</span><span><b>${formatNumber(Math.floor(stock.current / 12))} doz</b> full dozen equivalent</span></div>`).join('') || '<div class="empty-state">Add a product to track production stock.</div>'}</div></section></div><div class="section-toolbar"><h2>${records.length} production entr${records.length === 1 ? 'y' : 'ies'} shown</h2><button class="outline-button" data-action="add-production">+ Log production</button></div><section class="panel"><div class="table-wrap"><table class="data-table"><thead><tr><th>Date</th><th>Product manufactured</th><th>Batches</th><th>Bottles</th><th>Equivalent dozen</th><th>Actions</th></tr></thead><tbody>${records.slice().reverse().map((item) => `<tr><td>${dateLabel(item.date)}</td><td><strong>${escapeHtml(productName(item.productId))}</strong></td><td>${Number(item.batches).toFixed(5)}</td><td>${formatNumber(item.bottles)}</td><td>${(Number(item.bottles) / 12).toFixed(1)} doz</td><td><button class="small-button" data-edit-production="${item.id}">Edit</button> <button class="small-button danger-action" data-delete-production="${item.id}">Remove</button></td></tr>`).join('') || '<tr><td colspan="6"><div class="empty-state">No production records in this date range.</div></td></tr>'}</tbody></table></div></section></div>`;
}
function salesView() {
  const records = state.sales.filter((item) => recordInRange(item.date, salesFilter));
  return `<div class="view-grid">${recordFilterBar('sales', salesFilter)}<div class="summary-strip product-stock-summary">${state.products.map((product) => { const stock = productStock(product.id); return `<div class="product-stock-row"><strong>${escapeHtml(product.name)}</strong><span><b>${formatNumber(stock.current)} bottles</b> currently available</span><span><b>${formatNumber(Math.floor(stock.current / 12))} doz</b> full dozen equivalent</span></div>`; }).join('') || '<div class="empty-state">Add a product to track stock.</div>'}</div><div class="section-toolbar"><h2>${records.length} shipment${records.length === 1 ? '' : 's'} shown</h2><button class="outline-button" data-action="add-sale">+ Record sale</button></div><section class="panel"><div class="table-wrap"><table class="data-table"><thead><tr><th>Date shipped</th><th>Customer / contact</th><th>Product sold</th><th>Quantity</th><th>Total receipt</th><th>Actions</th></tr></thead><tbody>${records.slice().reverse().map((item) => `<tr><td>${dateLabel(item.date)}</td><td><strong>${escapeHtml(item.customer)}</strong><small class="customer-contact">${escapeHtml(item.phone || '')}${item.phone && item.address ? ' · ' : ''}${escapeHtml(item.address || '')}</small></td><td>${escapeHtml(saleProductLabel(item))}</td><td>${formatNumber(saleVolume(item))} doz <small>(${formatNumber(saleVolume(item) * 12)} bottles)</small></td><td>${escapeHtml(item.receipt || '-')}</td><td><button class="small-button" data-edit-sale="${item.id}">Edit</button> <button class="small-button" data-print-sale="${item.id}">Print</button> <button class="small-button danger-action" data-delete-sale="${item.id}">Remove</button></td></tr>`).join('') || '<tr><td colspan="6"><div class="empty-state">No sales records in this date range.</div></td></tr>'}</tbody></table></div></section></div>`;
}
function inventoryView() {
  const records = state.inventory.filter((item) => recordInRange(item.date, inventoryFilter));
  const balances = inventoryBalances();
  const receivedCount = records.filter((item) => item.movement !== 'used').length;
  const usedCount = records.filter((item) => item.movement === 'used').length;
  const lowCount = balances.filter((item) => item.balance <= 0).length;
  return `<div class="view-grid">${recordFilterBar('inventory', inventoryFilter)}<div class="metrics inventory-metrics"><div class="metric metric-accent"><div class="metric-label">Items tracked</div><div class="metric-value">${balances.length}</div></div><div class="metric metric-accent sage"><div class="metric-label">Received entries shown</div><div class="metric-value">${receivedCount}</div></div><div class="metric metric-accent coral"><div class="metric-label">Used entries shown</div><div class="metric-value">${usedCount}</div></div><div class="metric metric-accent dark"><div class="metric-label">Out / negative stock</div><div class="metric-value">${lowCount}</div></div></div>
  <section class="panel"><div class="panel-heading"><div><h2>Current factory inventory</h2><small>Standalone stock calculated from all received minus all used entries</small></div></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Material / item</th><th>Unit</th><th>Total received</th><th>Total used</th><th>Available now</th><th>Status</th></tr></thead><tbody>${balances.map((item) => `<tr><td><strong>${escapeHtml(item.itemName)}</strong></td><td>${escapeHtml(item.unit)}</td><td>${formatNumber(item.received)}</td><td>${formatNumber(item.used)}</td><td><strong>${formatNumber(item.balance)} ${escapeHtml(item.unit)}</strong></td><td><span class="stock-status ${item.balance <= 0 ? 'stock-out' : 'stock-ok'}">${item.balance <= 0 ? 'Out / negative' : 'Available'}</span></td></tr>`).join('') || '<tr><td colspan="6"><div class="empty-state">No standalone inventory yet. Record material received to create stock.</div></td></tr>'}</tbody></table></div></section>
  <div class="section-toolbar"><div><h2>${records.length} movement${records.length === 1 ? '' : 's'} shown</h2><small class="section-note">Inventory is separate from BOM, production, and sales.</small></div><button class="outline-button" data-action="add-inventory">+ Record movement</button></div><section class="panel"><div class="table-wrap"><table class="data-table"><thead><tr><th>Date</th><th>Material / item</th><th>Movement</th><th>Quantity</th><th>Unit</th><th>Notes</th><th>Actions</th></tr></thead><tbody>${records.slice().reverse().map((item) => `<tr><td>${dateLabel(item.date)}</td><td><strong>${escapeHtml(item.itemName)}</strong></td><td><span class="movement-pill ${item.movement === 'used' ? 'movement-used' : 'movement-received'}">${item.movement === 'used' ? 'Used' : 'Received'}</span></td><td>${formatNumber(item.quantity)}</td><td>${escapeHtml(item.unit)}</td><td>${escapeHtml(item.notes || '-')}</td><td><button class="small-button" data-edit-inventory="${item.id}">Edit</button> <button class="small-button danger-action" data-delete-inventory="${item.id}">Remove</button></td></tr>`).join('') || '<tr><td colspan="7"><div class="empty-state">No inventory movements in this date range.</div></td></tr>'}</tbody></table></div></section></div>`;
}

function openModal(type, id) {
  const collection = type === 'product' ? state.products : type === 'production' ? state.production : type === 'sale' ? state.sales : type === 'group' ? (state.groups || []) : state.inventory;
  const existing = id ? collection.find((item) => item.id === id) : null;
  const titles = { group: existing ? 'Rename group' : 'New product group', product: existing ? 'Edit product' : 'Add product', production: existing ? 'Edit production' : 'Add production', sale: existing ? 'Edit sale' : 'Record sale', inventory: existing ? 'Edit movement' : 'Record inventory movement' };
  const eyebrows = { group: 'BILL OF MATERIALS', product: 'BILL OF MATERIALS', production: 'SHOP FLOOR', sale: 'INVENTORY OUT', inventory: 'FACTORY INVENTORY' };
  $('#modalTitle').textContent = titles[type]; $('#modalEyebrow').textContent = eyebrows[type];
  $('#modalBody').innerHTML = type === 'group' ? groupForm(existing) : type === 'product' ? productForm(existing) : type === 'production' ? productionForm(existing) : type === 'sale' ? saleForm(existing) : inventoryForm(existing);
  $('#modalBackdrop').classList.remove('hidden');
  $('#modalBody form').addEventListener('submit', (event) => { event.preventDefault(); handleForm(type, existing?.id); });
  if (type === 'production') setTimeout(() => attachProductionSync(), 30);
}
function productForm(product) { const materials = product?.materials || []; const groups = groupList(); const currentGroup = validGroupId(product?.groupId); return `<form><div class="form-grid"><div class="field full"><label for="productName">Product name</label><input id="productName" name="name" required value="${escapeHtml(product?.name || '')}" placeholder="e.g. Mango Nectar"></div><div class="field full"><label for="productGroup">Group</label><select id="productGroup" name="groupId"><option value="" ${currentGroup ? '' : 'selected'}>Ungrouped</option>${groups.map((group) => `<option value="${group.id}" ${group.id === currentGroup ? 'selected' : ''}>${escapeHtml(group.name)}</option>`).join('')}<option value="__new__">+ Create new group…</option></select></div><div class="field full hidden" id="newGroupField"><label for="newGroupName">New group name</label><input id="newGroupName" name="newGroupName" placeholder="e.g. Syrups"></div></div><details class="optional-product-details" ${product && (product.batchOutput || materials.length) ? 'open' : ''}><summary>Add optional production & raw material details</summary><div class="optional-details-body"><div class="field"><label for="batchOutput">Output per batch <small>(optional)</small></label><input id="batchOutput" name="batchOutput" type="number" min="0" value="${product?.batchOutput || ''}" placeholder="e.g. 1200 bottles"></div><div class="material-builder"><div class="builder-header"><label>Raw materials per batch <small>(optional)</small></label><button class="link-button" type="button" id="addMaterial">+ Add material</button></div><div id="materialsList">${materials.map((material) => materialRow(material)).join('')}</div><p class="optional-hint" id="noMaterialsHint">You can save the product without adding raw materials.</p></div></div></details><div class="form-actions"><button type="button" class="outline-button" id="cancelModal">Cancel</button><button class="primary-button" type="submit">Save product</button></div></form>`; }
function materialRow(material) { 
  const units = ['kg','g','L','ml','unit','pieces','pcs','bunch','pack'];
  const options = units.map(u => `<option ${material.unit === u ? 'selected' : ''}>${u}</option>`).join('');
  return `<div class="material-row"><input name="materialName" placeholder="Material name (e.g. Sugar)" value="${escapeHtml(material.name)}"><input name="materialQty" type="number" min="0" step="any" placeholder="Qty" value="${material.qty}"><select name="materialUnit" aria-label="Material unit">${options}</select><button type="button" class="remove-material" aria-label="Remove material">×</button></div>`; 
}
function productOptions(selectedId = '') { return state.products.map((product) => `<option value="${product.id}" ${product.id === selectedId ? 'selected' : ''}>${escapeHtml(product.name)}</option>`).join(''); }
function getProductById(id){ return state.products.find(p=>p.id===id); }
function dozenPerBatchForProduct(product){ const out = Number(product?.batchOutput||0); return out ? out/12 : 30; }
function productionForm(existing = null) {
  const selectedProduct = getProductById(existing?.productId) || state.products[0];
  const dpb = selectedProduct ? dozenPerBatchForProduct(selectedProduct) : 30;
  const defBottles = existing ? Number(existing.bottles || 0) : Number(selectedProduct?.batchOutput) || 360;
  const defBatches = existing ? Number(existing.batches || 0) : 1;
  const defDozen = defBottles / 12;
  return `<form id="productionForm"><div class="form-grid">
    <div class="field"><label>Date</label><input name="date" type="date" required value="${existing?.date || toISODate(today)}"></div>
    <div class="field"><label>Product manufactured</label><select name="productId" id="prodProduct" required>${productOptions(selectedProduct?.id) || '<option value="">Add a product first</option>'}</select></div>
    <div class="field"><label>Batches complete <small>(1 batch = <span id="dpbLabel">${dpb.toFixed(2)}</span> doz)</small></label><input id="prodBatches" name="batches" type="number" min="0.00001" step="0.00001" required value="${defBatches.toFixed(5)}"></div>
    <div class="field"><label>Quantity (dozen)</label><input id="prodDozen" name="dozenInput" type="number" min="0.01" step="0.01" required value="${defDozen.toFixed(2)}"></div>
    <div class="field"><label>Bottles produced</label><input id="prodBottles" name="bottles" type="number" min="1" step="1" required value="${defBottles}"></div>
  </div><div class="form-actions"><button type="button" class="outline-button" id="cancelModal">Cancel</button><button class="primary-button" type="submit" ${state.products.length ? '' : 'disabled'}>${existing ? 'Update' : 'Save'} production</button></div></form>`;
}
function attachProductionSync(){
  const prodSel = document.getElementById('prodProduct');
  const batchesEl = document.getElementById('prodBatches');
  const dozenEl = document.getElementById('prodDozen');
  const bottlesEl = document.getElementById('prodBottles');
  const dpbLabel = document.getElementById('dpbLabel');
  const calcEx = document.getElementById('calcExample');
  if(!prodSel || !batchesEl) return;
  function getCurrentProduct(){ return getProductById(prodSel.value) || state.products[0]; }
  function updateDpbLabel(){
    const prod = getCurrentProduct();
    const dpb = dozenPerBatchForProduct(prod);
    if(dpbLabel) dpbLabel.textContent = dpb.toFixed(2);
    if(calcEx) calcEx.textContent = (22/dpb).toFixed(5);
    return dpb;
  }
  function fromBatches(){
    const prod = getCurrentProduct();
    const dpb = dozenPerBatchForProduct(prod);
    const batches = parseFloat(batchesEl.value)||0;
    const dozen = batches*dpb;
    const bottles = batches*(Number(prod?.batchOutput) || dpb*12);
    if(dozenEl) dozenEl.value = dozen ? dozen.toFixed(2) : '';
    if(bottlesEl) bottlesEl.value = bottles ? Math.round(bottles) : '';
  }
  function fromDozen(){
    const prod = getCurrentProduct();
    const dpb = dozenPerBatchForProduct(prod);
    const dozen = parseFloat(dozenEl.value)||0;
    const batches = dpb ? dozen/dpb : 0;
    const bottles = dozen*12;
    if(batchesEl) batchesEl.value = batches ? batches.toFixed(5) : '';
    if(bottlesEl) bottlesEl.value = bottles ? Math.round(bottles) : '';
  }
  function fromBottles(){
    const prod = getCurrentProduct();
    const out = Number(prod?.batchOutput) || dozenPerBatchForProduct(prod)*12;
    const bottles = parseFloat(bottlesEl.value)||0;
    const batches = out ? bottles/out : 0;
    const dozen = bottles/12;
    if(batchesEl) batchesEl.value = batches ? batches.toFixed(5) : '';
    if(dozenEl) dozenEl.value = dozen ? dozen.toFixed(2) : '';
  }
  prodSel.addEventListener('change', ()=>{ updateDpbLabel(); fromBatches(); });
  batchesEl.addEventListener('input', fromBatches);
  dozenEl.addEventListener('input', fromDozen);
  bottlesEl.addEventListener('input', fromBottles);
  updateDpbLabel();
}
function saleForm(existing = null) { const items = existing ? saleItems(existing) : [null]; return `<form><div class="form-grid"><div class="field"><label>Date shipped</label><input name="date" type="date" required value="${existing?.date || toISODate(today)}"></div><div class="field"><label>Customer</label><input name="customer" required value="${escapeHtml(existing?.customer || '')}" placeholder="Customer or outlet"></div><div class="field"><label>Phone number <small>(optional)</small></label><input name="phone" type="tel" value="${escapeHtml(existing?.phone || '')}" placeholder="e.g. +1 555 0100"></div><div class="field full"><label>Address <small>(optional)</small></label><input name="address" value="${escapeHtml(existing?.address || '')}" placeholder="Customer delivery or billing address"></div><div class="field"><label>Proforma</label><input name="proforma" value="${escapeHtml(existing?.proforma || '')}" placeholder="e.g. PF-104"></div><div class="field full"><label>Products sold</label><div id="saleItems">${items.map((item) => saleItemRow(item)).join('')}</div><button class="link-button" type="button" id="addSaleProduct">+ Add another product</button><p class="optional-hint">Sales can be recorded even when stock is zero or negative.</p></div><div class="field"><label>Total receipt</label><input name="receipt" type="number" min="0" step="0.01" value="${escapeHtml(existing?.receipt || '')}" placeholder="0.00"></div></div><div class="form-actions"><button type="button" class="outline-button" id="cancelModal">Cancel</button><button class="primary-button" type="submit">${existing ? 'Update sale' : 'Record sale'}</button></div></form>`; }
function saleItemRow(item = null) { const isCustom = Boolean(item?.customName) || (item?.productId && !getProductById(item.productId)); return `<div class="sale-item-row">${saleProductCombo(item, isCustom)}<input class="sale-custom-name ${isCustom ? '' : 'hidden'}" name="saleCustomName" value="${escapeHtml(isCustom ? itemProductName(item) : '')}" placeholder="New product name" aria-label="New product name" ${isCustom ? 'required' : ''}><input name="saleDozen" type="number" min="0.01" step="0.01" required value="${item?.dozen || ''}" placeholder="Volume (doz)"><button type="button" class="remove-sale-product" aria-label="Remove product">×</button></div>`; }
function inventoryForm(existing = null) { const units = ['kg','g','L','ml','bottles','boxes','cartons','pieces','packs']; const selectedUnit = existing?.unit || 'kg'; return `<form><div class="inventory-explainer"><strong>Standalone factory inventory</strong><span>Received adds stock. Used subtracts stock. This does not connect to BOM, production, or sales.</span></div><div class="form-grid"><div class="field"><label>Date</label><input name="date" type="date" required value="${existing?.date || toISODate(today)}"></div><div class="field"><label>Movement</label><select name="movement" required><option value="received" ${existing?.movement !== 'used' ? 'selected' : ''}>Received in factory (+)</option><option value="used" ${existing?.movement === 'used' ? 'selected' : ''}>Used in factory (−)</option></select></div><div class="field full"><label>Material or item name</label><input name="itemName" required value="${escapeHtml(existing?.itemName || '')}" placeholder="e.g. Sugar, Sharbat bottle 900ml"></div><div class="field"><label>Quantity</label><input name="quantity" type="number" min="0.00001" step="any" required value="${existing?.quantity ?? ''}" placeholder="e.g. 300"></div><div class="field"><label>Unit</label><select name="unit">${units.map((unit) => `<option value="${unit}" ${selectedUnit === unit ? 'selected' : ''}>${unit}</option>`).join('')}</select></div><div class="field full"><label>Notes <small>(optional)</small></label><input name="notes" value="${escapeHtml(existing?.notes || '')}" placeholder="Supplier, department, size, or other detail"></div></div><div class="form-actions"><button type="button" class="outline-button" id="cancelModal">Cancel</button><button class="primary-button" type="submit">${existing ? 'Update movement' : 'Save movement'}</button></div></form>`; }

function handleForm(type, editId) {
  const form = $('#modalBody form'); const data = new FormData(form); let savedSaleId = null;
  if (type === 'group') {
    const name = String(data.get('name') || '').trim();
    if (!name) { notify('Enter a group name'); return; }
    state.groups = state.groups || [];
    if (editId) state.groups = state.groups.map((group) => group.id === editId ? { ...group, name } : group);
    else state.groups.push({ id: crypto.randomUUID(), name });
    notify(editId ? 'Group renamed' : `Group “${name}” created`);
  } else if (type === 'product') {
    const names = data.getAll('materialName'), quantities = data.getAll('materialQty'), units = data.getAll('materialUnit');
    const materials = names.map((name,index) => ({ name:String(name).trim(), qty:quantities[index], unit:units[index] })).filter((material) => material.name);
    let groupId = String(data.get('groupId') || '');
    if (groupId === '__new__') {
      const newName = String(data.get('newGroupName') || '').trim();
      if (!newName) { notify('Enter a name for the new group'); return; }
      const existingGroup = (state.groups || []).find((group) => group.name.trim().toLowerCase() === newName.toLowerCase());
      if (existingGroup) groupId = existingGroup.id;
      else { const created = { id: crypto.randomUUID(), name: newName }; state.groups = [...(state.groups || []), created]; groupId = created.id; }
    }
    const record = { id: editId || crypto.randomUUID(), name:String(data.get('name')).trim(), groupId, batchOutput:Number(data.get('batchOutput')), materials };
    if (editId) state.products = state.products.map((item) => item.id === editId ? record : item); else state.products.push(record);
    notify(editId ? 'Product updated' : 'Product added');
  } else if (type === 'production') {
    const product = getProductById(data.get('productId')), batches = Number(data.get('batches'));
    const record = { id: editId || crypto.randomUUID(), date:data.get('date'), productId:data.get('productId'), batches, bottles:Number(data.get('bottles')) || batches * (Number(product?.batchOutput) || 360) };
    if (editId) state.production = state.production.map((item) => item.id === editId ? record : item); else state.production.push(record);
    notify(editId ? 'Production updated' : 'Production saved');
  } else if (type === 'sale') {
    const productIds = data.getAll('saleProductId'), customNames = data.getAll('saleCustomName'), quantities = data.getAll('saleDozen').map(Number);
    const items = productIds.map((selectedId,index) => { const customName=String(customNames[index]||'').trim(), isCustom=selectedId==='__custom__'; return { productId:isCustom ? `external:${customName.toLowerCase()}` : selectedId, dozen:quantities[index], ...(isCustom ? {customName}: {}) }; }).filter((item) => item.productId && item.productId !== 'external:' && item.dozen > 0);
    if (!items.length) { notify('Select a BOM product or enter a new product name'); return; }
    const record = { id:editId || crypto.randomUUID(), date:data.get('date'), customer:data.get('customer'), phone:data.get('phone'), address:data.get('address'), proforma:data.get('proforma'), productId:items[0].productId, dozen:items.reduce((sum,item)=>sum+item.dozen,0), items, receipt:data.get('receipt') };
    if (editId) state.sales = state.sales.map((item) => item.id === editId ? record : item); else { state.sales.push(record); savedSaleId = record.id; }
    notify(editId ? 'Sale updated' : `${items.length} product${items.length === 1 ? '' : 's'} recorded`);
  } else {
    const record = { id:editId || crypto.randomUUID(), date:data.get('date'), itemName:String(data.get('itemName')).trim(), movement:data.get('movement'), quantity:Number(data.get('quantity')), unit:data.get('unit'), notes:data.get('notes') };
    if (editId) state.inventory = state.inventory.map((item) => item.id === editId ? record : item); else state.inventory.push(record);
    notify(editId ? 'Inventory movement updated' : (record.movement === 'used' ? 'Usage saved and stock reduced' : 'Received stock added'));
  }
  saveState(); closeModal(); render(); if (savedSaleId) printInvoice(savedSaleId);
}
async function printInvoice(saleId) {
  const sale = state.sales.find((item) => item.id === saleId);
  if (!sale) return;
  try {
    if (!window.PDFLib) throw new Error('PDFLib not loaded');
    const PDFLib = window.PDFLib;
    const templateBytes = await fetch('template.pdf').then(r => {
      if (!r.ok) throw new Error('template.pdf not found');
      return r.arrayBuffer();
    });
    const pdfDoc = await PDFLib.PDFDocument.load(templateBytes);
    const helv = await pdfDoc.embedFont(PDFLib.StandardFonts.Helvetica);
    const helvBold = await pdfDoc.embedFont(PDFLib.StandardFonts.HelveticaBold);
    const pages = pdfDoc.getPages();
    const IMG_W = 1241, IMG_H = 1754;
    // Row Ys calibrated from template_render.png via OpenCV detection
    const rowYsImg = [829, 902, 975, 1048, 1121, 1194, 1267];
    const saleItemList = saleItems(sale).slice(0, 7);

    for (let pIdx = 0; pIdx < pages.length; pIdx++) {
      const page = pages[pIdx];
      const { width, height } = page.getSize();
      const sx = width / IMG_W;
      const sy = height / IMG_H;
      const ip = (xImg, yImg) => ({ x: xImg * sx, y: height - yImg * sy });

      // Customer details - up and right, increased font, not bold
      let pt = ip(905, 462);
      page.drawText(String(sale.customer || ''), { x: pt.x, y: pt.y, size: 15, font: helv, color: PDFLib.rgb(0,0,0) });

      // Address - auto-wraps to a new line below when too long.
      // 1st line starts at its normal x (802). 2nd+ lines start aligned under the
      // "Address:" heading (x=318.43, bottom-origin -> image units) so they take
      // less space.
      const addrXImg = 799, addrYImg = 503, addrLineH = 32;
      const addrMaxW = (1180 - addrXImg) * sx; // max address width in points
      const addrContXImg = 318.43 / sx;        // align 2nd+ lines under "Address:" heading
      const addrLines = wrapTextToFit(String(sale.address || ''), helv, 15, addrMaxW);
      const addrShift = Math.max(0, addrLines.length - 1) * addrLineH;

      // Move the baked-in "Ph no:" and "Date:" headings down together with the
      // values when the address wrapped. Always redraw them in bold.
      // Erase BOTH originals first, then redraw both (bold) shifted by addrShift.
      {
        const shiftPts = addrShift * sy; // convert image-units shift to PDF points
        const white = PDFLib.rgb(1, 1, 1);
        // Erase original headings: "Ph no:" baseline y=581.71, "Date:" baseline y=561.79
        page.drawRectangle({ x: 312, y: 581.7, width: 70, height: 14, color: white });
        page.drawRectangle({ x: 312, y: 561.8, width: 70, height: 14, color: white });
        // Redraw headings in bold, shifted down by the wrap amount
        page.drawText('Ph no:', { x: 318.43, y: 581.71 - shiftPts, size: 14.04, font: helvBold, color: PDFLib.rgb(0,0,0) });
        page.drawText('Date:', { x: 318.43, y: 561.79 - shiftPts, size: 14.04, font: helvBold, color: PDFLib.rgb(0,0,0) });
      }

      // Draw address lines ON TOP of any heading covers so a wrapped 2nd line is visible
      addrLines.forEach((line, i) => {
        const p = ip(i === 0 ? addrXImg : addrContXImg, addrYImg + i * addrLineH);
        page.drawText(line, { x: p.x, y: p.y, size: 15, font: helv });
      });

      pt = ip(753, 545 + addrShift);
      page.drawText(String(sale.phone || ''), { x: pt.x, y: pt.y, size: 15, font: helv });
      pt = ip(744, 585 + addrShift);
      let dateStr = dateLabel(sale.date);
      if (sale.proforma) dateStr += '  Proforma:' + sale.proforma;
      page.drawText(dateStr, { x: pt.x, y: pt.y, size: 15, font: helv });

      // Table - Description column only
      for (let i = 0; i < rowYsImg.length; i++) {
        const item = saleItemList[i];
        if (!item) continue;
        const yImg = rowYsImg[i];
        // S.No - left column
        let pp = ip(70, yImg);
        page.drawText(String(i+1), { x: pp.x, y: pp.y, size: 17, font: helv });
        // Description - clearly inside Description column (x=220, not in S.No)
        pp = ip(220, yImg);
        page.drawText(capitalizeFirst(itemProductName(item)), { x: pp.x, y: pp.y, size: 17, font: helv });
        // Qty
        pp = ip(1050, yImg);
        page.drawText(formatNumber(item.dozen) + ' doz', { x: pp.x, y: pp.y, size: 17, font: helv });
      }
    }

    const pdfBytes = await pdfDoc.save();
    if (window.desktopAPI?.savePdf) {
      // Desktop: show the invoice in the built-in PDF preview. Saving and
      // printing are optional buttons — nothing is written to disk and no PDF
      // is stored with the sales data (the PDF is re-created from the record
      // every time it is opened).
      showPdfPreview(pdfBytes, sale);
      return;
    }
    const blob = new Blob([pdfBytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
  } catch (err) {
    console.error(err);
    notify('PDF edit failed: ' + err.message);
  }
}

// Convert bytes to a base64 data URL without blowing the call stack on big files.
function uint8ToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// In-app invoice PDF viewer (frameless modal). The PDF is rendered from the
// sale record on demand; "Save PDF…" and "Print…" are optional actions.
function showPdfPreview(pdfBytes, sale) {
  const base64 = uint8ToBase64(new Uint8Array(pdfBytes));
  $('#modalEyebrow').textContent = 'INVOICE PDF';
  $('#modalTitle').textContent = `Invoice — ${sale.customer || 'customer'}`;
  $('#modalBody').innerHTML = `
    <div class="pdf-preview-wrap"><embed class="pdf-preview" type="application/pdf" src="data:application/pdf;base64,${base64}"></div>
    <div class="pdf-actions">
      <button type="button" class="outline-button" id="pdfPrint">Print…</button>
      <button type="button" class="outline-button" id="pdfSave">Save PDF…</button>
      <button type="button" class="primary-button" id="cancelModal">Close</button>
    </div>`;
  document.querySelector('.modal')?.classList.add('pdf-modal');
  $('#modalBackdrop').classList.remove('hidden');
  $('#pdfSave').addEventListener('click', async () => {
    const result = await window.desktopAPI.savePdf(pdfBytes, sale.id, sale.customer);
    if (result && result.cancelled) return;
    notify(result && result.ok ? 'Invoice PDF saved' : 'Invoice PDF save failed');
  });
  $('#pdfPrint').addEventListener('click', async () => {
    const result = await window.desktopAPI.printPdf(pdfBytes);
    if (result && !result.ok) notify('Print failed: ' + (result.error || 'unknown error'));
  });
}

function closeModal() { $('#modalBackdrop').classList.add('hidden'); document.querySelector('.modal')?.classList.remove('pdf-modal'); }
function notify(message) { const toast = $('#toast'); toast.textContent = message; toast.classList.add('show'); setTimeout(() => toast.classList.remove('show'), 2400); }

document.addEventListener('click', (event) => {
  if (!event.target.closest('.account-menu')) closeAccountMenu();

  // --- Popover handling (mobile tap) ---
  const backdropClicked = event.target.closest('#popoverBackdrop');
  if (backdropClicked) { closeAllPopovers(); return; }

  const popoverTrigger = event.target.closest('.has-popover');
  if (popoverTrigger) {
    const insidePopover = event.target.closest('.metric-popover');
    if (insidePopover && popoverTrigger.classList.contains('popover-open')) {
      // let users interact inside popover (scroll) without closing
      return;
    }
    const wasOpen = popoverTrigger.classList.contains('popover-open');
    closeAllPopovers();
    if (!wasOpen) {
      popoverTrigger.classList.add('popover-open');
      const bd = document.getElementById('popoverBackdrop');
      if (bd) bd.classList.add('show');
    }
    return;
  } else {
    // click outside any popover card -> close if open (but don't interfere with other clicks that will handle below)
    if (document.querySelector('.has-popover.popover-open') && !event.target.closest('.modal')) {
      // only close if not clicking inside modal or other important UI
      // Actually close, then continue to allow other actions
      closeAllPopovers();
    }
  }

  const bomProduct = event.target.closest('[data-bom-product]'); if (bomProduct) { showBomProductDetail(bomProduct.dataset.bomProduct); return; } const recordPresetButton = event.target.closest('[data-record-filter-preset]'); if (recordPresetButton) { const filter = filterForScope(recordPresetButton.dataset.recordFilterScope); const preset = recordPresetButton.dataset.recordFilterPreset; filter.preset = preset; if (preset !== 'custom') { const range = computePresetRange(preset); filter.start = range.start; filter.end = range.end; } else if (!filter.start && !filter.end) { const range = computePresetRange('30'); filter.start = range.start; filter.end = range.end; } render(); return; } const filterPreset = event.target.closest('[data-filter-preset]'); if (filterPreset) { const preset = filterPreset.dataset.filterPreset; dashboardFilter.preset = preset; if (preset !== 'custom') { const range = computePresetRange(preset); dashboardFilter.start = range.start; dashboardFilter.end = range.end; } else if (!dashboardFilter.start && !dashboardFilter.end) { const range = computePresetRange('30'); dashboardFilter.start = range.start; dashboardFilter.end = range.end; } render(); return; } const salesMetricButton = event.target.closest('[data-sales-metric]'); if (salesMetricButton) { salesChartMetric = salesMetricButton.dataset.salesMetric; render(); return; } const productFilterRow = event.target.closest('[data-product-filter]'); if (productFilterRow) { showProductSalesDetail(productFilterRow.dataset.productFilter); return; } const rawProductRow = event.target.closest('[data-raw-product]'); if (rawProductRow) { showRawMaterialDetail(rawProductRow.dataset.rawProduct); return; } const action = event.target.closest('[data-action]')?.dataset.action; if (action === 'add-product') openModal('product'); if (action === 'add-production') openModal('production'); if (action === 'add-sale') openModal('sale'); if (action === 'add-inventory') openModal('inventory'); if (action === 'production') setView('production'); const editProduction = event.target.closest('[data-edit-production]'); if (editProduction) openModal('production', editProduction.dataset.editProduction); const editSale = event.target.closest('[data-edit-sale]'); if (editSale) openModal('sale', editSale.dataset.editSale); const editInventory = event.target.closest('[data-edit-inventory]'); if (editInventory) openModal('inventory', editInventory.dataset.editInventory); const printButton = event.target.closest('[data-print-sale]'); if (printButton) printInvoice(printButton.dataset.printSale); const deleteSale = event.target.closest('[data-delete-sale]'); if (deleteSale && confirm('Remove this sales record? Stock will be restored.')) { state.sales = state.sales.filter((sale) => sale.id !== deleteSale.dataset.deleteSale); saveState(); render(); notify('Sales record removed'); if ($('#modalEyebrow')?.textContent === 'SALES DETAIL' && salesDetailProductId) showProductSalesDetail(salesDetailProductId); } const deleteInventory = event.target.closest('[data-delete-inventory]'); if (deleteInventory && confirm('Remove this inventory record?')) { state.inventory = state.inventory.filter((item) => item.id !== deleteInventory.dataset.deleteInventory); saveState(); render(); notify('Inventory record removed'); } const deleteProduction = event.target.closest('[data-delete-production]'); if (deleteProduction && confirm('Remove this production record?')) { state.production = state.production.filter((item) => item.id !== deleteProduction.dataset.deleteProduction); saveState(); render(); notify('Production record removed'); } const edit = event.target.closest('[data-edit-product]'); if (edit) openModal('product', edit.dataset.editProduct); const remove = event.target.closest('[data-delete-product]'); if (remove && confirm('Delete this product? Existing production and sales records stay in your history.')) { state.products = state.products.filter((product) => product.id !== remove.dataset.deleteProduct); saveState(); closeModal(); render(); notify('Product deleted'); } if (event.target.id === 'addMaterial') { $('#materialsList').insertAdjacentHTML('beforeend', materialRow({ name: '', qty: '', unit: 'kg' })); $('#noMaterialsHint')?.classList.add('hidden'); } if (event.target.id === 'addSaleProduct') $('#saleItems').insertAdjacentHTML('beforeend', saleItemRow()); if (event.target.classList.contains('remove-material')) event.target.closest('.material-row').remove(); if (event.target.classList.contains('remove-sale-product')) { const rows = document.querySelectorAll('.sale-item-row'); if (rows.length > 1) event.target.closest('.sale-item-row').remove(); } if (event.target.id === 'cancelModal' || event.target.id === 'closeModal' || event.target.id === 'modalBackdrop') closeModal(); });
document.addEventListener('change', (event) => { if (event.target.name === 'saleProductId') { const customInput = event.target.closest('.sale-item-row')?.querySelector('.sale-custom-name'); if (customInput) { const custom = event.target.value === '__custom__'; customInput.classList.toggle('hidden', !custom); customInput.required = custom; if (custom) customInput.focus(); else customInput.value = ''; } } if (event.target.dataset.recordFilterDate) { const filter = filterForScope(event.target.dataset.recordFilterScope); filter[event.target.dataset.recordFilterDate] = event.target.value || null; render(); } if (event.target.id === 'filterStart') { dashboardFilter.start = event.target.value || null; render(); } if (event.target.id === 'filterEnd') { dashboardFilter.end = event.target.value || null; render(); } });
document.addEventListener('input', (event) => { if (event.target.id === 'bomSearch') { bomSearch = event.target.value; render(); requestAnimationFrame(() => { const input = $('#bomSearch'); if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); } }); } });
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeAllPopovers();
    closeAccountMenu();
    closeModal();
  }
  if ((event.key === 'Enter' || event.key === ' ') && event.target.closest('[data-bom-product]')) { event.preventDefault(); showBomProductDetail(event.target.closest('[data-bom-product]').dataset.bomProduct); } if ((event.key === 'Enter' || event.key === ' ') && event.target.closest('[data-product-filter]')) { event.preventDefault(); showProductSalesDetail(event.target.closest('[data-product-filter]').dataset.productFilter); } if ((event.key === 'Enter' || event.key === ' ') && event.target.closest('[data-raw-product]')) { event.preventDefault(); showRawMaterialDetail(event.target.closest('[data-raw-product]').dataset.rawProduct); }
  if ((event.key === 'Enter' || event.key === ' ') && event.target.closest('.has-popover')) {
    event.preventDefault();
    const trigger = event.target.closest('.has-popover');
    const wasOpen = trigger.classList.contains('popover-open');
    closeAllPopovers();
    if (!wasOpen) {
      trigger.classList.add('popover-open');
      const bd = document.getElementById('popoverBackdrop');
      if (bd) bd.classList.add('show');
    }
  }
});
document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
$('#quickAction').addEventListener('click', () => openModal(currentView === 'bom' ? 'product' : currentView === 'sales' ? 'sale' : currentView === 'inventory' ? 'inventory' : 'production'));
$('#clearData').addEventListener('click', () => { if (confirm('Reset all workspace data? This cannot be undone.')) { state = { products: [], production: [], sales: [], inventory: [], groups: [] }; saveState(); render(); notify('Workspace reset'); } });

// ---- Desktop extras ----
// Native restore keeps working from the sidebar too (same shared JSON format).
$('#restoreData')?.addEventListener('click', async () => {
  const result = await Desktop.restore();
  if (result && result.cancelled) return;
  if (result && result.ok) {
    state = { products: result.data.products || [], production: result.data.production || [], sales: result.data.sales || [], inventory: migrateInventory(result.data.inventory || []), groups: result.data.groups || [] };
    saveState(); render(); notify('Data restored from backup');
  } else {
    notify('Restore failed: ' + ((result && result.error) || 'Unknown error'));
  }
});
$('#dataLocation')?.addEventListener('click', () => window.desktopAPI?.showDataLocation?.());

// Desktop menu (File → Backup data… / Restore data… / Export Excel…).
Desktop.onMenu((action) => {
  if (action === 'backup') openBackupModal();
  else if (action === 'restore') $('#restoreData')?.click();
  else if (action === 'export-excel') openExportModal?.();
});

// ---- Custom window controls (frameless desktop window) ----
function setMaximizedIcon(maximized) {
  const button = $('#winMax');
  if (!button) return;
  button.classList.toggle('is-maximized', maximized);
  button.title = maximized ? 'Restore' : 'Maximize';
  // CSS uses this to square the corners + remove the shadow when maximized.
  document.documentElement.classList.toggle('window-maximized', maximized);
}
if (window.desktopAPI && typeof window.desktopAPI.minimize === 'function') {
  $('#winMin')?.addEventListener('click', () => window.desktopAPI.minimize());
  $('#winMax')?.addEventListener('click', () => window.desktopAPI.toggleMaximize());
  $('#winClose')?.addEventListener('click', () => window.desktopAPI.close());
  window.desktopAPI.onMaximized?.(setMaximizedIcon);
  window.desktopAPI.isMaximized?.().then(setMaximizedIcon);
}

// Boot: no login needed — load the local data file and render.
(async () => {
  await bootApp();
  const info = await Desktop.paths();
  updateAccountUI(info);
  if (info && info.location === 'appdata') {
    notify('Install folder is protected by Windows — data is saved in your user folder.');
  }
})();


/* =====================================================================
   THEME (dark / light)
   Preference is per-device and stored in localStorage under 'md-theme'.
   The initial value is applied by the inline script in index.html so the
   page never flashes light before this file runs.
   ===================================================================== */
const THEME_KEY = 'md-theme';

function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

function applyTheme(theme, persist = true) {
  const next = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', next === 'dark' ? '#101512' : '#f4f1ea');
  if (persist) { try { localStorage.setItem(THEME_KEY, next); } catch (err) { /* private mode */ } }
  document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
    button.setAttribute('aria-label', next === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
    button.title = next === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  });
  const stateLabel = $('#accountThemeState');
  if (stateLabel) stateLabel.textContent = next === 'dark' ? 'Dark mode is on · tap for light' : 'Light mode is on · tap for dark';
  return next;
}

function toggleTheme() {
  const next = applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
  notify(next === 'dark' ? 'Dark mode on' : 'Light mode on');
}

document.querySelectorAll('[data-theme-toggle]').forEach((button) => button.addEventListener('click', toggleTheme));
$('#accountTheme')?.addEventListener('click', () => { toggleTheme(); closeAccountMenu(); });

// Follow the operating system only while the user has not picked a theme.
try {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener?.('change', (event) => {
    if (!localStorage.getItem(THEME_KEY)) applyTheme(event.matches ? 'dark' : 'light', false);
  });
} catch (err) { /* matchMedia unavailable */ }

applyTheme(currentTheme(), false);


/* =====================================================================
   BACKUP & RESTORE  (portable JSON — website  <->  Windows software)
   File shape:
   {
     "format": "maaz-dawakhana-backup",
     "schemaVersion": 1,
     "generatedBy": "website",
     "exportedAt": "<ISO timestamp>",
     "counts": { products, production, sales, inventory },
     "data": { products: [], production: [], sales: [], inventory: [] }
   }
   The reader below is deliberately forgiving: it also accepts a bare
   { products, production, sales, inventory } object, a { data: {...} }
   wrapper, PascalCase keys, and dd/mm/yyyy or ISO date-times, so a file
   written by the Windows app restores here without conversion.
   ===================================================================== */
const BACKUP_FORMAT = 'maaz-dawakhana-backup';
const BACKUP_SCHEMA_VERSION = 1;
const BACKUP_SECTIONS = ['groups', 'products', 'production', 'sales', 'inventory'];

function newId() {
  return (crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

// Case-insensitive property lookup so PascalCase files from the Windows app work.
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

function buildBackupPayload() {
  const data = {
    groups: state.groups || [],
    products: state.products || [],
    production: state.production || [],
    sales: state.sales || [],
    inventory: state.inventory || []
  };
  return {
    format: BACKUP_FORMAT,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    app: 'Maaz Dawakhana',
    generatedBy: 'windows',
    exportedAt: new Date().toISOString(),
    counts: BACKUP_SECTIONS.reduce((counts, key) => ({ ...counts, [key]: data[key].length }), {}),
    data
  };
}

function downloadBackupFile() {
  try {
    const payload = buildBackupPayload();
    const stamp = new Date();
    const name = `maaz-dawakhana-backup-${toISODate(stamp)}-${String(stamp.getHours()).padStart(2, '0')}${String(stamp.getMinutes()).padStart(2, '0')}.json`;
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = name;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    const total = Object.values(payload.counts).reduce((sum, value) => sum + value, 0);
    notify(`Backup saved · ${total} records`);
  } catch (err) {
    console.error(err);
    notify('Backup failed: ' + err.message);
  }
}

// Accepts our own file, a bare state object, or a { data: {...} } wrapper.
function parseBackupText(text) {
  let raw;
  try { raw = JSON.parse(text); } catch (err) { throw new Error('This file is not valid JSON.'); }
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
  return {
    data: normalized,
    meta: {
      format: pick(raw, 'format') || 'unknown',
      schemaVersion: pick(raw, 'schemaVersion', 'version') || null,
      generatedBy: pick(raw, 'generatedBy', 'source', 'app') || 'unknown',
      exportedAt: pick(raw, 'exportedAt', 'generatedAt', 'createdAt') || null
    },
    skipped: BACKUP_SECTIONS.reduce((sum, key) => sum + (data[key].length - normalized[key].length), 0)
  };
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

// Products coming from another app may carry different ids for the same
// product name. Map those onto the ids already in this workspace so the
// production and sales history keeps pointing at the right product.
function remapImportedProductIds(imported) {
  // groups first: a group with the same name keeps the id already in use here
  const groupsByName = new Map((state.groups || []).map((group) => [String(group.name).trim().toLowerCase(), group.id]));
  const groupMap = new Map();
  imported.groups.forEach((group) => {
    const existingId = groupsByName.get(String(group.name).trim().toLowerCase());
    if (existingId && existingId !== group.id) { groupMap.set(group.id, existingId); group.id = existingId; }
  });
  imported.products.forEach((product) => { if (groupMap.has(product.groupId)) product.groupId = groupMap.get(product.groupId); });

  const byName = new Map(state.products.map((product) => [String(product.name).trim().toLowerCase(), product.id]));
  const idMap = new Map();
  imported.products.forEach((product) => {
    const existingId = byName.get(String(product.name).trim().toLowerCase());
    if (existingId && existingId !== product.id) { idMap.set(product.id, existingId); product.id = existingId; }
  });
  if (!idMap.size) return imported;
  imported.production.forEach((record) => { if (idMap.has(record.productId)) record.productId = idMap.get(record.productId); });
  imported.sales.forEach((sale) => {
    sale.items.forEach((item) => { if (idMap.has(item.productId)) item.productId = idMap.get(item.productId); });
    sale.productId = sale.items[0]?.productId || sale.productId;
  });
  return imported;
}

function mergeSection(existing, incoming) {
  const merged = existing.slice();
  const index = new Map(merged.map((record, position) => [String(record.id), position]));
  incoming.forEach((record) => {
    const key = String(record.id);
    if (index.has(key)) merged[index.get(key)] = record;
    else { index.set(key, merged.length); merged.push(record); }
  });
  return merged;
}

async function applyRestore(imported, mode) {
  const next = mode === 'replace'
    ? { groups: imported.groups, products: imported.products, production: imported.production, sales: imported.sales, inventory: imported.inventory }
    : (() => {
      const ready = remapImportedProductIds(imported);
      return {
        groups: mergeSection(state.groups || [], ready.groups),
        products: mergeSection(state.products, ready.products),
        production: mergeSection(state.production, ready.production),
        sales: mergeSection(state.sales, ready.sales),
        inventory: mergeSection(state.inventory, ready.inventory)
      };
    })();
  const previous = state;
  state = next;
  try {
    const result = await Desktop.saveData(state);
    if (result && result.ok === false) throw new Error(result.error || 'save failed');
    render();
    const total = BACKUP_SECTIONS.reduce((sum, key) => sum + state[key].length, 0);
    notify(`Restore complete · ${total} records in workspace`);
  } catch (err) {
    state = previous;
    render();
    notify('Restore failed: ' + err.message);
  }
}

function openRestoreConfirm(parsed, fileName) {
  const counts = BACKUP_SECTIONS.map((key) => `<span><b>${parsed.data[key].length}</b> ${key}</span>`).join('');
  const exportedAt = parsed.meta.exportedAt ? new Date(parsed.meta.exportedAt).toLocaleString() : 'unknown date';
  $('#modalEyebrow').textContent = 'RESTORE BACKUP';
  $('#modalTitle').textContent = 'Confirm restore';
  $('#modalBody').innerHTML = `<form id="restoreForm">
    <div class="restore-summary">
      <div class="restore-file">${escapeHtml(fileName)} · created ${escapeHtml(exportedAt)} · source: ${escapeHtml(parsed.meta.generatedBy)}</div>
      <div class="restore-counts">${counts}</div>
      ${parsed.skipped ? `<p class="restore-warning">${parsed.skipped} record${parsed.skipped === 1 ? '' : 's'} were skipped because required fields were missing.</p>` : ''}
    </div>
    <div class="restore-mode">
      <label class="selected"><input type="radio" name="restoreMode" value="merge" checked><span><strong>Merge into this workspace</strong><small>Keeps current data. Records with the same id are updated, new ones are added, and products are matched by name.</small></span></label>
      <label><input type="radio" name="restoreMode" value="replace"><span><strong>Replace everything</strong><small>Deletes all current data in this account and loads only what is in the file.</small></span></label>
    </div>
    <div class="form-actions"><button type="button" class="outline-button" id="cancelModal">Cancel</button><button class="primary-button" type="submit">Restore data</button></div>
  </form>`;
  $('#modalBackdrop').classList.remove('hidden');
  const form = $('#restoreForm');
  form.addEventListener('change', () => {
    form.querySelectorAll('.restore-mode label').forEach((label) => label.classList.toggle('selected', Boolean(label.querySelector('input:checked'))));
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const mode = new FormData(form).get('restoreMode');
    if (mode === 'replace' && !confirm('Replace ALL current data in this account with the backup file? This cannot be undone.')) return;
    closeModal();
    await applyRestore(parsed.data, mode);
  });
}

function openBackupModal() {
  closeAccountMenu();
  const counts = BACKUP_SECTIONS.map((key) => `<span><b>${(state[key] || []).length}</b> ${key}</span>`).join('');
  $('#modalEyebrow').textContent = 'BACKUP & RESTORE';
  $('#modalTitle').textContent = 'Workspace data file';
  $('#modalBody').innerHTML = `<div>
    <div class="restore-summary"><div class="restore-counts">${counts}</div></div>
    <div class="backup-actions">
      <button type="button" class="backup-option" id="doBackupDownload"><span class="backup-icon">⬇</span><span><strong>Download backup (.json)</strong><small>Saves BOM, production, sales and inventory into one file.</small></span></button>
      <button type="button" class="backup-option" id="doRestorePick"><span class="backup-icon">⬆</span><span><strong>Restore from backup file</strong><small>Choose a .json file exported here or from the Windows software.</small></span></button>
    </div>
    <div class="backup-note">The same file works in both places. It uses the shared <code>${BACKUP_FORMAT}</code> format (schema v${BACKUP_SCHEMA_VERSION}), so a backup taken in the Windows software restores here, and a backup taken here restores in the Windows software.</div>
    <div class="form-actions"><button type="button" class="outline-button" id="cancelModal">Close</button></div>
  </div>`;
  $('#modalBackdrop').classList.remove('hidden');
  $('#doBackupDownload').addEventListener('click', async () => {
    closeModal();
    if (window.desktopAPI?.backup) {
      // Desktop: use the native backup dialog in the main process — exactly
      // one save window, direct file write, no blob/download races.
      try {
        const payload = buildBackupPayload();
        const result = await window.desktopAPI.backup(JSON.stringify(payload));
        if (result && result.cancelled) return;
        if (result && result.ok) {
          const total = Object.values(result.counts || {}).reduce((sum, value) => sum + value, 0);
          notify(`Backup saved · ${total} records · ${result.path}`);
        } else {
          notify('Backup failed: ' + ((result && result.error) || 'Unknown error'));
        }
      } catch (err) {
        notify('Backup failed: ' + err.message);
      }
      return;
    }
    downloadBackupFile();
  });
  $('#doRestorePick').addEventListener('click', () => $('#restoreFileInput').click());
}

$('#restoreFileInput')?.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  try {
    const parsed = parseBackupText(await file.text());
    closeModal();
    openRestoreConfirm(parsed, file.name);
  } catch (err) {
    console.error(err);
    notify('Could not read backup: ' + err.message);
  }
});

$('#backupData')?.addEventListener('click', openBackupModal);
$('#accountBackup')?.addEventListener('click', openBackupModal);
$('#sidebarBackup')?.addEventListener('click', openBackupModal);


/* =====================================================================
   SEARCHABLE PRODUCT PICKER (used in the "Record sale" form)
   A combobox: type to filter, results are grouped by BOM group, keyboard
   friendly. The chosen id lives in a hidden input named saleProductId so
   the existing form handling keeps working unchanged.
   ===================================================================== */
function groupForm(group) {
  const count = group ? productsInGroup(group.id).length : 0;
  return `<form><div class="form-grid"><div class="field full"><label for="groupName">Group name</label><input id="groupName" name="name" required value="${escapeHtml(group?.name || '')}" placeholder="e.g. Syrups, Majun, Oils"></div></div>
    <p class="optional-hint">${group ? `${count} product${count === 1 ? ' is' : 's are'} in this group. Renaming keeps every product where it is.` : 'Groups keep the BOM tidy. Each group gets its own search box, and the search at the top searches across all groups.'}</p>
    <div class="form-actions"><button type="button" class="outline-button" id="cancelModal">Cancel</button><button class="primary-button" type="submit">${group ? 'Save name' : 'Create group'}</button></div></form>`;
}

function comboDisplayLabel(item, isCustom) {
  if (isCustom) return 'Product not in BOM';
  return item?.productId ? productName(item.productId) : '';
}

function saleProductCombo(item, isCustom) {
  const value = isCustom ? '__custom__' : (item?.productId || '');
  const label = comboDisplayLabel(item, isCustom);
  return `<div class="combo" data-combo>
    <input type="hidden" name="saleProductId" value="${escapeHtml(value)}">
    <span class="combo-icon" aria-hidden="true">⌕</span>
    <input type="text" class="combo-input" data-combo-input role="combobox" aria-expanded="false" aria-autocomplete="list" autocomplete="off" placeholder="Search a product…" value="${escapeHtml(label)}">
    <button type="button" class="combo-clear" data-combo-clear aria-label="Clear product">×</button>
    <div class="combo-list hidden" data-combo-list role="listbox"></div>
  </div>`;
}

function comboOptionsHtml(query) {
  const text = String(query || '').trim().toLowerCase();
  const sections = [...groupList().map((group) => ({ name: group.name, items: productsInGroup(group.id) })), { name: 'Ungrouped', items: productsInGroup('') }];
  let html = '';
  let count = 0;
  sections.forEach((section) => {
    const groupHit = section.name.toLowerCase().includes(text);
    const items = section.items.filter((product) => !text || groupHit || product.name.toLowerCase().includes(text));
    if (!items.length) return;
    count += items.length;
    html += `<div class="combo-group">${escapeHtml(section.name)}</div>`;
    html += items.map((product) => `<button type="button" class="combo-option" role="option" data-combo-value="${product.id}" data-combo-label="${escapeHtml(product.name)}">${escapeHtml(product.name)}</button>`).join('');
  });
  if (!count) html += `<div class="combo-empty">No BOM product matches${text ? ` “${escapeHtml(query.trim())}”` : ''}.</div>`;
  html += `<button type="button" class="combo-option combo-option-custom" role="option" data-combo-value="__custom__" data-combo-label="Product not in BOM">+ Product not in BOM</button>`;
  return html;
}

function openCombo(combo, query = '') {
  const list = combo.querySelector('[data-combo-list]');
  list.innerHTML = comboOptionsHtml(query);
  list.classList.remove('hidden');
  combo.classList.add('open');
  combo.querySelector('[data-combo-input]').setAttribute('aria-expanded', 'true');
  const selected = combo.querySelector('input[type="hidden"]').value;
  const current = Array.from(list.querySelectorAll('.combo-option')).find((option) => option.dataset.comboValue === selected);
  (current || list.querySelector('.combo-option'))?.classList.add('active');
  current?.scrollIntoView({ block: 'nearest' });
}

function closeCombo(combo, restoreLabel = true) {
  if (!combo) return;
  const list = combo.querySelector('[data-combo-list]');
  list?.classList.add('hidden');
  combo.classList.remove('open');
  const input = combo.querySelector('[data-combo-input]');
  input?.setAttribute('aria-expanded', 'false');
  if (restoreLabel && input) {
    const value = combo.querySelector('input[type="hidden"]').value;
    input.value = value === '__custom__' ? 'Product not in BOM' : (value ? productName(value) : '');
  }
}

function closeAllCombos(except = null) {
  document.querySelectorAll('.combo.open').forEach((combo) => { if (combo !== except) closeCombo(combo); });
}

function selectComboOption(combo, value, label) {
  combo.querySelector('input[type="hidden"]').value = value;
  const input = combo.querySelector('[data-combo-input]');
  input.value = label;
  closeCombo(combo, false);
  // Let the existing sale-form logic show/hide the "new product name" field.
  combo.querySelector('input[type="hidden"]').dispatchEvent(new Event('change', { bubbles: true }));
  const row = combo.closest('.sale-item-row');
  const quantity = row?.querySelector('input[name="saleDozen"]');
  if (value !== '__custom__' && quantity && !quantity.value) quantity.focus();
  if (value === '__custom__') row?.querySelector('.sale-custom-name')?.focus();
}

document.addEventListener('focusin', (event) => {
  const input = event.target.closest('[data-combo-input]');
  closeAllCombos(input ? input.closest('.combo') : null);
  if (input) { openCombo(input.closest('.combo'), ''); input.select(); }
});

document.addEventListener('input', (event) => {
  const input = event.target.closest('[data-combo-input]');
  if (!input) return;
  openCombo(input.closest('.combo'), input.value);
});

document.addEventListener('mousedown', (event) => {
  // Keeps focus in the field so the list is not closed before the click lands.
  if (event.target.closest('[data-combo-list]')) event.preventDefault();
  else if (!event.target.closest('.combo')) closeAllCombos();
});

document.addEventListener('click', (event) => {
  const clear = event.target.closest('[data-combo-clear]');
  if (clear) {
    const combo = clear.closest('.combo');
    combo.querySelector('input[type="hidden"]').value = '';
    const input = combo.querySelector('[data-combo-input]');
    input.value = '';
    combo.querySelector('input[type="hidden"]').dispatchEvent(new Event('change', { bubbles: true }));
    openCombo(combo, '');
    input.focus();
    return;
  }
  const option = event.target.closest('[data-combo-value]');
  if (option) selectComboOption(option.closest('.combo'), option.dataset.comboValue, option.dataset.comboLabel);
});

document.addEventListener('keydown', (event) => {
  const input = event.target.closest('[data-combo-input]');
  if (!input) return;
  const combo = input.closest('.combo');
  const list = combo.querySelector('[data-combo-list]');
  const options = Array.from(list.querySelectorAll('.combo-option'));
  const activeIndex = options.findIndex((option) => option.classList.contains('active'));
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (!combo.classList.contains('open')) { openCombo(combo, input.value); return; }
    const next = event.key === 'ArrowDown' ? Math.min(activeIndex + 1, options.length - 1) : Math.max(activeIndex - 1, 0);
    options.forEach((option) => option.classList.remove('active'));
    options[next]?.classList.add('active');
    options[next]?.scrollIntoView({ block: 'nearest' });
  } else if (event.key === 'Enter') {
    if (combo.classList.contains('open') && options[activeIndex]) {
      event.preventDefault();
      selectComboOption(combo, options[activeIndex].dataset.comboValue, options[activeIndex].dataset.comboLabel);
    }
  } else if (event.key === 'Escape') {
    if (combo.classList.contains('open')) { event.preventDefault(); event.stopPropagation(); closeCombo(combo); }
  }
}, true);


/* =====================================================================
   BOM GROUP ACTIONS  (create / rename / delete / collapse / per-group search)
   ===================================================================== */
document.addEventListener('click', (event) => {
  if (event.target.closest('[data-action="add-group"]')) { openModal('group'); return; }
  const rename = event.target.closest('[data-rename-group]');
  if (rename) { openModal('group', rename.dataset.renameGroup); return; }
  const remove = event.target.closest('[data-delete-group]');
  if (remove) {
    const group = groupById(remove.dataset.deleteGroup);
    const count = productsInGroup(remove.dataset.deleteGroup).length;
    if (group && confirm(`Delete the group “${group.name}”?${count ? ` Its ${count} product${count === 1 ? '' : 's'} will stay in the BOM and move to Ungrouped.` : ''}`)) {
      state.groups = (state.groups || []).filter((item) => item.id !== group.id);
      state.products = state.products.map((product) => product.groupId === group.id ? { ...product, groupId: '' } : product);
      saveState(); render(); notify('Group deleted');
    }
    return;
  }
  const toggle = event.target.closest('[data-group-toggle]');
  if (toggle) {
    const key = toggle.dataset.groupToggle;
    collapsedBomGroups[key] = !collapsedBomGroups[key];
    render();
  }
});

document.addEventListener('input', (event) => {
  const groupSearch = event.target.closest('[data-group-search]');
  if (!groupSearch) return;
  const key = groupSearch.dataset.groupSearch;
  bomGroupSearch[key] = groupSearch.value;
  render();
  requestAnimationFrame(() => {
    const field = document.querySelector(`[data-group-search="${CSS.escape(key)}"]`);
    if (field) { field.focus(); field.setSelectionRange(field.value.length, field.value.length); }
  });
});

// "+ Create new group…" inside the product form
document.addEventListener('change', (event) => {
  if (event.target.name !== 'groupId') return;
  const field = $('#newGroupField');
  const input = $('#newGroupName');
  const creating = event.target.value === '__new__';
  field?.classList.toggle('hidden', !creating);
  if (input) { input.required = creating; if (creating) input.focus(); else input.value = ''; }
});
