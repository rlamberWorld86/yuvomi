// --------------------------------------------------------
// Ausgehende Änderungen für CalDAV-VTODO (Issue #617).
//
// Der VTODO-Spiegel (caldav-reminders-sync.js) war einseitig: eine hier
// abgehakte, umbenannte oder gelöschte Aufgabe blieb auf dem Server stehen, und
// der nächste Inbound-Lauf machte die lokale Änderung wieder rückgängig. Diese
// Datei ist die Rückrichtung, nach demselben Muster wie die Termine (#593):
//
//   Löschen → Zeile in caldav_todo_pending_deletions (überlebt den Eintrag)
//   Ändern  → outbound_dirty auf der Zeile selbst
//
// Vorgemerkt wird synchron im Route-Handler, ausgeführt wird danach: der
// Server-Aufruf darf die HTTP-Antwort weder verzögern noch scheitern lassen. Was
// nicht durchgeht, bleibt vorgemerkt und läuft im nächsten Sync mit
// (at-least-once).
//
// Ein Umzug zwischen Listen fehlt für AUFGABEN weiterhin bewusst: eine Aufgabe
// gehört zu der Liste, aus der sie kam. Ein Einkaufsartikel kann seit #1700 die
// Liste wechseln, und sein Objekt auf dem Server zieht MIT ("Mitnahme",

//

//
// Die Zeile steht sofort auf der neuen Liste und zeigt weiter auf ihr Objekt
// am alten Platz. Der Durchgang liest das Original dort, legt es unverändert
// am neuen Platz ab (nur eine hier wartende Bearbeitung ist eingearbeitet),
// bucht die Zeile um und entfernt es ERST DANN am alten Platz. Was zwischen
// diesen Schritten abbricht, führt ein späterer Durchgang zu Ende; an keiner
// Stelle liegt das Objekt an keinem der beiden Plätze. Ist die Zielliste nicht

//
// Das Anlegen dagegen gibt es seit #695. Die alte Begründung ("ohne Zielwahl
// gäbe es keine Liste, in die es gehörte") stimmte nicht mehr: die Zielwahl gibt
// es seit v1.79.0 bei den Terminen (#620), und die Oberfläche versprach die
// Rückrichtung die ganze Zeit über in beide Richtungen. Eine in Yuvomi angelegte
// Aufgabe trägt jetzt ihr Ziel selbst (tasks.target_caldav_account_id +
// target_caldav_list_url, Migration 136) und wird beim nächsten Lauf hochgeladen:
//
//   Anlegen → Zielspalten auf der Zeile, external_source bleibt 'local'
//   Ändern  → outbound_dirty auf der Zeile selbst
//   Löschen → Zeile in caldav_todo_pending_deletions (überlebt den Eintrag)
//
// Nach erfolgreichem Upload ist die Zeile ein gewöhnlicher Spiegel und läuft ab
// da über dieselben Pfade wie eine vom Server geholte Aufgabe.
// --------------------------------------------------------

import { createLogger } from '../logger.js';
import * as db from '../db.js';
import { davFailureAction, createRefusalStop, MAX_OUTBOUND_ATTEMPTS } from './calendar-outbound.js';
import { patchICSTodo } from '../utils/ics-patch.js';
import {
  createCalDAVClient, collectionUrlOf, createUploadGate, sameObjectAddress, withAccountOrigin, isOriginRefusal,
  isAccountWideRefusal,
} from '../utils/caldav-client.js';
import {
  ownUid, isOwnUidOfRow, ownUploadRowId, parseOwnUid, findObjectWithUid, inspectObjectAt,
} from '../utils/own-uid.js';
import {
  noteUploadAttempt, settleUploadAttempt, uploadAttemptsAt,
  hasUploadAttempt, removeLeftoverUploads,
} from './caldav-upload-attempts.js';
import { householdTimeZone, localToUTC } from '../utils/timezone.js';
import { loadTags, tagsKey } from '../utils/task-tags.js';
import { runSerialized } from '../utils/sync-lock.js';


const log = createLogger('CalDAV-Todo-Outbound');

/**
 * Client eines Kontos für den VTODO-Weg: gezielte Anfragen (PUT, DELETE,
 * Objektabruf) nur an den Server dieses Kontos - `caldav_url` und die Listen
 * und Kalender seiner Auswahl -, wie bei den Terminen seit #1860
 * (`withAccountOrigin`).
 *
 * Die Objekt-Adresse einer gespiegelten Zeile stammt aus der href der
 * Server-Antwort, und tsdav übernimmt eine absolute href so, wie sie dasteht.
 * Lauf, Sofortversuch und die Quelle einer Mitnahme bauen ihre Clients deshalb
 * alle hier.
 *
 * @param {object}   account     Zeile aus `caldav_accounts`
 * @param {Function} makeClient  Factory (`createCalDAVClient` oder Test-Factory)
 */
export async function createTodoClient(account, makeClient = createCalDAVClient) {
  const selected = db.get().prepare(`
    SELECT list_url AS url FROM caldav_reminder_selection WHERE account_id = ?
    UNION SELECT calendar_url FROM caldav_calendar_selection WHERE account_id = ?
  `).all(account.id, account.id).map((r) => r.url);
  return withAccountOrigin(await makeClient(account), [account.caldav_url, ...selected]);
}

// --------------------------------------------------------
// Module
//
// Der Inbound spiegelt VTODO in zwei Ziele, also muss die Rückrichtung beide
// kennen. `table` wird in SQL interpoliert (SQLite erlaubt keine Bind-Parameter
// für Bezeichner) - die Modulnamen hier sind zugleich die Whitelist, ein
// unbekannter Name kommt nie bis zum Statement.
// --------------------------------------------------------

export const MODULES = {
  tasks: {
    table: 'tasks',
    // Felder, die zum Server gespiegelt werden. Alles andere (Kategorie,
    // Zuweisung, Punkte, Sichtbarkeit, Unteraufgaben) ist Yuvomi-intern und
    // kennt in VTODO keine Entsprechung, löst also keinen Push aus.
    //
    // `tags_key` ist kein Spaltenname: Tags liegen in task_tags, der
    // Feldvergleich sieht aber nur die Zeile. Der Aufrufer hängt den
    // kanonischen Schlüssel (utils/task-tags.js: tagsKey) an beide Seiten,
    // sonst bliebe eine reine Tag-Änderung unbemerkt (#586).
    mirrored: ['title', 'description', 'priority', 'status', 'due_date', 'due_time', 'tags_key'],
    icsFields: icsFieldsForTask,
    labelOf: (row) => row.title,
  },

};

function moduleDef(module) {
  const def = MODULES[module];
  if (!def) throw new Error(`Unknown VTODO module "${module}".`);
  return def;
}

// --------------------------------------------------------
// Feld-Abbildung Yuvomi → VTODO
// --------------------------------------------------------

/** RFC-5545-Zeitstempel in UTC, wie ihn COMPLETED und DTSTAMP verlangen. */
function utcStamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * Yuvomi-Priorität → RFC-5545-PRIORITY. Gegenstück zu mapVtodoPriority.
 *
 * Vier lokale Stufen treffen auf drei Bänder (1-4 hoch, 5 mittel, 6-9 niedrig),
 * deshalb teilen sich `urgent` und `high` das obere Band. Damit `urgent` den
 * Rückweg trotzdem übersteht, respektiert der Inbound eine lokale Verfeinerung
 * innerhalb desselben Bandes, statt sie zu überschreiben.
 */
export function priorityToVtodo(priority) {
  switch (priority) {
    case 'urgent': return '1';
    case 'high':   return '2';
    case 'medium': return '5';
    case 'low':    return '9';
    default:       return null; // 'none' → Property entfernen
  }
}

/**
 * DUE-Property aus Datum und Uhrzeit.
 *
 * Ohne Uhrzeit ein reines Datum (VALUE=DATE), sonst ein UTC-Zeitstempel. Eine
 * Aufgabe trägt keine TZID: `due_date`/`due_time` sind Wanduhr-Werte in der Zone
 * des Haushalts, also muss die Uhrzeit von dort nach UTC (Gegenstück zu
 * splitDue). Ein ungeprüft als UTC verschicktes „14:30" verschöbe die Aufgabe auf
 * dem Server um den Zonenoffset.
 */
export function dueField(date, time, tz = householdTimeZone(null)) {
  if (!date) return null; // Property entfernen
  const day = String(date).slice(0, 10);
  if (!time) return { value: day.replace(/-/g, ''), params: ';VALUE=DATE' };

  const utc = localToUTC(`${day}T${String(time).slice(0, 5)}:00`, tz);
  return { value: utc.replace(/[-:]/g, '').replace(/\.\d{3}/, ''), params: '' };
}

/**
 * Erledigt-Zustand als die drei Properties, an denen Clients ihn ablesen.
 * `hadCompleted` verhindert, dass eine Bearbeitung an einer längst erledigten
 * Aufgabe deren Erledigt-Zeitpunkt auf jetzt zurücksetzt.
 */
function completionFields(done, inProgress, hadCompleted) {
  if (!done) {
    return {
      STATUS:              inProgress ? 'IN-PROCESS' : 'NEEDS-ACTION',
      COMPLETED:           null,
      'PERCENT-COMPLETE':  null,
    };
  }
  const fields = { STATUS: 'COMPLETED', 'PERCENT-COMPLETE': '100' };
  if (!hadCompleted) fields.COMPLETED = utcStamp();
  return fields;
}

/**
 * VTODO-Properties einer lokalen Aufgabe.
 *
 * CATEGORIES wird nur aufgenommen, wenn die Tags wirklich geladen sind (#586).
 * Der Unterschied ist folgenreich: ein leeres Array heißt „keine Tags mehr" und
 * entfernt die Property auf dem Server, ein fehlendes Feld heißt „unbekannt"
 * und muss sie unberührt lassen. Wäre beides dasselbe, würde jeder Aufrufer,
 * der eine rohe Zeile aus `SELECT *` durchreicht, die Tags des Servers
 * stillschweigend löschen - `reloadRow` hängt sie deshalb an.
 */
export function icsFieldsForTask(task, hadCompleted = false, tz = householdTimeZone(null)) {
  const fields = {
    SUMMARY:     task.title,
    DESCRIPTION: task.description || null,
    DUE:         dueField(task.due_date, task.due_time, tz),
    PRIORITY:    priorityToVtodo(task.priority),
    ...completionFields(task.status === 'done', task.status === 'in_progress', hadCompleted),
  };
  if (Array.isArray(task.tags)) fields.CATEGORIES = task.tags;
  return fields;
}

/** VTODO-Properties eines lokalen Einkaufspostens. */


/** Trägt das Objekt bereits einen Erledigt-Zeitpunkt? */
function hasCompleted(icsText) {
  return /^COMPLETED[;:]/im.test(String(icsText || ''));
}

// --------------------------------------------------------
// Vormerkung: Löschung
// --------------------------------------------------------

/** Gibt es das Konto noch? */
function accountExists(accountId) {
  return !!db.get().prepare('SELECT 1 FROM caldav_accounts WHERE id = ?').get(accountId);
}

/**
 * Ist dieser Eintrag ein CalDAV-Spiegel, für den die Rückrichtung überhaupt gilt?
 * Lokale Aufgaben haben external_source = 'local' und gehen nirgendwohin.
 *
 * Das Konto muss es noch geben. `external_account_id` trägt keinen
 * Fremdschlüssel (v45), eine gedriftete Datenbank kann also auf ein längst
 * gelöschtes Konto zeigen - und der Tombstone darauf scheiterte am
 * Fremdschlüssel von caldav_todo_pending_deletions, womit sich die Aufgabe
 * lokal nicht mehr löschen ließe. Ohne Konto gibt es keinen Rückweg, also ist
 * hier nichts vorzumerken: dieselbe Vorprüfung wie acceptsOutbound() bei den
 * Terminen. Der Regelfall ist ohnehin abgedeckt - caldavSync.deleteAccount
 * entkoppelt seine Zeilen (detachAccountRows), Migration v123 den Bestand.
 */
function isMirrored(row) {
  if (!row || row.external_source !== 'caldav') return false;
  if (!row.external_uid || !row.external_account_id) return false;
  return accountExists(row.external_account_id);
}

/**
 * Löst die gespiegelten Zeilen eines Kontos von ihm ab - zu rufen, bevor das
 * Konto verschwindet. Was hier steht, sind Nutzerdaten und bleibt; nur die
 * Verbindung zum Server geht. Danach ist es eine gewöhnliche Aufgabe bzw. ein
 * gewöhnlicher Einkaufsposten: kein Tombstone, kein Push, und der Prune-Lauf
 * eines anderen Kontos fasst sie nicht an.
 *
 * @returns {number} Anzahl entkoppelter Zeilen
 */
export function detachAccountRows(accountId) {
  let detached = 0;
  for (const def of Object.values(MODULES)) {
    detached += db.get().prepare(`
      UPDATE ${def.table}
         SET external_source     = 'local',
             external_uid        = NULL,
             external_account_id = NULL,
             external_object_url = NULL,${''}
             outbound_dirty      = 0,
             outbound_attempts   = 0
       WHERE external_source = 'caldav' AND external_account_id = ?
    `).run(accountId).changes;
  }
  // Das Upload-Ziel lokaler Aufgaben trägt ebenso keinen Fremdschlüssel
  // (#1885). Ohne Ziel bleibt die Aufgabe lokal und wird nie gesendet - wie
  // jede Zeile ohne Konto. Einkaufsposten tragen kein eigenes Ziel: sie erben
  // es von der Listenzuordnung, und die fällt per CASCADE mit dem Konto.
  db.get().prepare(`
    UPDATE tasks SET target_caldav_account_id = NULL, target_caldav_list_url = NULL
     WHERE target_caldav_account_id = ?
  `).run(accountId);
  return detached;
}

/**
 * Merkt einen gerade lokal gelöschten Spiegel-Eintrag für die Löschung auf dem
 * Server vor. Muss VOR dem lokalen DELETE mit der noch vorhandenen Zeile
 * aufgerufen werden - danach sind UID und Objekt-URL weg.
 *
 * @returns {boolean} true, wenn ein Tombstone entstanden ist
 */
export function queueTodoDeletion(module, row) {
  moduleDef(module);
  if (!isMirrored(row)) return false;

  db.get().prepare(`
    INSERT INTO caldav_todo_pending_deletions (account_id, module, uid, object_url)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(account_id, module, uid)
      DO UPDATE SET object_url = COALESCE(excluded.object_url, object_url)
  `).run(row.external_account_id, module, row.external_uid, row.external_object_url || null);
  return true;
}

/**
 * Löst EINEN Einkaufsartikel von seinem Objekt auf dem Server, weil er auf
 * eine Liste zieht, die NICHT gespiegelt ist (#1700): das Objekt wird zur
 * Löschung vorgemerkt, die Zeile selbst bleibt und ist danach ein
 * gewöhnlicher, hier angelegter Artikel. Am Server ist dieser Umzug ein
 * Löschen - es gibt dort keinen Platz, an den das Objekt mitkönnte.
 *
 * Die gespiegelten Etiketten (VTODO-CATEGORIES, #586) gehen mit dem Objekt:
 * sie sind eine Kopie SEINER Eigenschaft, Yuvomi verwaltet sie nicht. Blieben
 * sie stehen, zeigte die Zeile Etiketten, die es nirgends mehr gibt und die
 * sich hier nicht entfernen lassen.
 *
 * Muss mit der Zeile VOR dem Umzug gerufen werden.
 *
 * @returns {boolean} true, wenn ein Tombstone entstanden ist
 */


/**
 * Die Server-Listen, denen diese Einkaufsliste zugeordnet ist - auch die
 * abgewählten. Abgewählt heisst "gerade nicht abgleichen", nicht "diese Liste
 * hat keinen Platz auf dem Server".
 */

/** Merkt alle gespiegelten Einträge einer Auswahl vor (Mehrfachlöschungen). */
export function queueTodoDeletions(module, rows) {
  let queued = 0;
  for (const row of rows || []) {
    if (queueTodoDeletion(module, row)) queued++;
  }
  return queued;
}

export function pendingDeletions(accountId, module) {
  return db.get().prepare(`
    SELECT id, uid, object_url, attempts
    FROM caldav_todo_pending_deletions
    WHERE account_id = ? AND module = ?
    ORDER BY id
  `).all(accountId, module);
}

/**
 * Offene Lösch-UIDs eines Moduls als Set - der Inbound darf einen lokal
 * gelöschten Eintrag nicht wieder anlegen, solange der Server ihn noch führt.
 * Fehlt die Tabelle (gedriftete Datenbank), gilt "keine offenen Löschungen":
 * daran darf ein Inbound-Lauf nicht scheitern.
 */
export function pendingDeletionUids(accountId, module) {
  try {
    return new Set(
      db.get().prepare(
        'SELECT uid FROM caldav_todo_pending_deletions WHERE account_id = ? AND module = ?'
      ).all(accountId, module).map((r) => r.uid)
    );
  } catch (err) {
    log.warn(`Pending deletions are not readable (${err.message}); treating them as none.`);
    return new Set();
  }
}

function dropDeletion(id) {
  db.get().prepare('DELETE FROM caldav_todo_pending_deletions WHERE id = ?').run(id);
}

/**
 * Liegt diese Objektadresse in einer Liste, die für das Konto ABGEWÄHLT ist
 * (#1884)? Ein Löschauftrag nennt seine Liste nicht; sie ergibt sich aus der
 * Adresse seines Objekts. Abgewählt heisst: die Auswahl des Kontos kennt die
 * Liste, und keine ihrer Zeilen ist eingeschaltet. Eine Adresse ohne Liste in
 * der Auswahl ist nicht abgewählt, sondern unbekannt - für sie gilt nichts
 * von hier.
 *
 * Gelesen bei jedem Aufruf: gefragt wird unmittelbar vor einem DELETE, und
 * davor liegen awaits.
 */
function inUnselectedList(accountId, objectUrl) {
  const list = collectionUrlOf(objectUrl);
  if (!list) return false;
  const known = db.get().prepare(
    'SELECT list_url, enabled FROM caldav_reminder_selection WHERE account_id = ?'
  ).all(accountId).filter((sel) => sameCollection(sel.list_url, list));
  return known.length > 0 && !known.some((sel) => sel.enabled === 1);
}

/**
 * Die Löschaufträge eines Kontos, die auf eine abgewählte Liste warten
 * (#1884), über beide Module.
 */
export function deletionsWaitingForSelection(accountId) {
  return db.get().prepare(
    'SELECT id, module, uid, object_url FROM caldav_todo_pending_deletions WHERE account_id = ? ORDER BY id'
  ).all(accountId).filter((row) => row.object_url && inUnselectedList(accountId, row.object_url));
}

/**
 * Räumt die Löschaufträge ab, deren Liste es auf dem Server nicht mehr gibt
 * (#1884): mit der Liste ist auch das Objekt fort. Der Lauf schaltet eine
 * verschwundene Liste ab, und ein Auftrag für eine abgewählte wartet - ohne
 * das hier für immer.
 *
 * Nur für Aufträge, deren Liste die Auswahl des Kontos kennt; eine Adresse,
 * die zu keiner bekannten Liste gehört, wird nicht beurteilt. `listedUrls` ist
 * die Auflistung DIESES Laufs und vom Aufrufer als nicht leer befunden.
 *
 * @returns {number} abgeräumte Aufträge
 */
export function dropDeletionsOfMissingLists(accountId, listedUrls) {
  const listed = [...(listedUrls || [])];
  if (listed.length === 0) return 0;
  const selection = db.get().prepare(
    'SELECT list_url FROM caldav_reminder_selection WHERE account_id = ?'
  ).all(accountId);
  const gone = new Map();
  for (const row of db.get().prepare(
    'SELECT id, object_url FROM caldav_todo_pending_deletions WHERE account_id = ? ORDER BY id'
  ).all(accountId)) {
    const list = collectionUrlOf(row.object_url);
    if (!list || !selection.some((sel) => sameCollection(sel.list_url, list))) continue;
    if (listed.some((url) => sameCollection(url, list))) continue;
    dropDeletion(row.id);
    gone.set(list, (gone.get(list) || 0) + 1);
  }
  let dropped = 0;
  for (const [list, count] of gone) {
    dropped += count;
    log.warn(`Reminder list ${list} no longer exists on the server: dropped ${count} pending deletion(s) for it, its entries are gone with it.`);
  }
  return dropped;
}

function failDeletion(id, err, { counts = true } = {}) {
  db.get().prepare(
    'UPDATE caldav_todo_pending_deletions SET attempts = attempts + ?, last_error = ? WHERE id = ?'
  ).run(counts ? 1 : 0, String(err?.message || err).slice(0, 500), id);
}

// --------------------------------------------------------
// Vormerkung: Änderung
// --------------------------------------------------------

export function mirroredFieldsChanged(module, before, after) {
  return moduleDef(module).mirrored.some((f) => before?.[f] !== after?.[f]);
}


export function markTodoOutbound(module, before, after) {
  const def = moduleDef(module);
  if (!isMirrored(after)) return false;
  if (!mirroredFieldsChanged(module, before, after)) return false;

  db.get().prepare(
    `UPDATE ${def.table} SET outbound_dirty = 1, outbound_attempts = 0 WHERE id = ?`
  ).run(after.id);
  return true;
}

export function pendingUpdates(accountId, module) {
  const def = moduleDef(module);
  return db.get().prepare(`
    SELECT * FROM ${def.table}
    WHERE outbound_dirty = 1 AND external_source = 'caldav' AND external_account_id = ?
    ORDER BY id
  `).all(accountId);
}

/** UIDs mit ausstehendem Push - der Inbound überschreibt sie nicht. */
export function pendingUpdateUids(accountId, module) {
  const def = moduleDef(module);
  try {
    return new Set(
      db.get().prepare(`
        SELECT external_uid FROM ${def.table}
        WHERE outbound_dirty = 1 AND external_source = 'caldav' AND external_account_id = ?
      `).all(accountId).map((r) => r.external_uid)
    );
  } catch (err) {
    log.warn(`Pending updates are not readable (${err.message}); treating them as none.`);
    return new Set();
  }
}

function clearOutbound(module, id) {
  const def = moduleDef(module);
  db.get().prepare(
    `UPDATE ${def.table} SET outbound_dirty = 0, outbound_attempts = 0 WHERE id = ?`
  ).run(id);
}

function failOutbound(module, id) {
  const def = moduleDef(module);
  db.get().prepare(
    `UPDATE ${def.table} SET outbound_attempts = outbound_attempts + 1 WHERE id = ?`
  ).run(id);
}

/**
 * Der Stand unmittelbar vor dem Server-Aufruf; null, wenn parallel gelöscht.
 * Aufgaben bekommen ihre Tags angehängt - sie liegen in task_tags, `SELECT *`
 * allein liefert sie also nicht, und icsFieldsForTask baut CATEGORIES daraus (#586).
 */
function reloadRow(module, id) {
  const def = moduleDef(module);
  const row = db.get().prepare(`SELECT * FROM ${def.table} WHERE id = ?`).get(id) ?? null;
  if (row && module === 'tasks') row.tags = loadTags(db.get(), row.id);
  return row;
}

/**
 * Hat sich die Zeile geändert, seit `sent` gelesen wurde (#1862)? Beide Seiten
 * kommen aus `reloadRow`, tragen ihre Tags also als Liste; der Feldvergleich
 * kennt sie nur als `tags_key`.
 */
function changedSince(module, sent, now) {
  const keyed = (row) => (module === 'tasks' ? { ...row, tags_key: tagsKey(row.tags || []) } : row);
  return mirroredFieldsChanged(module, keyed(sent), keyed(now));
}

/**
 * Schliesst eine hinausgegangene Änderung ab - gegen den Stand von JETZT.
 *
 * Zwischen dem Nachladen vor dem PUT und hier liegt die Anfrage. Trifft in der
 * Zeit eine zweite Bearbeitung ein, steht outbound_dirty schon (wieder) auf 1,
 * und ein pauschales Zurücksetzen löschte genau diese Vormerkung: oben läge
 * die erste Bearbeitung, und der nächste Abruf ersetzte die zweite durch sie.
 * Erledigt ist nur, was hinausging - dasselbe wie `settleOutbound` bei den
 * Terminen. Synchron: zwischen dem Nachladen und dem Schreiben liegt kein await.
 */
function settleOutbound(module, sent) {
  const now = reloadRow(module, sent.id);
  if (!now) return; // inzwischen gelöscht - der Tombstone der Route übernimmt
  if (!changedSince(module, sent, now)) {
    clearOutbound(module, sent.id);
    return;
  }
  const def = moduleDef(module);
  db.get().prepare(
    `UPDATE ${def.table} SET outbound_dirty = 1, outbound_attempts = 0 WHERE id = ?`
  ).run(sent.id);
}

// --------------------------------------------------------
// Vormerkung: Anlegen (#695)
// --------------------------------------------------------

/** Art eines Eintrags im UID-Namensraum (`server/utils/own-uid.js`). */
function uidKind(module) {
  return 'task';
}

/**
 * UID einer in Yuvomi entstandenen Aufgabe oder eines Einkaufsartikels.
 *
 * Aus der Zeilen-Id UND der Kennung dieser Installation abgeleitet, nicht
 * zufällig je Versuch: die UID einer Zeile ist immer dieselbe. Kam ein PUT auf
 * dem Server an, seine Antwort aber nicht hier, trifft der nächste Versuch
 * deshalb auf das eigene Objekt - der Server meldet 412, und `uploadNewTodo`
 * übernimmt es, statt ein zweites anzulegen. Die Installationskennung macht
 * dieses 412 eindeutig: ohne sie konnte an der Adresse auch der Eintrag einer
 * anderen Installation mit derselben Zeilen-Id liegen.
 *
 * Schon gespiegelte Zeilen behalten ihre UID nach dem alten Muster
 * (`yuvomi-task-<id>@yuvomi.local`); umbenannt wird nichts.
 */
export function todoUidFor(module, id) {
  return ownUid(uidKind(module), id, db.get());
}


export function adoptOwnUpload(module, uid, accountId, objectUrl, { listUrl, targetListId = null } = {}) {
  const def = moduleDef(module);
  const rowId = ownUploadRowId(uid, uidKind(module), db.get());
  if (!rowId || !objectUrl || !listUrl) return false;
  // Exakt die UID, die wir für diese Zeile erzeugen würden.
  if (uid !== todoUidFor(module, rowId)) return false;
  // Das Objekt liegt in der Liste, die gerade abgerufen wird - nicht an einer
  // Adresse, die der Server frei gewählt hat.
  if (!sameCollection(collectionUrlOf(objectUrl) || '', listUrl)) return false;

  const waitingHere = pendingCreations(accountId, module).some(
      (row) => row.id === rowId && sameCollection(row.target_caldav_list_url, listUrl)
    );
  if (!waitingHere) return false;

  // Das Ziel einer Aufgabe fällt im selben Schreibvorgang (wie `bookTodoUpload`).
  const adopted = db.get().prepare(`
    UPDATE ${def.table}
       SET external_source     = 'caldav',
           external_uid        = ?,
           external_account_id = ?,
           external_object_url = ?,${module === 'tasks' ? `
           target_caldav_account_id = NULL,
           target_caldav_list_url   = NULL,` : ''}
           outbound_dirty      = 1,
           outbound_attempts   = 0
     WHERE id = ? AND external_source = 'local'
  `).run(uid, accountId, objectUrl, rowId).changes > 0;
  if (adopted) {
    keepOwnUpload(module, uid, objectUrl);
    // Übernommen ist gebucht: die Notiz des Uploads fällt (#1882).
    settleUploadAttempt({ source: 'caldav', accountId, kind: uidKind(module), rowId, collectionUrl: listUrl });
    log.info(`Adopted the earlier upload of ${def.table} row ${rowId} (${uid}).`);
  }
  return adopted;
}

/**
 * Vollständiges VTODO-Objekt für einen Eintrag, den es auf dem Server noch nicht
 * gibt. Gebaut wird ein Gerüst mit UID und DTSTAMP, das anschließend durch
 * denselben Patcher läuft wie jede spätere Änderung - so gibt es genau EINE
 * Stelle, die Yuvomi-Felder in VTODO-Properties übersetzt. Eine zweite
 * Serialisierung neben icsFieldsForTask wäre die Sorte Doppelung, die
 * auseinanderläuft, sobald ein Feld dazukommt.
 */
export function buildTodoICS(module, row, uid) {
  const def = moduleDef(module);
  const skeleton = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Yuvomi//CalDAV Sync//EN',
    'BEGIN:VTODO',
    `UID:${uid}`,
    `DTSTAMP:${utcStamp()}`,
    'END:VTODO',
    'END:VCALENDAR',
  ].join('\r\n');

  return patchICSTodo(skeleton, uid, def.icsFields(row, false, householdTimeZone(db.get())));
}

/**
 * Einträge, die hier entstanden sind und auf ihren ersten Upload warten.
 *
 * Unteraufgaben bleiben ausgenommen: sie sind Punkte einer Checkliste, und als
 * eigenständige VTODOs stünden sie auf dem Server gleichrangig neben ihrer
 * Elternaufgabe - der Zusammenhang, der sie überhaupt zu Unteraufgaben macht,
 * ginge dabei verloren. VTODO kennt zwar RELATED-TO, aber der Inbound wertet es
 * nicht aus; die Rundreise würde sie also als lose Aufgaben zurückbringen.
 */
export function pendingCreations(accountId, module = 'tasks', id = null) {
  const def = moduleDef(module);
  if (module !== 'tasks') return [];
  // Mit `id` dieselbe Frage für EINE Zeile: die Upload-Schleife stellt sie
  // frisch, wenn die Zeile an der Reihe ist (#1881) - durch dieselbe Auswahl.
  return withoutOwnRemoval(module, accountId, db.get().prepare(`
    SELECT * FROM ${def.table}
     WHERE external_source          = 'local'
       AND target_caldav_account_id = ?
       AND target_caldav_list_url IS NOT NULL
       AND parent_task_id IS NULL
       AND (? IS NULL OR id = ?)
     ORDER BY id
  `).all(accountId, id, id));
}

/**
 * Nimmt die Zeilen heraus, deren EIGENES Objekt in diesem Konto noch entfernt
 * werden soll (#1881).
 *
 * Das gibt es, seit ein Zielwechsel während des Uploads das gerade angelegte
 * Objekt zum Löschen vormerkt und die Zeile lokal lässt: Zeile und Auftrag
 * tragen dann dieselbe UID. Ginge die Zeile in der Zeit wieder hinauf, träfe
 * sie in derselben Liste auf genau dieses Objekt, übernähme es (412), und der
 * wartende Auftrag nähme es ihr danach weg; in einer anderen Liste des Kontos
 * stünde die UID zweimal, und der Auftrag kennt keine Liste, nur das Konto
 * (der Abruf verdeckt die UID kontoweit). Also erst fort, dann neu: der
 * Auftrag läuft in jedem Durchgang VOR den Uploads, im Regelfall wartet die
 * Zeile keinen Lauf. Gibt der Auftrag auf, ist sie wieder frei.
 */
function withoutOwnRemoval(module, accountId, rows) {
  if (!rows.length) return rows;
  const removing = pendingDeletionUids(accountId, module);
  if (!removing.size) return rows;
  return rows.filter((row) => !removing.has(todoUidFor(module, row.id)));
}

/** Zwei Schreibweisen derselben Collection-URL: mit und ohne Schlussstrich. */
function sameCollection(a, b) {
  return String(a).replace(/\/+$/, '') === String(b).replace(/\/+$/, '');
}

/**
 * Das Ziel, das die Folgeinstanz einer Serie von ihrer Vorgängerin erbt (#1515),
 * oder null.
 *
 * Eine hier angelegte Aufgabe trägt ihr Ziel nur bis zum Upload in den
 * Zielspalten - processPendingCreations räumt sie danach ab, und ab da steht die
 * Liste nur noch in der Objekt-URL des Spiegels. Das ist der Regelfall, denn der
 * Sofortversuch läuft direkt nach dem Anlegen. Wer nur die Zielspalten
 * weitergäbe, deckte also bloß den Fall ab, dass die Serie abgehakt wird, bevor
 * sie oben ist; die Folgeinstanz einer hochgeladenen Serie bliebe lokal.
 *
 * Einen Spiegel zählt nur mit, wer hier entstanden ist: seine UID ist eine aus
 * dem eigenen Namensraum für genau diese Zeile (altes oder neues Muster). Ein vom Server geholter Eintrag bleibt, wie er war - seine Liste
 * gehört einem anderen Programm, und Yuvomi hat nie zugesagt, dort Einträge
 * anzulegen.
 *
 * Geprüft wird gegen die Auswahltabelle wie beim Anlegen (resolveTaskSyncTarget):
 * ist die Liste inzwischen abgewählt oder das Konto weg, bleibt die
 * Folgeinstanz lokal - derselbe Ausgang, den processPendingCreations einer
 * wartenden Aufgabe mit verschwundener Liste gibt.
 *
 * @returns {{accountId: number, listUrl: string}|null}
 */
export function recurrenceFollowupTarget(task) {
  if (!task || task.parent_task_id) return null;
  let accountId = null;
  let listUrl   = null;
  if (task.external_source === 'local') {
    accountId = task.target_caldav_account_id;
    listUrl   = task.target_caldav_list_url;
  } else if (isMirrored(task) && isOwnUidOfRow(task.external_uid, 'task', task.id)) {
    accountId = task.external_account_id;
    listUrl   = collectionUrlOf(task.external_object_url);
  }
  if (!accountId || !listUrl) return null;

  // Die Schreibweise der Auswahltabelle zurückgeben, nicht die abgeleitete:
  // taskListsOf schlägt die Liste später genau unter diesem Schlüssel nach.
  const selected = db.get().prepare(`
    SELECT list_url FROM caldav_reminder_selection
     WHERE account_id = ? AND enabled = 1 AND target_module = 'tasks'
  `).all(accountId).map((r) => r.list_url);
  const match = selected.find((url) => sameCollection(url, listUrl));
  return match ? { accountId, listUrl: match } : null;
}

/**
 * Einkaufsartikel einer gespiegelten Liste, die es auf dem Server noch nicht gibt.
 *
 * `external_source = 'local'` ist der Spalten-Default, trennt also genau die
 * hier angelegten Artikel von den vom Server geholten Spiegeln.
 *
 * @param {number} listId
 * @param {number|null} [accountId] das Konto, das hochladen würde
 */


/**
 * Konten, unter denen ein hier angelegter Einkaufsartikel auf seinen Upload
 * wartet (#831). Anders als eine Aufgabe merkt sich ein Artikel kein Ziel - die
 * offene Arbeit ist deshalb nur über die Listenzuordnung sichtbar.
 */


/** Konten mit wartenden Uploads. */
function accountsWithPendingCreations() {
  try {
    return db.get().prepare(`
      SELECT DISTINCT target_caldav_account_id AS account_id FROM tasks
       WHERE external_source = 'local' AND target_caldav_account_id IS NOT NULL
    `).all().map((r) => r.account_id).filter(Boolean);
  } catch (err) {
    // Gedriftete Datenbank ohne Migration 136: kein Grund, den ganzen
    // Sofortversuch scheitern zu lassen.
    log.warn(`Pending creations are not readable (${err.message}); treating them as none.`);
    return [];
  }
}

/**
 * Ein unerreichbares Ziel abräumen - genau das Ziel, das `task` trägt (#1881).
 * Steht an der Zeile inzwischen ein anderes, bleibt es: der Aufrufer hat über
 * das gelesene geurteilt, nicht über das, was danach gewählt wurde. Nach einem
 * geglückten Upload räumt die Buchung selbst ab (`bookTodoUpload`).
 */
function clearCreationTarget(task) {
  db.get().prepare(`
    UPDATE tasks SET target_caldav_account_id = NULL, target_caldav_list_url = NULL
     WHERE id = ? AND target_caldav_account_id IS ? AND target_caldav_list_url IS ?
  `).run(task.id, task.target_caldav_account_id ?? null, task.target_caldav_list_url ?? null);
}

/**
 * Einen lokalen Eintrag auf dem Server anlegen und die Zeile zum Spiegel machen.
 *
 * Gemeinsamer Kern beider Anlege-Wege: Aufgaben tragen ihr Ziel selbst, ein
 * Einkaufsartikel erbt es von der Listenzuordnung (siehe unten). Was danach
 * passiert, ist identisch - deshalb steht es hier nur einmal.
 *
 * Die Objekt-URL wird gleich festgehalten: ohne sie wäre der frisch
 * hochgeladene Eintrag für Änderungen und Löschungen unerreichbar, bis der
 * nächste Inbound-Lauf ihn wiederfindet (dieselbe Lehre wie bei den Terminen,
 * #593).
 *
 * @returns {Promise<'mirrored'|'deleted'|'released'|'unchanged'|null>} wie
 *   `bookTodoUpload`; null, wenn sich kein VTODO bauen ließ
 */
async function uploadNewTodo(client, collection, module, row, accountId) {
  const def = moduleDef(module);
  const uid = todoUidFor(module, row.id);
  const ics = buildTodoICS(module, row, uid);
  if (!ics) return null;

  const objectUrl = `${String(collection.url).replace(/\/?$/, '/')}${uid}.ics`;
  // VOR der Anfrage notiert (#1882, `caldav-upload-attempts.js`): geht die
  // Antwort verloren, belegt die Notiz, dass von dieser Zeile etwas an diesem
  // Platz liegen kann. Sie fällt mit der Buchung unten. Synchron, unmittelbar
  // vor der Anfrage.
  const place = { source: 'caldav', accountId, kind: uidKind(module), rowId: row.id, collectionUrl: collection.url };
  noteUploadAttempt({ ...place, uid, objectUrl });
  // Der Name ist vergeben (412) und das Objekt trägt unsere UID: ein früherer
  // PUT kam an, seine Antwort nicht. Übernehmen und den lokalen Stand als
  // Änderung vormerken, statt zu raten, was dort liegt.
  let adopted = false;
  try {
    await client.createCalendarObject({
      calendar:   collection,
      filename:   `${uid}.ics`,
      iCalString: ics,
    });
  } catch (err) {
    if (err?.status !== 412) throw err;
    // Die UID wird im Objekt GELESEN, nicht aus dem Dateinamen geschlossen;
    // liegt dort etwas anderes, bleibt es unangetastet und die Zeile lokal.
    // Gemerkt wird die eigene, berechnete Adresse, nicht eine vom Server genannte.
    if (!(await findObjectWithUid(client, collection.url, objectUrl, uid))) throw err;
    adopted = true;
    log.info(`${def.table} row ${row.id} is already on the server as ${uid}, adopting it.`);
  }

  return bookTodoUpload(module, row, { uid, objectUrl, accountId, collectionUrl: collection.url, adopted });
}


function waitsForUploadHere(module, now, accountId, collectionUrl) {

  return now.target_caldav_account_id === accountId
    && !!now.target_caldav_list_url
    && sameCollection(now.target_caldav_list_url, collectionUrl)
    && !now.parent_task_id;
}

/**
 * Bucht das Ergebnis eines Uploads - gegen den Stand von JETZT (#1862, #1881):
 * zwischen `sent` und hier lag die Anfrage, und in der Zeit lief die App
 * weiter.
 *
 *   - Die Zeile ist weg: für eine lokale Zeile merkt die Löschroute nichts
 *     vor, das Objekt läge also für immer oben, und der nächste Abruf holte
 *     den gelöschten Eintrag als neue Zeile zurück. Das gerade angelegte
 *     Objekt wird zum Löschen vorgemerkt.
 *   - Die Zeile ist nicht mehr lokal: nichts wird überschrieben.
 *   - Die Zeile wartet nicht mehr auf DIESEN Upload (`waitsForUploadHere`):
 *     ihr Ziel wurde gewechselt oder zurückgenommen, der Artikel liegt in
 *     einer anderen Liste. Einen Umzug zwischen Listen gibt es bewusst nicht -
 *     das gerade angelegte Objekt wird zum Löschen vorgemerkt, die Zeile
 *     bleibt lokal und behält, was jetzt an ihr steht. Hat sie ein neues Ziel,
 *     geht sie dorthin, sobald das alte Objekt fort ist (`withoutOwnRemoval`).
 *   - Die Zeile wurde bearbeitet: oben liegt der Stand davor. Sie wird Spiegel
 *     UND als geändert vorgemerkt, sonst überschriebe der nächste Abruf die
 *     Bearbeitung mit dem alten Stand.
 *
 * Das Ziel einer Aufgabe fällt IM SELBEN Schreibvorgang, der sie zum Spiegel
 * macht, und nur dort. Vorher räumte es der Aufrufer nach jedem geglückten
 * Upload ab - auch das Ziel, das während der Anfrage gerade erst gewählt
 * worden war.
 *
 * Synchron: zwischen dem Nachladen und dem Schreiben liegt kein await, und
 * jeder Ausgang ist EIN Schreibvorgang.
 *
 * Mit jeder Buchung fällt die Notiz des Uploads (#1882). Bei `unchanged`
 * bleibt sie stehen - über das Objekt wurde nichts entschieden, das tut
 * `releaseLeftoverTodoUploads` am Stand der Zeile.
 *
 * @returns {'mirrored'|'deleted'|'released'|'unchanged'}
 */
function bookTodoUpload(module, sent, { uid, objectUrl, accountId, collectionUrl, adopted = false }) {
  const def = moduleDef(module);
  const booked = () => settleUploadAttempt({
    source: 'caldav', accountId, kind: uidKind(module), rowId: sent.id, collectionUrl,
  });
  const queueRemoval = () => {
    db.get().prepare(`
      INSERT INTO caldav_todo_pending_deletions (account_id, module, uid, object_url)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(account_id, module, uid)
        DO UPDATE SET object_url = COALESCE(excluded.object_url, object_url)
    `).run(accountId, module, uid, objectUrl);
    booked();
  };

  const now = reloadRow(module, sent.id);
  if (!now) {
    queueRemoval();
    log.info(`${def.table} row ${sent.id} was deleted while its upload was in flight, queued the deletion of ${uid}.`);
    return 'deleted';
  }
  if (now.external_source !== 'local') return 'unchanged';
  if (!waitsForUploadHere(module, now, accountId, collectionUrl)) {
    queueRemoval();
    log.info(`The target of ${def.table} row ${sent.id} was changed while its upload was in flight, queued the deletion of ${uid}.`);
    return 'released';
  }
  const edited = changedSince(module, sent, now);

  const mirrored = db.get().prepare(`
    UPDATE ${def.table}
       SET external_source     = 'caldav',
           external_uid        = ?,
           external_account_id = ?,
           external_object_url = ?,${module === 'tasks' ? `
           target_caldav_account_id = NULL,
           target_caldav_list_url   = NULL,` : ''}
           outbound_dirty      = ?,
           outbound_attempts   = 0
     WHERE id = ? AND external_source = 'local'
  `).run(uid, accountId, objectUrl, adopted || edited ? 1 : 0, sent.id).changes > 0;
  if (!mirrored) return 'unchanged';
  keepOwnUpload(module, uid, objectUrl);
  booked();
  return 'mirrored';
}

// --------------------------------------------------------
// Der Upload, dessen Antwort nie ankam (#1882)
// --------------------------------------------------------

/**
 * Führt diese Liste des Kontos noch Einträge dieses Moduls? Nein nur, wenn
 * die Auswahl sie inzwischen dem ANDEREN Modul zuordnet (von "Aufgaben" auf
 * "Einkauf" umgestellt): eine Aufgabe trägt ihr Ziel als Konto und Adresse,
 * und beides stimmt dann weiter, obwohl dort keine Aufgabe mehr hingehört.
 * Abgeschaltet oder aus der Auswahl verschwunden zählt nicht als "nein".
 */
function listStillServes(module, accountId, listUrl) {
  const selected = db.get().prepare(
    'SELECT list_url, target_module FROM caldav_reminder_selection WHERE account_id = ?'
  ).all(accountId).filter((sel) => sameCollection(sel.list_url, listUrl));
  return !selected.length
    || selected.some((sel) => ('tasks') === module);
}

/**
 * Wie steht die Zeile JETZT zu dem Objekt, das ein nie gebuchter Upload an
 * diesem Platz hinterlassen haben kann? Dieselben drei Antworten wie bei den
 * Terminen (`uploadAttemptState` in calendar-outbound.js):
 *
 *   waiting  - lokal, und sie gehört weiter genau dorthin;
 *   mirrored - Spiegel an genau diesem Platz: das Objekt ist ihres;
 *   leftover - gelöscht, anderes oder kein Ziel, woanders Spiegel.
 *
 * Auch die Mitnahme eines umgezogenen Einkaufsartikels (#1700) schreibt hier
 * mit: die Ablage am neuen Platz ist ein Versuch wie jeder Upload, und nach
 * der Buchung steht für den ALTEN Platz eine Notiz - die Zeile ist dann
 * woanders Spiegel, das Objekt dort also ein Rest. Ein Objekt, das an einem
 * Platz liegt, an den die Mitnahme erst noch gehen soll, ist ebenfalls ein
 * Rest (die Zeile ist Spiegel am alten Platz): es wird entfernt, und die
 * Mitnahme legt das heutige Original neu ab.
 */
function todoAttemptState(module, attempt) {
  const def = moduleDef(module);
  const now = db.get().prepare(`SELECT * FROM ${def.table} WHERE id = ?`).get(attempt.row_id);
  if (!now) return 'leftover';
  if (now.external_source === 'local') {
    return waitsForUploadHere(module, now, attempt.account_id, attempt.collection_url)
      && listStillServes(module, attempt.account_id, attempt.collection_url) ? 'waiting' : 'leftover';
  }
  if (now.external_source === 'caldav' && now.external_uid === attempt.uid
      && sameCollection(collectionUrlOf(now.external_object_url) || '', attempt.collection_url)) {
    return 'mirrored';
  }
  return 'leftover';
}

/**
 * Für den Abruf: liegt für das Objekt mit dieser UID in dieser Liste eine
 * Notiz vor, deren Upload nie gebucht wurde und die NICHT schon aufgegangen
 * ist (die Zeile ist nicht Spiegel an diesem Platz)? Dann darf der Aufrufer
 * es nur noch ÜBERNEHMEN (`adoptOwnUpload`, vorher) - sonst weder importieren
 * noch einer Zeile zuordnen. Entfernt wird es von
 * `releaseLeftoverTodoUploads`, für das Konto, dem die Notiz gehört.
 *
 * Über ALLE Konten gefragt: führen zwei Konten dieselbe Liste, sieht der Abruf
 * des einen das Objekt, das über das andere hinaufging.
 *
 * Der Beleg ist die lokale Notiz, nicht die UID. Frisch je Objekt gefragt: die
 * Zeile kann fallen, während der Lauf noch den Server liest.
 */
export function isUnbookedOwnUpload(module, uid, listUrl) {
  // Billig zuerst: das Muster der UID, ohne Datenbank. Die ART kommt aus der
  // UID, nicht aus dem Modul, das die Liste gerade führt: wird eine Liste von
  // "Aufgaben" auf "Einkauf" umgestellt, liegt dort der Rest einer Aufgabe,
  // und der Abruf läse ihn sonst als Einkaufsartikel. `module` sagt nur noch,
  // wer fragt.
  //
  // Jede andere UID kann die eines MITGENOMMENEN Einkaufsartikels sein (#1700):
  // er behält die UID, die sein Objekt schon trug. Notizen der Art `item` zu
  // einer solchen UID schreibt nur die Mitnahme.
  // Das gilt auch für eine UID im Muster einer AUFGABE: ein Artikel trägt sie,
  // wenn seine Liste von "Aufgaben" auf "Einkauf" umgestellt wurde. Gefragt
  // wird deshalb immer auch nach Notizen der Art `item`; jede Notiz wird an
  // der Zeile IHRER Art gemessen.
  const parsed = parseOwnUid(uid);
  const own = !!parsed && parsed.kind === 'task' && parsed.installation !== null;
  const kinds = own ? ['task'] : [];
  moduleDef(module);
  let attempts;
  try {
    attempts = kinds.flatMap((kind) => uploadAttemptsAt({ source: 'caldav', kind, uid, collectionUrl: listUrl }));
  } catch (err) {
    log.warn(`Upload notes are not readable (${err.message}); treating them as none.`);
    return false;
  }
  return attempts.some(
    (attempt) => todoAttemptState('tasks', attempt) !== 'mirrored'
  );
}

/**
 * Für den Abruf, der einen Rest überspringt: hängt an dem Objekt mit dieser
 * UID in dieser Liste noch ein Einkaufsartikel, der anderswo Spiegel
 * DERSELBEN UID ist?
 *
 * Ein übersprungener Rest zählt sonst nicht als "der Server liefert den
 * Eintrag noch" (#1905). Für diesen einen Fall gilt die ältere Regel der
 * Mitnahme (#1700, `confirmCarriedCopy`): fehlt die Kopie am Platz der Zeile,
 * ist das Objekt hier das letzte, und die Zeile geht zu ihm zurück. Das
 * entscheidet `releaseLeftoverTodoUploads` NACH dem Prune desselben Laufs -
 * der Prune darf die Zeile deshalb nicht vorher abräumen.
 *
 * Dieselbe Frage wie dort an die Zeile, aus dem Stand von jetzt; Notizen der
 * Art `task` zählen nie.
 */


/**
 * Entfernt die Reste von Aufgaben- und Einkaufs-Uploads, deren Antwort nie
 * ankam (#1882): die Notizen des Kontos, deren Zeile dort nicht mehr
 * hingehört (`todoAttemptState`). Was dabei gelesen, gelöscht oder stehen
 * gelassen wird, steht an `removeLeftoverUploads`.
 *
 * In jedem Lauf, und im Sofortversuch für jedes Konto, das er ohnehin
 * anfasst, VOR den Uploads: hat die Zeile inzwischen ein anderes Ziel in
 * diesem Konto, ist ihr Rest im Regelfall fort, bevor sie neu hinaufgeht. Und
 * die Regel hängt so an keiner Löschroute.
 *
 * Nur in Listen, die für das Konto eingeschaltet sind. Ein Einkaufsartikel
 * einer abgeschalteten Zuordnung gilt zwar als Rest (er wartet dort nicht),
 * bleibt damit aber unberührt; wird sie wieder eingeschaltet, wartet er
 * wieder, und der Lauf übernimmt das Objekt.
 *
 * DER REST EINER MITNAHME FÄLLT NUR, WENN DIE KOPIE BELEGT IST (#1700). Nach
 * einem Umzug steht für den alten Platz eine Notiz, und die Zeile zeigt auf
 * den neuen. Hat eine andere App die Kopie dort inzwischen gelöscht, wäre das
 * Objekt am alten Platz das letzte - es zu entfernen, nur weil die Zeile
 * woanders hinzeigt, nähme den Eintrag ganz fort, und der Prune danach die
 * Zeile. Vor dem DELETE wird deshalb der Platz GELESEN, auf den die Zeile
 * zeigt (`confirmCarriedCopy`); aus der Zeile geschlossen wird nichts.
 *
 * @param {object} client
 * @param {number} accountId
 * @param {{clientFor?: (accountId: number) => Promise<object|null>}} [opts]
 *        Client eines anderen Kontos - die Kopie kann dort liegen
 * @returns {Promise<number>} entfernte Objekte
 */
export function releaseLeftoverTodoUploads(client, accountId, { clientFor = null } = {}) {
  // Nur in Listen, die für dieses Konto eingeschaltet sind.
  const enabled = db.get().prepare(
    "SELECT list_url FROM caldav_reminder_selection WHERE account_id = ? AND enabled = 1 AND target_module = 'tasks'"
  ).all(accountId).map((r) => r.list_url);
  return removeLeftoverUploads(client, {
    source: 'caldav', accountId, kinds: ['task'],
    stateOf: (attempt) => todoAttemptState('tasks', attempt),
    inScope: (url) => enabled.some((known) => sameCollection(known, url)),

    // Die Zeile ist anderswo Spiegel DERSELBEN UID (nach einer Mitnahme, #1700,
    // oder einem Upload, der seinem Ziel gefolgt ist): der Rest liegt dann
    // unter einer UID, die der Abruf dieser Zeile zuordnet. Fiele die Notiz
    // nach der Frist, obwohl der Server das Entfernen weiter ablehnt, läse der
    // Abruf zwei Objekte für eine Zeile - sie wechselte mit jedem Lauf die
    // Liste, über zwei Konten entstünde ein zweiter Artikel. Die Notiz bleibt,
    // bis das Objekt fort ist oder nachweislich ein anderes.
    keepWhileRefused: (attempt) => {
      const def = moduleDef('tasks');
      const now = db.get().prepare(
        `SELECT external_source, external_uid FROM ${def.table} WHERE id = ?`
      ).get(attempt.row_id);
      return !!now && now.external_source === 'caldav' && now.external_uid === attempt.uid;
    },
    label: 'CalDAV-Todo',
  });
}

/**
 * Darf der Rest an der Adresse dieser Notiz entfernt werden? Gefragt für einen
 * Einkaufsartikel, der anderswo Spiegel DERSELBEN UID ist - der alte Platz
 * nach einer Mitnahme (#1700). Für alles andere gilt die Regel der Notizen
 * unverändert (`true`): die Zeile ist gelöscht oder lokal, der Rest ist ein
 * nie gebuchter Upload.
 *
 *   - Am Platz der Zeile liegt das Objekt mit ihrer UID (gerade gelesen):
 *     der Rest darf fort.
 *   - Dort liegt es NICHT: das Objekt an der Adresse der Notiz ist das, was
 *     der Server von diesem Eintrag noch führt. Es bleibt, die Zeile zeigt
 *     wieder darauf (Konto und Adresse der Notiz), die Notiz fällt, und der
 *     nächste Abruf stellt die Zeile auf die Liste dieser Server-Liste. Der
 *     Eintrag bleibt, wo der Server ihn führt.
 *   - Der Platz der Zeile ist nicht lesbar (Fehler, kein Client für das
 *     andere Konto): nichts wird entfernt, nichts umgeschrieben. Ein Fehler
 *     geht hoch; es gibt keinen Ersatzwert, der "liegt dort" behauptet.
 *
 * Nach dem Lesen wird die Zeile neu gelesen und in einem synchronen Schritt
 * geschrieben.
 */


/**
 * Das Objekt eines eigenen Uploads an dieser Adresse ist ab jetzt gewollt
 * (#1881): Löschaufträge für genau diese UID an genau dieser Adresse fallen,
 * über alle Konten.
 *
 * Im selben Konto kommt es dazu nicht (`withoutOwnRemoval` lässt die Zeile
 * warten). Führen aber zwei Konten dieselbe Liste und wechselt das Ziel
 * während des Uploads von A auf B, trifft der Upload über B auf das Objekt von
 * eben, übernimmt es - und der Auftrag von A löschte es ihm sonst weg. Die UID
 * ist die dieser Installation für diese eine Zeile; ein Auftrag für sie stammt
 * immer aus einem früheren Upload derselben Zeile.
 */
function keepOwnUpload(module, uid, objectUrl) {
  // Die Liste entscheidet, nicht die Schreibweise der Adresse: der Abruf nennt
  // sie, wie der Server sie schreibt (`@` als `%40`), der Auftrag trägt die
  // selbst berechnete.
  const list = collectionUrlOf(objectUrl);
  if (!list) return;
  const waiting = db.get().prepare(
    'SELECT id, object_url FROM caldav_todo_pending_deletions WHERE module = ? AND uid = ?'
  ).all(module, uid);
  for (const row of waiting) {
    const theirs = collectionUrlOf(row.object_url);
    if (theirs && sameCollection(theirs, list)) dropDeletion(row.id);
  }
}

/** EINE Zeile je Liste, die in diesem Lauf abgelehnt hat - mit der Anzahl. */
function reportClosedLists(gate, what) {
  gate.report((listUrl, err, waiting) => log.warn(
    `Reminder list ${listUrl} is not accepting uploads (${err.message}); `
    + `${waiting} ${what} stay local and are tried again on the next run.`
  ));
}

/**
 * Legt wartende Aufgaben auf dem Server an und macht sie damit zu Spiegeln.
 *
 * @param {object} client       tsdav-Client
 * @param {number} accountId
 * @param {string} module
 * @param {Map}    listsByUrl   Listen-URL → Collection des Servers
 * @returns {Promise<number>} erfolgreich hochgeladene Einträge
 */
export async function processPendingCreations(client, accountId, module, listsByUrl) {
  const rows = pendingCreations(accountId, module);
  if (rows.length === 0) return 0;

  const gate = createUploadGate();
  let done = 0;
  for (const listed of rows) {
    // Frisch lesen, durch dieselbe Auswahl (#1881): die Liste stammt von vor
    // der Schleife, und jeder Upload davor war ein await. Wer inzwischen
    // gelöscht wurde oder nicht mehr auf den Upload über dieses Konto wartet,
    // geht nicht hinauf - und sein Ziel, das jetzt ein anderes sein kann,
    // wird hier weder gelesen noch abgeräumt.
    if (!pendingCreations(accountId, module, listed.id).length) continue;
    const fresh = reloadRow(module, listed.id);
    if (!fresh) continue;

    const collection = listsByUrl.get(fresh.target_caldav_list_url);
    if (!collection) {
      // Die Liste ist weg oder wurde abgewählt. Das Ziel stehen zu lassen hieße,
      // es bei jedem Lauf erneut zu versuchen; die Aufgabe bleibt lokal, was der
      // Zustand vor #695 war und keine Daten kostet.
      // Ausnahme (#1882): von dieser Aufgabe ging schon ein Upload in genau
      // diese Liste, und seine Antwort kam nie an. Ihr Objekt kann dort
      // liegen. Fiele jetzt ihr Ziel, gälte es als Rest und würde gelöscht -
      // abwählen heisst aber "nicht mehr abgleichen", nicht "auf dem Server
      // aufräumen". Das Ziel bleibt, die Notiz auch; ist die Liste wieder da,
      // übernimmt der Lauf das Objekt.
      // Gehört die Liste inzwischen dem anderen Modul, gilt die Notiz als
      // Rest (`todoAttemptState`), wird entfernt, und das Ziel fällt im
      // Durchgang danach.
      if (hasUploadAttempt({
        source: 'caldav', accountId, kind: uidKind(module), rowId: fresh.id,
        collectionUrl: fresh.target_caldav_list_url,
      })) {
        log.debug(`Reminder list ${fresh.target_caldav_list_url} is not available; task ${fresh.id} has an unconfirmed upload there and keeps its target.`);
        continue;
      }
      log.warn(`Reminder list ${fresh.target_caldav_list_url} is not available, keeping task ${fresh.id} local.`);
      clearCreationTarget(fresh);
      continue;
    }

    // Die Liste hat in diesem Lauf schon abgelehnt: nicht für jede wartende
    // Aufgabe dieselbe Absage abholen.
    if (gate.isClosed(collection.url)) continue;

    try {
      // Das Ziel räumt die Buchung selbst ab, wenn die Aufgabe Spiegel wird
      // (`bookTodoUpload`) - nicht hier, nach dem await: dann stünde dort
      // womöglich schon das Ziel, das während der Anfrage gewählt wurde.
      const booked = await uploadNewTodo(client, collection, module, fresh, accountId);
      if (booked === 'mirrored') {
        done++;
      } else if (booked === null) {
        log.error(`Could not build a VTODO for task ${fresh.id}, keeping it local.`);
        clearCreationTarget(fresh);
      }
    } catch (err) {
      // Kein Zähler und kein Aufgeben: anders als eine Änderung hat ein Upload
      // keinen Stand, der veralten könnte. Er bleibt vorgemerkt und läuft im
      // nächsten Lauf mit, so lange bis er durchgeht oder das Ziel verschwindet.
      if (!gate.refused(collection.url, err)) {
        log.warn(`Could not upload task ${fresh.id} to ${fresh.target_caldav_list_url}: ${err.message}`);
      }
    }
  }
  reportClosedLists(gate, 'task(s)');
  return done;
}

/**
 * Hier angelegte Einkaufsartikel einer gespiegelten Liste hochladen (#831).
 *
 * Ein Einkaufsartikel trägt - anders als eine Aufgabe - kein eigenes Ziel: die
 * Zuordnung Server-Liste ↔ Yuvomi-Liste steht schon in
 * caldav_reminder_selection, und genau sie ist die Zielangabe. Deshalb braucht
 * dieser Weg weder Zielspalten noch eine Migration; Kandidat ist jeder Artikel
 * der zugeordneten Liste, der noch kein Spiegel ist.
 *
 * Ohne das war die Rückrichtung für den Einkauf halb da: Umbenennen, Abhaken und
 * Löschen liefen über processPendingUpdates/-Deletions zum Server, ein neu
 * angelegter Artikel blieb aber für immer lokal - die Liste lief nach jedem
 * neuen Eintrag auseinander, obwohl die Oberfläche einen Zwei-Wege-Sync
 * verspricht.
 *
 * @param {object} client      tsdav-Client
 * @param {number} accountId
 * @param {Array<{listUrl: string, targetListId: number}>} targets  aktive Zuordnungen
 * @param {Map}    listsByUrl  Listen-URL → Collection des Servers
 * @returns {Promise<number>} erfolgreich hochgeladene Artikel
 */
export async function processPendingDeletions(client, accountId, module, objectIndex, complete = false, { stop = createRefusalStop() } = {}) {
  const rows = pendingDeletions(accountId, module);
  if (rows.length === 0) return 0;

  let done = 0;
  for (const row of rows) {
    const known = objectIndex.get(row.uid);
    let url     = row.object_url || known?.url || null;

    // Je Auftrag gelesen, unmittelbar vor seiner Anfrage.
    if (url && inUnselectedList(accountId, url)) {
      if (!known?.url || inUnselectedList(accountId, known.url)) continue;
      url = known.url;
    }

    if (!url) {
      if (complete) {
        log.info(`VTODO ${row.uid} is no longer on the server, dropping the pending deletion.`);
        dropDeletion(row.id);
        done++;
      }
      continue;
    }

    // Nach einer kontoweiten Absage in diesem Durchgang: nichts senden (#1863).
    if (stop.blocks(collectionUrlOf(url))) continue;

    try {
      await client.deleteCalendarObject({ calendarObject: { url, etag: known?.etag } });
      dropDeletion(row.id);
      done++;
    } catch (err) {
      // Die Adresse liegt nicht beim Konto (`createTodoClient`): gesendet
      // wurde nichts, also zählt kein Versuch. Der volle Lauf räumt ab - das
      // Konto führt das Objekt nicht -, der Sofortversuch lässt ihm den Auftrag.
      if (isOriginRefusal(err)) {
        if (complete) {
          log.warn(`The stored address of VTODO ${row.uid} is not on the server of its account, dropping the pending deletion.`);
          dropDeletion(row.id);
          done++;
        } else {
          log.warn(`The stored address of VTODO ${row.uid} is not on the server of its account, leaving its deletion to the next sync run.`);
        }
        continue;
      }
      // Eine kontoweite Absage verbraucht keinen Versuch (#1863).
      const action = davFailureAction(err, row.attempts);
      if (action === 'settled') {
        dropDeletion(row.id);
        done++;
        continue;
      }
      if (action === 'wait') {
        stop.trip(err, collectionUrlOf(url));
        failDeletion(row.id, err, { counts: false });
        log.warn(`Remote deletion of VTODO ${row.uid} was refused for the whole account, it waits without using up an attempt:`, err.message);
        continue;
      }
      failDeletion(row.id, err);
      if (action === 'give-up') {
        log.error(`Giving up on remote deletion of VTODO ${row.uid} after ${row.attempts + 1} attempt(s):`, err.message);
        dropDeletion(row.id);
        done++;
        continue;
      }
      log.warn(`Remote deletion failed for VTODO ${row.uid} (attempt ${row.attempts + 1}):`, err.message);
    }
  }
  return done;
}

/**
 * Schiebt lokal bearbeitete Spiegel-Einträge zum Server. Geändert wird das
 * Originalobjekt, nicht ein neu gebautes: sonst verlöre die Aufgabe auf dem
 * Server alles, was Yuvomi nicht kennt (Alarme, Unterlisten, Beziehungen).
 * CATEGORIES gehört seit #586 nicht mehr dazu - die Tag-Liste ist vollständig
 * gespiegelt und wird deshalb bewusst verwaltet.
 *
 * @returns {Promise<number>} erfolgreich verarbeitete Einträge
 */
export async function processPendingUpdates(client, accountId, module, objectIndex, { stop = createRefusalStop() } = {}) {
  const def  = moduleDef(module);
  const rows = pendingUpdates(accountId, module);
  if (rows.length === 0) return 0;

  let done = 0;
  for (const row of rows) {
    const known = objectIndex.get(row.external_uid);
    const url   = row.external_object_url || known?.url || null;

    // Weder gespeichert noch im aktuellen Abruf: gehört zu einer Liste, die
    // dieser Lauf nicht angefasst hat. Nichts tun, nichts verwerfen.
    if (!url) continue;

    if (!known?.data) {
      log.warn(`No source object for ${def.table} row ${row.id} in this run, deferring its update.`);
      continue;
    }

    // Frisch nachladen: zwischen der Auswahl und hier liegt ein await, in dem
    // eine weitere Bearbeitung eingetroffen sein kann.
    const fresh = reloadRow(module, row.id);
    if (!fresh) continue; // parallel gelöscht - der Tombstone-Pfad übernimmt

    const patched = patchICSTodo(
      known.data, row.external_uid, def.icsFields(fresh, hasCompleted(known.data), householdTimeZone(db.get()))
    );
    if (!patched) {
      log.warn(`VTODO ${row.external_uid} has no editable component in its calendar object, dropping its update.`);
      clearOutbound(module, row.id);
      continue;
    }

    if (stop.blocks(collectionUrlOf(url))) continue;

    try {
      await client.updateCalendarObject({ calendarObject: { url, etag: known.etag, data: patched } });
      // Erledigt ist nur, was hinausging (#1862).
      settleOutbound(module, fresh);
      done++;
    } catch (err) {
      // Gesendet wurde nichts (`createTodoClient`): kein Versuch, die
      // Bearbeitung bleibt vorgemerkt und der Inbound überschreibt sie nicht.
      if (isOriginRefusal(err)) {
        log.warn(`The stored address of VTODO ${row.external_uid} is not on the server of its account, its update waits.`);
        continue;
      }
      const action = davFailureAction(err, row.outbound_attempts);
      if (action === 'settled') {
        log.warn(`VTODO ${row.external_uid} no longer exists on the server, dropping its update.`);
        clearOutbound(module, row.id);
        continue;
      }
      if (action === 'wait') {
        stop.trip(err, collectionUrlOf(url));
        log.warn(`Outbound update of "${def.labelOf(row)}" was refused for the whole account, it waits without using up an attempt:`, err.message);
        continue;
      }
      if (action === 'give-up') {
        log.error(`Giving up on the outbound update of "${def.labelOf(row)}" after ${row.outbound_attempts + 1} attempt(s):`, err.message);
        clearOutbound(module, row.id);
        continue;
      }
      failOutbound(module, row.id);
      log.warn(`Outbound update failed for "${def.labelOf(row)}" (attempt ${row.outbound_attempts + 1}):`, err.message);
    }
  }
  return done;
}

// --------------------------------------------------------
// Sofortversuch (Fassade für die Route)
// --------------------------------------------------------

/** Konten mit offener ausgehender Arbeit, samt Modul. */
function accountsWithPendingWork() {
  const buckets = new Map();
  const add = (accountId, module) => {
    if (!accountId) return;
    if (!buckets.has(accountId)) buckets.set(accountId, new Set());
    buckets.get(accountId).add(module);
  };

  // Ein Auftrag, der auf eine abgewählte Liste wartet (#1884), ist keine
  // Arbeit für den Sofortversuch: sonst baute jede Bearbeitung einen Client
  // für ein Konto auf, an das nichts geht.
  for (const row of db.get().prepare(
    "SELECT account_id, module, object_url FROM caldav_todo_pending_deletions WHERE module = 'tasks'"
  ).all()) {
    if (row.object_url && inUnselectedList(row.account_id, row.object_url)) continue;
    add(row.account_id, row.module);
  }
  for (const [module, def] of Object.entries(MODULES)) {
    for (const row of db.get().prepare(`
      SELECT DISTINCT external_account_id AS account_id FROM ${def.table}
      WHERE outbound_dirty = 1 AND external_source = 'caldav'
    `).all()) {
      add(row.account_id, module);
    }
  }
  for (const accountId of accountsWithPendingCreations()) add(accountId, 'tasks');


  return buckets;
}

/**
 * Die für Aufgaben freigeschalteten Listen eines Kontos als Collection-Objekte.
 *
 * Der Umweg über die Auswahltabelle ist Absicht: hochgeladen wird nur in eine
 * Liste, die der Haushalt für Aufgaben freigegeben hat. Ein Ziel, das inzwischen
 * abgewählt wurde, taucht hier nicht mehr auf, und processPendingCreations gibt
 * die Aufgabe dann wieder frei, statt sie ewig zu versuchen.
 */
async function taskListsOf(client, accountId) {
  const selected = db.get().prepare(`
    SELECT list_url FROM caldav_reminder_selection
     WHERE account_id = ? AND enabled = 1 AND target_module = 'tasks' AND target_module = 'tasks'
  `).all(accountId).map((r) => r.list_url);
  if (!selected.length) return new Map();

  const allowed = new Set(selected);
  const calendars = await listCollections(client);
  return new Map(
    (calendars || []).filter((c) => allowed.has(c.url)).map((c) => [c.url, c])
  );
}

/**
 * Die Collections des Kontos - oder ein Fehler, wenn der Server KEINE nennt.
 *
 * Gefragt wird hier nur, weil ausgewählte Listen auf einen Upload warten; eine
 * Antwort ohne eine einzige Collection ist dann eine unvollständige Antwort
 * (ein Multistatus, der nur die Home-Collection nennt oder jede Ressource mit
 * 403 quittiert) und kein leeres Konto. Als leere Liste gelesen, gälte jedes
 * Upload-Ziel als verschwunden und würde freigegeben - derselbe Leer-Guard wie
 * beim Prune (#508).
 */
async function listCollections(client) {
  const calendars = await client.fetchCalendars();
  if (!calendars || calendars.length === 0) {
    throw new Error('the server listed no collections, although lists are selected');
  }
  return calendars;
}

/**
 * Die für den Einkauf freigeschalteten Zuordnungen eines Kontos (#831).
 * Gegenstück zu taskListsOf: dort steht das Ziel am Eintrag, hier an der
 * Zuordnung. Bewusst ohne Netzzugriff, damit der Aufrufer erst prüfen kann, ob
 * überhaupt etwas wartet - der Listenabruf ist der teure Teil.
 */


/** Collection-Objekte zu den Zuordnungen - ein Listenabruf. */


/**
 * Holt gezielt die betroffenen Kalenderobjekte statt ganzer Listen - die
 * Grundlage des Sofortversuchs direkt nach einer Bearbeitung. Die Collection
 * wird aus der Objekt-URL abgeleitet, weil ein Eintrag nur diese trägt.
 *
 * @returns {Promise<Map>} UID → { url, etag, data }
 */
export async function fetchObjectsByUrl(client, wanted) {
  const index = new Map();
  if (!wanted.length) return index;

  const byCollection = new Map();
  for (const item of wanted) {
    const collection = collectionUrlOf(item.url);
    if (!collection) continue;
    if (!byCollection.has(collection)) byCollection.set(collection, []);
    byCollection.get(collection).push(item);
  }

  for (const [collection, items] of byCollection) {
    try {
      const objects = await client.fetchCalendarObjects({
        calendar:   { url: collection },
        objectUrls: items.map((i) => i.url),
      });
      for (const obj of objects || []) {
        const match = items.find((i) => sameObjectAddress(i.url, obj.url));
        if (!match) continue;
        index.set(match.uid, { url: match.url, etag: obj.etag, data: obj.data });
      }
    } catch (err) {
      // Kein Grund zur Sorge: der reguläre Sync-Lauf holt die Liste ohnehin.
      log.warn(`Could not fetch VTODO objects from ${collection} for the immediate attempt: ${err.message}`);
    }
  }
  return index;
}

/**
 * Sofortiger Best-Effort-Durchlauf direkt nach einer lokalen Änderung oder
 * Löschung, damit der Server nicht erst beim nächsten Sync-Intervall nachzieht.
 * Fehler sind unkritisch - die Vormerkung bleibt stehen und der Sync holt nach.
 *
 * @param {{createClient?: Function}} [opts] Client-Factory (Tests)
 * @returns {Promise<{deleted:number,updated:number}>}
 */
export async function flushOutbound(opts = {}) {
  return runSerialized('caldav-todo', 'flush', () => runFlushOutbound(opts));
}

async function runFlushOutbound({ createClient } = {}) {
  const total  = { deleted: 0, updated: 0, created: 0 };
  const work   = accountsWithPendingWork();
  if (work.size === 0) return total;

  const makeClient = createClient || createCalDAVClient;
  // Die Quelle einer Mitnahme kann ein anderes Konto sein (#1700).
  const clientFor = async (id) => {
    const other = db.get().prepare('SELECT * FROM caldav_accounts WHERE id = ?').get(id);
    return other ? createTodoClient(other, makeClient) : null;
  };

  for (const [accountId, modules] of work) {
    const account = db.get().prepare('SELECT * FROM caldav_accounts WHERE id = ?').get(accountId);
    if (!account) continue;

    try {
      const client = await createTodoClient(account, makeClient);

      // Vor allem anderen: die Reste nie bestätigter Uploads entfernen
      // (#1882), damit eine Zeile mit neuem Ziel nicht neben ihren Rest geht.
      await releaseLeftoverTodoUploads(client, accountId, { clientFor });

      // Ein Stoppsignal für Löschen, Ändern und Mitnahmen aller Module dieses
      // Kontos (#1863, #2137).
      const stop = createRefusalStop();
      for (const module of modules) {
        const wanted = [
          ...pendingDeletions(accountId, module)
            .filter((r) => r.object_url && !inUnselectedList(accountId, r.object_url))
            .map((r) => ({ uid: r.uid, url: r.object_url })),
          ...pendingUpdates(accountId, module)
            .filter((r) => r.external_object_url)
            .map((r) => ({ uid: r.external_uid, url: r.external_object_url })),
        ];

        const objectIndex = await fetchObjectsByUrl(client, wanted);

        // complete = false: ohne vollen Listenabruf ist "der Server führt das
        // Objekt nicht mehr" nicht belegbar; ein Tombstone ohne bekannte URL
        // bleibt für den Sync liegen.
        total.deleted += await processPendingDeletions(client, accountId, module, objectIndex, false, { stop });
        total.updated += await processPendingUpdates(client, accountId, module, objectIndex, { stop });

        // Uploads brauchen die Collection selbst, nicht einzelne Objekte - und
        // damit den einzigen Listenabruf in diesem Pfad. Er läuft deshalb nur,
        // wenn wirklich etwas wartet.
        if (module === 'tasks' && pendingCreations(accountId, module).length) {
          total.created += await processPendingCreations(
            client, accountId, module, await taskListsOf(client, accountId)
          );
        }

      }
    } catch (err) {
      log.warn(`[Account ${accountId}] Immediate outbound attempt failed: ${err.message}`);
    }
  }
  return total;
}
