// test-renderer.js — boots the real index.html + app.js in jsdom (no Electron)
// Verifies: no JS errors, dashboard renders, views switch, data persists to storage.
'use strict';
const path = require('path');
const fs = require('fs');
const { JSDOM, VirtualConsole, requestInterceptor } = require('jsdom');

const appDir = path.join(__dirname, '..', 'app');

function mimeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.js') return 'application/javascript';
  if (ext === '.css') return 'text/css';
  if (ext === '.png') return 'image/png';
  if (ext === '.woff2') return 'font/woff2';
  if (ext === '.pdf') return 'application/pdf';
  return 'text/plain';
}

const localInterceptor = requestInterceptor(async (request) => {
  if (!request.url.startsWith('http://localhost/')) return undefined; // pass through
  const filePath = request.url.replace('http://localhost/', '');
  const resolved = path.join(appDir, decodeURIComponent(filePath.split('?')[0]));
  return new Response(fs.readFileSync(resolved), { headers: { 'Content-Type': mimeFor(resolved) } });
});

const errors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (err) => errors.push('jsdomError: ' + err.message));
virtualConsole.on('error', (...args) => errors.push('console.error: ' + args.join(' ')));

(async () => {
  const dom = await JSDOM.fromFile(path.join(appDir, 'index.html'), {
    runScripts: 'dangerously',
    resources: { interceptors: [localInterceptor] },
    pretendToBeVisual: true,
    virtualConsole,
    url: 'http://localhost/index.html'
  });

  const { window } = dom;
  const { document } = window;

  await new Promise((resolve) => setTimeout(resolve, 2500));

  const checks = [];
  const check = (name, ok) => checks.push(`${ok ? 'PASS' : 'FAIL'}  ${name}`);

  check('app shell visible (no login screen)', !document.querySelector('#authScreen'));
  check('dashboard view rendered', (document.querySelector('#appView')?.innerHTML || '').includes('panel'));
  check('topbar title present', document.querySelector('#viewTitle')?.textContent.includes('operator'));

  const navButtons = document.querySelectorAll('.nav-item');
  for (const btn of navButtons) {
    btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  }
  check('all 6 views render', document.querySelectorAll('.nav-item.active').length === 1 &&
    ['dashboard', 'bom', 'production', 'sales', 'inventory', 'raw'].every((v) => {
      document.querySelector(`[data-view="${v}"]`).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      return (document.querySelector('#appView')?.innerHTML || '').length > 50;
    }));

  document.querySelector('#exportExcel').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('export dialog opens', !document.querySelector('#modalBackdrop')?.classList.contains('hidden'));
  document.querySelector('#closeModal').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  // Add a product through the UI and verify it persists to localStorage
  document.querySelector('[data-view="bom"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  document.querySelector('#quickAction').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const form = document.querySelector('#modalBody form');
  if (form) {
    form.querySelector('[name="name"]').value = 'Test Sharbat';
    document.querySelector('#addMaterial')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    const matRow = form.querySelector('.material-row');
    if (matRow) {
      matRow.querySelector('[name="materialName"]').value = 'Sugar';
      matRow.querySelector('[name="materialQty"]').value = '2';
    } else {
      check('add material row button works', false);
    }
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 700));
    const after = JSON.parse(window.localStorage.getItem('maaz-local-data'));
    check('product added through UI', after && after.products.some((p) => p.name === 'Test Sharbat'));
    check('product visible in BOM view', document.querySelector('#appView')?.textContent.includes('Test Sharbat'));
  } else {
    check('product modal opens', false);
  }

  check('backup button present', !!document.querySelector('#backupData'));
  check('restore button present', !!document.querySelector('#restoreData'));
  check('data location button present', !!document.querySelector('#dataLocation'));
  check('custom window controls present', !!document.querySelector('#winMin') && !!document.querySelector('#winMax') && !!document.querySelector('#winClose'));

  // Maximize state must flip the CSS class (rounded corners <-> square).
  window.setMaximizedIcon(true);
  check('window-maximized class applied', window.document.documentElement.classList.contains('window-maximized'));
  window.setMaximizedIcon(false);
  check('window-maximized class cleared', !window.document.documentElement.classList.contains('window-maximized'));
  check('theme toggle buttons present', document.querySelectorAll('[data-theme-toggle]').length >= 2);

  // Dark mode sets data-theme on <html> and persists (v1.0.4 uses the same
  // token scheme as the website instead of a class)
  document.querySelector('[data-theme-toggle]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('dark mode applies', window.document.documentElement.getAttribute('data-theme') === 'dark');
  check('dark mode persists', window.localStorage.getItem('md-theme') === 'dark');
  document.querySelector('[data-theme-toggle]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('dark mode toggles back', window.document.documentElement.getAttribute('data-theme') === 'light');

  // ---- v1.0.4: BOM groups ----
  // Product form has a Group dropdown with "+ Create new group…"
  document.querySelector('[data-view="bom"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  document.querySelector('#quickAction').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const productForm = document.querySelector('#modalBody form');
  check('product form has group dropdown', !!(productForm && productForm.querySelector('[name="groupId"]')));
  check('create-new-group option present', !!(productForm && productForm.querySelector('[name="groupId"] option[value="__new__"]')));
  document.querySelector('#closeModal')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  // Create a group through the UI and verify it persists + renders
  await (async () => {
    const btn = [...document.querySelectorAll('[data-action]')].find((b) => b.dataset.action === 'add-group');
    if (!btn) { check('add-group button present', false); return; }
    btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    const gform = document.querySelector('#modalBody form');
    if (!gform) { check('group modal opens', false); return; }
    check('group modal opens', true);
    gform.querySelector('[name="name"]').value = 'Test Group';
    gform.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 700));
    const after = JSON.parse(window.localStorage.getItem('maaz-local-data'));
    check('group saved to storage', !!(after && after.groups && after.groups.some((g) => g.name === 'Test Group')));
    check('group visible in BOM view', document.querySelector('#appView')?.textContent.includes('Test Group'));
  })();

  // ---- v1.0.4: searchable product combobox in sales ----
  document.querySelector('[data-view="sales"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  document.querySelector('#quickAction').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const saleForm = document.querySelector('#modalBody form');
  check('sale form uses searchable combo', !!(saleForm && saleForm.querySelector('.combo-input') && saleForm.querySelector('input[name="saleProductId"][type="hidden"]')));
  if (saleForm && saleForm.querySelector('.combo-input')) {
    saleForm.querySelector('.combo-input').value = 'sharbat';
    saleForm.querySelector('.combo-input').dispatchEvent(new window.Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    check('combo list opens on typing', !!document.querySelector('.combo-list'));
  }
  document.querySelector('#closeModal')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  // ---- v1.0.4.1: PDF preview — view-first, saving/printing optional ----
  // Stub the desktop bridge: the invoice must OPEN in a preview modal without
  // forcing a save dialog, and the Save/Print buttons must be present.
  window.desktopAPI = {
    savePdf: async () => ({ ok: true }),
    printPdf: async () => ({ ok: true })
  };
  // jsdom has no fetch; printInvoice fetches template.pdf from the app folder.
  window.fetch = async (url) => {
    const name = String(url).replace(/^.*\//, '');
    const buf = fs.readFileSync(path.join(appDir, name));
    // Build the ArrayBuffer in the page realm so pdf-lib's strict
    // constructor checks (t === ArrayBuffer) pass.
    const ab = new window.ArrayBuffer(buf.byteLength);
    new window.Uint8Array(ab).set(buf);
    return { ok: true, arrayBuffer: async () => ab };
  };
  await window.eval(`(async () => {
    state.sales.push({ id: 'pdf-test-sale', date: '2026-08-22', customer: 'PDF Test Shop', items: [{ productId: 'external:test', dozen: 2, customName: 'Test Item' }], productId: 'external:test', dozen: 2 });
    await printInvoice('pdf-test-sale');
    return true;
  })()`);
  check('pdf preview modal opens (no forced save dialog)', !!document.querySelector('.pdf-preview') && !document.querySelector('#modalBackdrop').classList.contains('hidden'));
  check('pdf preview has optional Save button', !!document.querySelector('#pdfSave'));
  check('pdf preview has optional Print button', !!document.querySelector('#pdfPrint'));
  document.querySelector('#pdfSave')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  document.querySelector('#cancelModal')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('pdf preview closes', document.querySelector('#modalBackdrop').classList.contains('hidden'));

  check('no jsdom errors', errors.length === 0);
  if (errors.length) console.log('ERRORS:\n' + errors.join('\n'));

  console.log(checks.join('\n'));
  const failed = checks.filter((c) => c.startsWith('FAIL'));
  console.log(failed.length ? `\n${failed.length} FAILURES` : '\nALL RENDERER TESTS PASSED');
  process.exit(failed.length ? 1 : 0);
})().catch((err) => { console.error('TEST CRASHED:', err.stack || err); process.exit(1); });
