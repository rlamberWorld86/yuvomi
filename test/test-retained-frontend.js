import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';
import test from 'node:test';
import { WIDGET_IDS, normalizeDashboardConfig } from '../public/utils/dashboard-widgets.js';
import { BUILT_IN_MODULES } from '../public/settings/module-order.js';
import { SEARCH_SECTIONS, NEW_ACTIONS } from '../public/utils/search-sections.js';
register('./test-browser-loader.mjs', import.meta.url);
const { SETTINGS_LEAVES, SETTINGS_SECTIONS } = await import('../public/settings/registry.js');
const { __test: dashboard, render: renderDashboard } = await import('../public/pages/dashboard.js');
const { TODAY_SHEET_SOURCES } = await import('../public/utils/today-sheet.js');
const retired = new Set(['rewards', 'schedule', 'inventory', 'housekeeping', 'waste', 'health', 'budget', 'kitchen', 'meals', 'recipes', 'shopping', 'pantry']);

test('saved dashboard layouts discard retired widgets and preserve retained preferences', () => {
  const config = normalizeDashboardConfig([
    { id: 'tasks', visible: true, size: '2x1', order: 0 },
    { id: 'budget', visible: true, size: '2x2', order: 1 },
    { id: 'weather', visible: true, size: '2x2', order: 2 },
    { id: 'custom:widget', visible: true, size: '2x2', order: 3 },
  ]);
  assert.deepEqual(config.map((w) => w.id).sort(), [...WIDGET_IDS].sort());
  assert.equal(config.find((w) => w.id === 'tasks').visible, true);
  assert.equal(config.find((w) => w.id === 'tasks').size, '2x1');
});

test('navigation, search and today-sheet catalogs retain only installed core modules', () => {
  for (const entry of [...BUILT_IN_MODULES, ...SEARCH_SECTIONS, ...NEW_ACTIONS, ...TODAY_SHEET_SOURCES]) {
    assert.ok(!retired.has(entry.module ?? entry.id), JSON.stringify(entry));
  }
  for (const id of ['documents', 'contacts', 'notes', 'tasks', 'calendar']) {
    assert.ok(BUILT_IN_MODULES.some((entry) => entry.id === id));
  }
});

test('settings registry has no orphan sections or retired integrations', () => {
  assert.ok(!SETTINGS_SECTIONS.some((section) => section.id === 'documents-dms'));
  const ids = new Set(SETTINGS_LEAVES.map((leaf) => leaf.id));
  for (const section of SETTINGS_SECTIONS) assert.ok(ids.has(section.sheetId), section.id);
  for (const leaf of SETTINGS_LEAVES) {
    assert.ok(!retired.has(leaf.module), leaf.id);
    assert.ok(!['/admin/api', '/admin/backup', '/admin/email', '/admin/displays', '/admin/integrations', '/personal/weather', '/personal/appearance', '/modules/install'].some((suffix) => leaf.path.endsWith(suffix)), leaf.path);
  }
});

test('retained dashboard renders tasks and omits retired wall/weather controls', () => {
  globalThis.window = { yuvomi: { isModuleDisabled: () => false } };
  const html = dashboard.renderDashboardLayout([{ id: 'tasks', visible: true, size: '1x2' }], {}, null, 'EUR');
  assert.match(html, /data-widget-id="tasks"/);
  const overview = dashboard.renderDashboardOverview({ display_name: 'Test' });
  assert.doesNotMatch(overview, /dashboard-wall-enter|weather-widget/);
  delete globalThis.window;
});

test('every retained static frontend import and precached resource exists', () => {
  const root = new URL('../public/', import.meta.url);
  for (const file of readdirSync(root, { recursive: true }).filter((name) => name.endsWith('.js'))) {
    const source = readFileSync(new URL(file.replaceAll('\\', '/'), root), 'utf8');
    for (const match of source.matchAll(/(?:from\s+|import\s*\()['"]([/][^'"]+\.js)['"]/g)) {
      assert.ok(existsSync(new URL(match[1].slice(1), root)), file + ': ' + match[1]);
    }
  }
  const worker = readFileSync(new URL('sw.js', root), 'utf8');
  for (const match of worker.matchAll(/['"]([/][^'"]+\.(?:js|css))['"]/g)) {
    assert.ok(existsSync(new URL(match[1].slice(1), root)), match[1]);
  }
});


test('dashboard lifecycle loads, refreshes and aborts without retired feature hooks', async () => {
  const globals = ['window', 'document', 'localStorage', 'sessionStorage', '__apiStub', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver'];
  const previous = new Map(globals.map((key) => [key, globalThis[key]]));
  const timers = new Map();
  let nextTimer = 1;
  const requests = [];
  class Element extends EventTarget {
    constructor() {
      super();
      this.html = '';
      this.rebuilds = 0;
      this.dataset = {};
      this.style = { setProperty() {}, removeProperty() {} };
      this.classList = { contains: () => false, add() {}, remove() {}, toggle() {} };
      this.children = [];
    }
    replaceChildren() { this.html = ''; this.rebuilds++; }
    insertAdjacentHTML(_position, html) { this.html += html; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    closest() { return null; }
    contains() { return false; }
    setAttribute() {}
    getAttribute() { return null; }
    append() {}
    appendChild() {}
    remove() {}
    get outerHTML() { return '<div>' + this.html + '</div>'; }
  }
  const shell = new Element();
  const container = new Element();
  container.querySelector = (selector) => selector === '#dashboard-shell' ? shell : null;
  const doc = new Element();
  doc.createElement = () => new Element();
  doc.createTextNode = (text) => ({ textContent: text });
  doc.documentElement = new Element();
  doc.documentElement.lang = 'de';
  doc.body = new Element();
  doc.activeElement = doc.body;
  doc.getElementById = () => null;
  doc.hidden = false;
  const win = new Element();
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  win.yuvomi = { isModuleDisabled: () => false };
  const storage = { getItem: () => null, setItem() {}, removeItem() {} };
  const schedule = (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id; };
  const clear = (id) => timers.delete(id);
  win.requestAnimationFrame = (fn) => schedule(fn, 0);
  win.cancelAnimationFrame = clear;
  const route = new AbortController();
  dashboard.setOverviewMemo(null);
  try {
    Object.assign(globalThis, { window: win, document: doc, localStorage: storage, sessionStorage: storage,
      setInterval: schedule, clearInterval: clear, setTimeout: schedule, clearTimeout: clear,
      requestAnimationFrame: (fn) => schedule(fn, 0), cancelAnimationFrame: clear,
      ResizeObserver: class { observe() {} disconnect() {} unobserve() {} },
      __apiStub: { get: async (url) => {
        requests.push(url);
        if (url.startsWith('/preferences')) return { data: { dashboard_widgets: WIDGET_IDS.map((id, order) => ({ id, order, visible: id === 'tasks', size: '1x2' })) } };
        if (url.startsWith('/dashboard')) return { upcomingEvents: [], urgentTasks: [], todayMeals: [], pinnedNotes: [], users: [], countdowns: [], birthdays: [], openTaskCount: requests.length };
        if (url.startsWith('/reminders/pending')) return { data: [] };
        throw new Error('Unexpected lifecycle request: ' + url);
      } },
    });
    await renderDashboard(container, { user: { id: 42, display_name: 'Lifecycle', role: 'member' }, signal: route.signal });
    assert.match(shell.html, /dashboard-masthead/);
    assert.match(shell.html, /data-widget-id="tasks"/);
    assert.doesNotMatch(shell.html, /dashboard-retry/);
    const firstRebuilds = shell.rebuilds;
    const loaded = requests.filter((url) => url.startsWith('/dashboard')).length;
    const refresh = [...timers.values()].find((timer) => timer.ms === 15 * 60 * 1000);
    assert.ok(refresh, 'loaded page registers its refresh lifecycle');
    refresh.fn();
    for (let i = 0; i < 12; i++) await Promise.resolve();
    assert.ok(requests.filter((url) => url.startsWith('/dashboard')).length > loaded);
    assert.match(shell.html, /dashboard-masthead/);
    assert.ok(shell.rebuilds > firstRebuilds, 'successful refresh rebuilds the rendered shell');
    route.abort();
    assert.ok(![...timers.values()].some((timer) => timer.ms === 15 * 60 * 1000), 'route abort clears refresh timer');
    assert.ok(![...timers.values()].some((timer) => timer.ms > 1000 && timer.ms <= 60000), 'route abort clears clock timer');
    assert.ok(requests.every((url) => /^\/(dashboard|preferences|reminders\/pending)/.test(url)), requests.join(', '));
  } finally {
    route.abort();
    dashboard.setOverviewMemo(null);
    for (const [key, value] of previous) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});
