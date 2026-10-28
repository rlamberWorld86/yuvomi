import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('fork branding covers app defaults and static shell without renaming storage identity', () => {
  for (const path of ['server/index.js', 'server/routes/preferences.js', 'public/router.js', 'public/utils/auth-ui.js', 'public/pages/login.js', 'public/pages/setup.js', 'public/settings/pages/admin-system.js']) {
    assert.ok(read(path).includes("const DEFAULT_APP_NAME = 'Lamber Cockpit';"), path);
  }
  const manifest = JSON.parse(read('public/manifest.json'));
  assert.equal(manifest.short_name, 'Lamber Cockpit');
  assert.ok(manifest.name.startsWith('Lamber Cockpit'));
  assert.ok(read('public/index.html').includes('<title>Lamber Cockpit</title>'));
  assert.ok(read('public/utils/auth-ui.js').includes("'yuvomi-app-name'"));
  assert.equal(JSON.parse(read('package.json')).name, 'yuvomi');
});

test('locale display text uses fork branding while retaining the Drive folder contract', () => {
  const files = readdirSync(new URL('../public/locales/', import.meta.url)).filter((file) => file.endsWith('.json'));
  for (const file of files) {
    const source = read('public/locales/' + file);
    JSON.parse(source);
    assert.doesNotMatch(source, /Yuvomi(?!\/Documents)/, file);
    assert.ok(source.includes('Yuvomi/Documents'), file + ': Drive folder preserved');
  }
});
