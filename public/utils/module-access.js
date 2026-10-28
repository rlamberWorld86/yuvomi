

import { moduleAccess } from '/permissions.js';

/**
 * Kopie von `SCOPE_MODULES` aus server/scopes.js - Reihenfolge und Inhalt
 * gleich, der Drift-Guard vergleicht Eintrag fuer Eintrag. Aendern heisst:
 * dort aendern, hier nachziehen.
 */
export const SCOPE_MODULES = Object.freeze([
  { key: 'tasks',        prefixes: ['tasks'] },

  { key: 'inventory',    prefixes: ['inventory'] },
  { key: 'calendar',     prefixes: ['calendar', 'reminders', 'birthdays'] },
  { key: 'notes',        prefixes: ['notes'] },
  { key: 'contacts',     prefixes: ['contacts'] },
  { key: 'schedule',     prefixes: ['schedule'] },
  { key: 'budget',       prefixes: ['budget', 'split-expenses'] },
  { key: 'documents',    prefixes: ['documents'] },
  { key: 'health',       prefixes: ['health'] },
  { key: 'rewards',      prefixes: ['rewards'] },
  { key: 'housekeeping', prefixes: ['housekeeping'] },
  { key: 'waste',        prefixes: ['waste'] },
  { key: 'weather',      prefixes: ['weather'] },
  { key: 'family',       prefixes: ['family'] },
  { key: 'dashboard',    prefixes: ['dashboard', 'quick-links'] },
  { key: 'search',       prefixes: ['search'] },
].map((mod) => Object.freeze({ key: mod.key, prefixes: Object.freeze(mod.prefixes) })));

const PREFIX_TO_MODULE = new Map(
  SCOPE_MODULES.flatMap((mod) => mod.prefixes.map((prefix) => [prefix, mod.key])),
);

/** Den Pfad so zuschneiden, wie ihn der Server als `req.path` sieht: ohne Query und Anker. */
function requestPath(path) {
  return String(path ?? '').split(/[?#]/, 1)[0];
}

/**
 * Das Scope-Modul eines API-Pfads - dieselbe Regel wie `moduleForPath()` in
 * server/scopes.js: Schreibweise gefaltet (Express routet ohne sie), erst ein
 * zweiteiliger Praefix, dann das erste Segment. Erweiterungen
 * (`/extensions/<id>`) meldet der Server erst zur Laufzeit an; hier bleiben sie
 * `null` und damit ungesperrt - ihre Seiten fragen ueber `permissionModuleKey`.
 * @param {string} path z. B. "/reminders?entity_type=task"
 * @returns {string|null}
 */
export function moduleForApiPath(path) {
  const parts = requestPath(path).replace(/^\/+/, '').toLowerCase().split('/').filter(Boolean);
  if (parts.length >= 2) {
    const compound = PREFIX_TO_MODULE.get(`${parts[0]}/${parts[1]}`);
    if (compound) return compound;
  }
  return PREFIX_TO_MODULE.get(parts[0]) || null;
}

/**
 * Die Zugriffsstufe fuer das Modul hinter einem Pfad: 'none' | 'read' | 'write'.
 * Ohne Modul - oder fuer ein Modul ohne Rechte-Eintrag - ist sie `write`,
 * genau wie am Server (siehe Kopf).
 * @param {string} path
 * @returns {'none'|'read'|'write'}
 */
export function pathAccess(path) {
  const key = moduleForApiPath(path);
  return key ? moduleAccess(key) : 'write';
}

/**
 * Kopie von `READ_LEVEL_WRITES` aus server/scopes.js - die benannten
 * Ausnahmen, fuer die der Server bei einem schreibenden Aufruf `read` reicht
 * (Regel 5 und Regel 8 im Kopf). Der Drift-Guard in
 * `npm run test:module-write-access` vergleicht Eintrag fuer Eintrag. Aendern
 * heisst: dort aendern, hier nachziehen - eine Seite baut sich keine eigene.
 */
export const READ_LEVEL_WRITES = Object.freeze([
  Object.freeze({
    id: 'schedule-preferences',
    pattern: '^\\/schedule\\/preferences$',
    flags: '',
    methods: null,
    axes: Object.freeze(['session']),
  }),

]);

// Die Oberflaeche ist eine Sitzung: sie liest nur die Eintraege dieser Achse.
// Die Methode kennt der Helfer nicht - `mayWritePath()` fragt immer nach einem
// Schreibaufruf, und unter den Pfaden der Tabelle gibt es jeweils nur die
// Methoden, die sie nennt.
const SESSION_READ_LEVEL = READ_LEVEL_WRITES
  .filter((entry) => entry.axes.includes('session'))
  .map((entry) => new RegExp(entry.pattern, entry.flags));

/**
 * Wuerde der Server einen SCHREIBENDEN Aufruf auf diesen Pfad annehmen?
 * Fuer die Pfade aus `READ_LEVEL_WRITES` reicht `read` (nie `none`).
 * @param {string} path
 * @returns {boolean}
 */
export function mayWritePath(path) {
  const access = pathAccess(path);
  const p = requestPath(path);
  if (SESSION_READ_LEVEL.some((re) => re.test(p))) return access !== 'none';
  return access === 'write';
}
