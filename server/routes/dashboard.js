/**
 * Modul: Dashboard
 * Zweck: Aggregierter Endpoint - liefert Daten aller Dashboard-Widgets in einem Request
 * Abhängigkeiten: express, server/db.js
 */

import { createLogger } from '../logger.js';
import express from 'express';
import { hydrateNotesWithCategories } from '../services/note-categories.js';
import * as db from '../db.js';
import { hydrateBirthdayOccurrences } from '../services/birthdays.js';
import { getEventsOverlappingDays, getUpcomingEvents } from '../services/calendar-event-reader.js';
import { resolveCalendarSelection } from '../services/calendar-selection.js';
import { taskScopeWhere, taskCategoryWhere, categoryBindings, normalizeCategoryFilter } from '../services/task-scope.js';
import { getCountdowns } from '../services/countdowns.js';
import { listQuickLinksFor } from './quick-links.js';
import {
  asksHouseholdAudience, householdAudienceAnswer, householdAudienceShows, householdVisibleWhere, visibilityWhere,
} from '../services/visibility.js';
import { hiddenModulesFor, requestHasCapability } from '../permissions.js';
import { birthdaysSwitchedOff, modulesLeftOut } from '../services/household-modules.js';
import { documentViewer } from '../services/document-links.js';
import { householdMemberSql, memberOrderSql, memberPositionSql } from '../services/household-members.js';

import { householdTimeZone, utcToWall, todayKey, shiftDateKey } from '../utils/timezone.js';
import { isAdminUser, serializeEvents } from './calendar/helpers.js';
import { isAdminRequest } from '../middleware/require-admin.js';

import { clampEventLimit } from '../../public/utils/dashboard-event-limit.js';
import { personAvatarUrlSql } from '../services/person-avatar.js';

const log = createLogger('Dashboard');

/**
 * WAS EIN GESPERRTES MODUL LIEFERT — und warum das hier steht und nicht in
 * fünfzehn verstreuten Zweigen.
 *
 * Diese Route filterte jede Zeile über `visibilityWhere`, also über die
 * ZEILEN-Privatsphäre (all/assignees/private). Die zweite Achse fehlte: die
 * Modulrechte pro Rolle und Mitglied (#467). Ein Kind, dem der Kalender auf
 * `none` steht, bekam über /dashboard weiterhin Termintitel, Beschreibung, Ort
 * und Anhangsnamen geliefert — die App fiel nicht auf, weil der Browser die
 * Kachel über `canSeeWidget` ausblendet, aber die Daten lagen auf der Leitung,
 * im Netzwerk-Tab und im Service-Worker-Cache. Die SPEC sagt zu #467
 * „Enforcement is server-side"; für diesen Endpoint stimmte das nicht.
 *
 * DIE PFAD-MIDDLEWARE KANN ES NICHT ÜBERNEHMEN. Der Guard in server/index.js
 * schlägt den Pfad in scopes.js nach; /dashboard ergibt den Schlüssel
 * `dashboard`, und der ist kein Permissions-Modul. Der Guard lässt die Anfrage
 * also immer durch — er kennt keinen Endpunkt, der ein Dutzend Module auf
 * einmal ausliefert. Genau deshalb muss die Route selbst aussortieren.
 *
 * ALS TABELLE UND NICHT ALS FALLUNTERSCHEIDUNG JE ZWEIG: welcher Teil der
 * Antwort zu welchem Modul gehört, ist die eigentliche Aussage dieses Fixes,
 * und sie gehört an EINE Stelle, an der sie sich lesen und prüfen lässt. Wer
 * ein Feld hinzufügt, sieht hier, dass es eine Modulzuordnung braucht.
 *
 * Der Wert ist jeweils die LEERE Fassung, nicht das fehlende Feld: die Antwort
 * behält damit ihre Form (`/api/v1` ist zugesagte Oberfläche für Drittmodule),
 * und kein Client stolpert über ein undefined, wo er eine Liste erwartet. Es
 * ist dieselbe Fassung, die auch der Fehlerpfad jedes Blocks schreibt.
 */
const DENIED_PAYLOAD = Object.freeze({
  // Geburtstage gehören zum Kalender-Modul, nicht zu einem eigenen — dieselbe
  // Zuordnung wie in PERMISSION_MODULES (navIds) und im Client (NAV_TO_MODULE).
  calendar: () => ({ upcomingEvents: [], familyEvents: [], weekEvents: [], ...emptyBirthdays() }),
  tasks: () => ({
    urgentTasks: [], openTaskCount: 0, overdueTaskCount: 0,
    memberTodayTasks: [], tasksDoneToday: 0, wallTasks: [],
  }),

  notes: () => ({ pinnedNotes: [], pinnedNotesCount: 0, notesTotal: 0 }),

  // Der Monat bleibt stehen: er ist keine Budgetzahl, sondern der Zeitraum, auf
  // den die Kachel beschriftet ist — und er steht ohnehin im Kalender.
  // Geteilte Ausgaben gehoeren zum Budget-Modul (server/scopes.js fuehrt
  // `split-expenses` als zweiten Praefix von `budget`).
  budget: ({ month }) => ({ budget: emptyBudget(month), splitBalance: emptySplitBalance() }),
  rewards: () => ({ rewards: { view: null, standings: [], participantCount: 0, pending: 0, moneyPending: 0, catalog: [], recent: [] } }),
  health: () => ({
    health: {
      hasMeds: false, dosesTotal: 0, dosesTaken: 0, dosesSkipped: 0,
      nextDose: null, lowStockCount: 0,
    },
    fasting: emptyFastingWidget(),
    nutrition: emptyNutritionWidget(),
  }),
  housekeeping: () => ({
    housekeeping: {
      configured: false, present: false, presentSince: null, workerName: null,
      visitsThisMonth: 0, unpaidAmount: 0, lastVisit: null,
    },
  }),
  // Die zwei Felder des Heute-Blatts (Critique 23.09.2026, P1). Eigene Namen
  // statt `waste`/`schedule`: unter diesen Namen legt der Browser die Slices
  // der Kacheln ab (`ensureWasteSlice`, `ensureScheduleSlice`), und ein
  // gleichnamiges Feld hier liesse sie nie mehr laden.
  waste: () => ({ wastePickups: [] }),
  schedule: () => ({ myShiftsToday: [] }),


});


function emptyAnswer(context) {
  const empty = { users: [], countdowns: [], countdownTotal: 0, quicklinks: [] };
  for (const build of Object.values(DENIED_PAYLOAD)) Object.assign(empty, build(context));
  return empty;
}

/**
 * Die leere Fassung der Geburtstags-Kachel. Eigene Funktion, weil sie zwei
 * Wege hat: das entzogene Kalender-RECHT nimmt sie mit (oben), der
 * Haushaltsschalter `birthdays` nimmt sie allein (#1660, siehe die Route).
 */
function emptyBirthdays() {
  return { birthdays: [], birthdayCount: 0, birthdayTotal: 0, birthdaySoonCount: 0 };
}

/** Wie viele beendete Termine von heute ausserhalb des Deckels mitkommen (#1449). */
const ENDED_TODAY_POOL = 20;

/** Wie viele noch kommende Termine die Familienkarte je Mitglied bekommt (#1449):
 * der naechste eigene heute, einer danach fuer „als Naechstes", und Raum fuer
 * gemeinsame, die die Karte in einer eigenen Zeile zeigt. */
const FAMILY_AHEAD_PER_MEMBER = 6;

function emptyFastingWidget() {
  return {
    settings: { clock_mode: 'auto', zone_mode: 'timer' },
    active: null,
    lastCompleted: null,
  };
}

/**
 * Die leere Naehrwert-Bilanz: kein Ziel, nichts gegessen.
 *
 * `target: null` ist hier die richtige leere Fassung und nicht ein Ziel aus
 * Nullen - "kein Ziel gesetzt" und "Ziel 0" sind zwei verschiedene Aussagen
 * (#1326), und die Kachel sagt bei der ersten "kein Ziel" statt "0 von 0".
 */
function emptyNutritionWidget() {
  const totals = {};
  return { date: null, target: null, totals, entryCount: 0 };
}

function emptySplitBalance() {
  return { net: [], positions: [] };
}

function emptyBudget(month) {
  return {
    month,
    income: 0,
    expenses: 0,
    balance: 0,
    entryCount: 0,
    topExpenseCategory: null,
    topExpenseAmount: 0,
    topExpenses: [],
    savingsGoal: null,
  };
}

const ASSIGNED_USERS_SQL = `(
  SELECT json_group_array(json_object(
    'id', u.id, 'display_name', u.display_name, 'color', u.avatar_color,
    'avatar_data', ${personAvatarUrlSql('u')}
  ))
  FROM task_assignments ta JOIN users u ON u.id = ta.user_id
  WHERE ta.task_id = t.id
) AS assigned_users_json`;

function addAssignedUsers(task) {
  task.assigned_users = task.assigned_users_json ? JSON.parse(task.assigned_users_json) : [];
  delete task.assigned_users_json;
  return task;
}

/**
 * Die Felder eines Termins, die der Wochenstreifen braucht: Tag(e), Farbe nach
 * der Regel aus public/utils/event-color.js und der Titel fuer den
 * Tagesnamen - der Geburtstag mit den Feldern, aus denen der Browser ihn
 * uebersetzt (#524).
 */
function weekEventFields(event) {
  return {
    id: event.id,
    title: event.title,
    start_datetime: event.start_datetime,
    end_datetime: event.end_datetime ?? null,
    all_day: event.all_day ? 1 : 0,
    color: event.color ?? null,
    cal_color: event.cal_color ?? null,
    assigned_to: event.assigned_to ?? null,
    assigned_users: (event.assigned_users ?? []).map((user) => ({
      id: user.id, display_name: user.display_name, color: user.color,
    })),
    birthday_name: event.birthday_name ?? null,
    birthday_date: event.birthday_date ?? null,
    birthday_event_kind: event.birthday_event_kind ?? null,
  };
}

/** So viele Titel je Mitglied und Zustand reisen mit; die Zahlen daneben sind ungekappt. */
const WALL_TASKS_PER_MEMBER = 6;


function wallTasksByMember(d, { today, zone, now, categoryAnd = '', categoryBinds = {} }) {
  // Grobe Vorauswahl in SQL (48 Stunden decken jede Zone), der Tag selbst wird
  // unten in der Haushaltszone entschieden.
  const since = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();
  const rows = d.prepare(`
    SELECT ta.user_id AS user_id, t.id, t.title, t.status, t.due_date, tc.completed_at
    FROM tasks t
    JOIN task_assignments ta ON ta.task_id = t.id
    LEFT JOIN task_completions tc ON tc.task_id = t.id
    WHERE t.archived_at IS NULL
      AND t.visibility = 'all'
      AND t.due_date IS NOT NULL AND t.due_date <= @today
      AND ${taskScopeWhere('t', { bind: '@today' })}${categoryAnd}
      AND (t.status != 'done' OR t.due_date = @today OR tc.completed_at >= @since)
    ORDER BY
      t.due_date ASC,
      t.due_time IS NULL ASC, t.due_time ASC,
      CASE t.priority
        WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2
        WHEN 'low' THEN 3 ELSE 4
      END ASC,
      t.id ASC
  `).all({ today, since, ...categoryBinds });

  const byMember = new Map();
  for (const row of rows) {
    const isDone = row.status === 'done';
    if (isDone && row.due_date !== today
      && utcToWall(row.completed_at, zone)?.date !== today) continue;
    let entry = byMember.get(row.user_id);
    if (!entry) {
      entry = { user_id: row.user_id, open_count: 0, done_count: 0, open: [], done: [] };
      byMember.set(row.user_id, entry);
    }
    if (isDone) {
      entry.done_count += 1;
      if (entry.done.length < WALL_TASKS_PER_MEMBER) entry.done.push({ id: row.id, title: row.title });
    } else {
      entry.open_count += 1;
      if (entry.open.length < WALL_TASKS_PER_MEMBER) {
        entry.open.push({ id: row.id, title: row.title, due_date: row.due_date });
      }
    }
  }
  return [...byMember.values()];
}

const router = express.Router();


router.get('/', (req, res) => {
  try {
  const d = db.get();
  const result = {};
  const userId = req.authUserId || req.session.userId;

  /* WIDGET-OPTIONEN KOMMEN ALS QUERY-PARAMETER, NICHT AUS DEM GESPEICHERTEN
   * LAYOUT (#814). Der Server kennt die Widget-Ids bewusst nicht - sie gehören
   * dem Frontend, und ein neues Widget soll keine Backend-Änderung kosten. Er
   * speichert `options` deshalb nur als Form und versteht hier ausschliesslich
   * die zwei Achsen, die er ohnehin abfragen kann.
   *
   * SIE WIRKEN AUF DIE GANZE ÜBERSICHT, nicht auf eine Kachel. Aufgaben stehen
   * hier an vier Stellen (Liste, Kennzahl, „heute dran" je Mitglied, das
   * Kopfband) und Termine an dreien; würde eine Auswahl nur die Liste
   * einschränken, stünden zwei Zeilen unter einer Kachel, die sieben sagt -
   * derselbe Fehler wie in #647, eine Ebene höher.
   *
   * Und sie wirken VOR der Deckelung, weil jede dieser Abfragen ihr eigenes
   * LIMIT trägt.
   *
   * AUSGENOMMEN SIND DIE COUNTDOWNS (#647), und zwar bewusst: dort steht keine
   * Aufgabe, weil sie in einer Liste vorkommt, sondern weil jemand sie
   * ausdrücklich markiert hat. Eine Kategorie-Auswahl, die eine markierte
   * Aufgabe wieder verschwinden lässt, nähme eine Entscheidung zurück, die
   * jemand ausdrücklich getroffen hat. */
  const taskCategories = normalizeCategoryFilter(req.query.tasks_category);
  const taskCategoryFragment = taskCategoryWhere('t', taskCategories, { named: 'cat' });
  const taskCategoryAnd = taskCategoryFragment ? ` AND ${taskCategoryFragment}` : '';
  const taskCategoryBinds = categoryBindings(taskCategories, 'cat');
  const noteCategories = [...new Set(
    (Array.isArray(req.query.notes_category) ? req.query.notes_category : [req.query.notes_category])
      .map(Number)
      .filter((id) => Number.isInteger(id) && id > 0),
  )].slice(0, 50);
  const noteCategoryBinds = Object.fromEntries(noteCategories.map((id, index) => [`note_category_${index}`, id]));
  // Ein EXISTS je Auswahl ist absichtlich AND. Die Sichtbarkeitsbedingung im
  // Unterselect verhindert, dass erratene IDs fremder persoenlicher Kategorien
  // verraten, an welchen geteilten Notizen sie haengen.
  const noteCategoryAnd = noteCategories.map((_id, index) => `
    AND EXISTS (
      SELECT 1
      FROM note_category_assignments nca
      JOIN note_categories nc ON nc.id = nca.category_id
      WHERE nca.note_id = n.id
        AND nc.id = @note_category_${index}
        AND (nc.scope = 'household' OR nc.owner_user_id = @me)
    )
  `).join('');

  const householdAudience = asksHouseholdAudience(req.query);
  const taskVisibleSql = householdAudience
    ? householdVisibleWhere('t')
    : visibilityWhere('t', 'task_assignments', 'task_id', '@me');
  // `mine` ist die Auslegung des Kalendermoduls: zugewiesen an mich.
  // EIN DISPLAY HAT KEIN "MIR" (#1808): es folgt der Vorgabe des Haushalts, sein
  // Browser schickt deren Option mit, und dem Display-Konto weist nie jemand
  // einen Termin zu (#1207) - das Tablett stuende leer da. Gelesen wird die
  // Option deshalb HIER als "alle", statt sie beim Speichern der Vorgabe zu
  // streichen: dieselbe Vorgabe gilt auch fuer Mitglieder, und dort stimmt sie.
  // DIESELBE ANTWORT GILT FUER JEDE WAND (#1817): mit `audience=household` gibt
  // es kein "mich", auch nicht aus der Sitzung eines Mitglieds.
  const eventsAssignedTo = req.query.events_scope === 'mine' && req.authMethod !== 'display' && !householdAudience
    ? userId : null;
  /* GEBURTSTAGE IM TERMIN-WIDGET (#927). Wer sie auf der Uebersicht schon als
   * eigene Kachel stehen hat, las sie zweimal - einmal bei den Geburtstagen,
   * einmal zwischen den naechsten Terminen. Abwaehlbar ist deshalb der EINE
   * Ort, an dem sie mitlaufen, statt dass die Kachel danebensteht.
   *
   * NICHT UEBERNOMMEN WIRD DER FILTER DES KALENDERMODULS, obwohl die Anfrage
   * dorthin zeigte: der Ebenen-Schalter dort liegt im localStorage und gilt
   * fuer das Geraet, die Widget-Optionen liegen in den Einstellungen und gelten
   * fuer das Konto. Ein Wert an zwei Orten mit zwei Reichweiten waere die
   * teurere Antwort - am Wandtablet haette das Abwaehlen am Telefon gewirkt
   * oder eben nicht, je nachdem, welchen der beiden man liest.
   *
   * Der Standard bleibt „mit Geburtstagen": ein Filter wirkt nur, wo jemand ihn
   * gesetzt hat. Der Parameter reist deshalb nur in seiner einen Richtung. */
  // Den Haushaltsschalter (#1660) kennt der geteilte Leser selbst: sind die
  // Geburtstage abgeschaltet, laufen sie nicht mit, was immer hier steht.
  const includeBirthdays = req.query.events_birthdays !== 'hide';
  // Wie viele Kommende die Kachel listet (#1680): 5, 8 oder 12 aus einer
  // Allowlist, die der Browser mit dieser Route teilt. Alles andere - fehlend,
  // leer, `7`, `500`, `abc`, doppelt angegeben - ist die Vorgabe fuenf.
  const eventsLimit = clampEventLimit(req.query.events_limit);
  /* WELCHE KALENDER DIE KACHEL ZEIGT (#2062, aus D#2037). `events_calendar`
   * nennt Kalender-Schluessel (`local:N`, `cal:N`, `sub:N`, die des
   * Kalendermoduls); ohne den Parameter bleibt alles, wie es war.
   *
   * DIE ACHSE DER ANDEREN KALENDER-OPTIONEN, nicht die der Einkaufs-Kachel:
   * „nur meine" und die Geburtstage wirken auf die Termine der ganzen
   * Uebersicht (Liste, Wochenstreifen, Heute-Blatt), und die Wand liest
   * dieselbe Einstellung aus der Vorgabe des Haushalts. Eine Kalender-Auswahl,
   * die nur die Liste traefe, liesse den Streifen derselben Kachel Termine
   * zeigen, die die Liste verschweigt. Die Familienkarte bleibt ungefiltert:
   * sie ist eine eigene Kachel und zeigt je Mitglied, was ansteht.
   *
   * GEPRUEFT WIRD GEGEN DEN KATALOG (services/calendar-selection.js), nicht nur
   * die Form: ein Kalender, den es nicht mehr gibt, faellt aus der Auswahl, und
   * bleibt keiner uebrig, gilt die Anfrage als ungefiltert - keine Auswahl
   * heisst „alle", nie eine leere Kachel. Ohne Zugang zum Kalender laeuft
   * keiner der Leser, die Auswahl bleibt also folgenlos. */
  let eventCalendars = null;
  try {
    eventCalendars = resolveCalendarSelection(d, req.query.events_calendar, userId);
  } catch (err) {
    log.error('calendar selection error:', err.message);
  }

  const now = new Date();

  // Lokaler Datums-/Wochentagsschlüssel: die Fälligkeit einer Dosis hängt am lokalen
  // Kalendertag (nicht UTC), sonst driftet die days_mask westlich von UTC um einen Tag.
  // Konvention wie public/utils/health-meds.js: Montag = 0 … Sonntag = 6.
  //
  // Dieser Schlüssel gilt für ALLES, was der Nutzer als Kalendertag eingegeben hat -

  // daneben ein zweites `todayStr` aus `toISOString()`, also den UTC-Tag, und verglich
  // ihn mit lokal gespeicherten Werten. Östlich von UTC lieferte das Dashboard dadurch

  // 02:00), westlich davon am späten Abend die von morgen; am Monatsersten traf es
  // zusätzlich den Budget-Monat. Die CI läuft in UTC, wo beide Schlüssel gleich sind -
  // deshalb war der Fehler dort nie zu sehen (CLAUDE.md führt genau diese Falle).
  //
  // Seit #829 ist "lokal" nicht mehr die Zone des Containers, sondern die des
  // HAUSHALTS (sync_config `household_timezone`, Rueckfall `TZ`). Der Unterschied
  // zaehlt genau dann, wenn beide auseinanderfallen - und `TZ` ist auf Umbrel,
  // TrueNAS oder Unraid nichts, was ein Nutzer erreicht. Datum, Uhrzeit und
  // Wochentag kommen deshalb aus EINER Ablesung dieser einen Zone; drei getrennte
  // Ableitungen waeren drei Gelegenheiten, an einer Tagesgrenze auseinanderzulaufen.
  const householdWall = utcToWall(now.toISOString(), householdTimeZone(d));
  const todayLocalKey = householdWall?.date
    ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  // Wochentag aus dem Schluessel statt aus `now`: `getDay()` laese die Zone des
  // Containers und widerspraeche dem Tag darüber, sobald die beiden abweichen.
  const localWeekdayIdx = (new Date(`${todayLocalKey}T00:00:00Z`).getUTCDay() + 6) % 7;
  const currentMonth = todayLocalKey.slice(0, 7);
  const deadline48h = new Date(now.getTime() + 48 * 60 * 60 * 1000).toISOString();

  // Modulrechte des Betrachters (#467, siehe DENIED_PAYLOAD oben). Gelesen aus
  // dem, was die Auth-Schicht schon aufgelöst hat: null für Admins und für
  // unbeschränkte Mitglieder. Was gesperrt ist, steht vor der ersten Abfrage
  // fest und wird gar nicht erst geholt - ein nachgelagerter Filter hätte die
  // Daten erst gelesen und dann weggeworfen.
  //
  // Dazu die Scopes eines API-Tokens: `dashboard:read` öffnet die Übersicht,
  // nicht die Module darin. Eine Kachel, deren Modul das Token nicht lesen darf,
  // kommt in derselben leeren Fassung wie bei einer Rollensperre.
  const denied = hiddenModulesFor(req, Object.keys(DENIED_PAYLOAD));

  // (#1903): das Heute-Blatt auf der Wand braucht diese Quellen, aber das
  // Display-Credential hat keinen Modulzugang. Die fuenf Schluessel werden VOR
  // `modulesLeftOut` aus `denied` entfernt, NICHT danach aus `leftOut` - so

  // fuegt `modulesLeftOut` sie aus `householdDisabledModules` wieder hinzu.
  const isDisplay = req.authMethod === 'display';
  if (isDisplay && householdAudience) {
    for (const key of ['housekeeping', 'waste']) {
      denied.delete(key);
    }
  }
  // UND DER HAUSHALTSSCHALTER (#1660, docs/DECISIONS.md 11). Bis dahin fragte
  // diese Stelle nur nach Rechten und Scopes: ein haushaltsweit abgeschaltetes
  // Modul lieferte seine Termine, Aufgaben, Buchungen und Medikamente weiter
  // aus, und nur der Browser liess die Kachel weg. Abschalten ist keine Sperre -
  // die eigenen Routen des Moduls bleiben offen -, aber was der Server
  // ungefragt in eine gemischte Antwort legt, folgt dem Schalter. Beide Achsen
  // in EINEM Set, damit jede Abfrage unten dieselbe Frage stellt; die leere
  // Fassung ist dieselbe wie bei einer Sperre, die Form der Antwort bleibt.
  const leftOut = modulesLeftOut(d, denied);
  // Die dritte Achse (#1817): ein Modul, von dem die Haushaltsfassung keinen
  // Schluessel traegt, wird gar nicht erst gelesen. Im SELBEN Set, damit jede
  // Abfrage unten weiter eine einzige Frage stellt. Abgeleitet aus der
  // Allowlist und nicht als zweite Liste gefuehrt - die Regel selbst setzt das
  // Ende der Route durch (`householdAudienceAnswer`), das hier spart nur die
  // Abfragen, deren Ergebnis dort ohnehin leer herauskaeme.
  if (householdAudience) {
    for (const [key, build] of Object.entries(DENIED_PAYLOAD)) {
      if (!Object.keys(build({ month: currentMonth })).some(householdAudienceShows)) leftOut.add(key);
    }
  }
  for (const key of leftOut) Object.assign(result, DENIED_PAYLOAD[key]?.({ month: currentMonth }));
  const allows = (moduleKey) => !leftOut.has(moduleKey);
  // Dasselbe fuer die Schluessel, die keinem Modul gehoeren (Countdowns,
  // Schnellzugriffe, die Auswahl der Einkaufs-Kachel).
  const wants = (key) => !householdAudience || householdAudienceShows(key);
  // GEBURTSTAGE HABEN ZWEI WEGE. Als RECHT gehoeren sie zum Kalender (siehe
  // DENIED_PAYLOAD), als SCHALTER sind sie ein eigenes Modul - dieselbe
  // Unterscheidung wie bei den Erinnerungen (reminder-origins.js). Ein
  // abgeschalteter Kalender nimmt einem Haushalt mit eingeschalteten
  // Geburtstagen die Kachel deshalb nicht weg; die leere Fassung, die der
  // Kalender-Eintrag oben eben geschrieben hat, ueberschreibt der Block unten.
  const birthdaysLeftOut = denied.has('calendar') || birthdaysSwitchedOff(d);
  if (birthdaysLeftOut) Object.assign(result, emptyBirthdays());

  // Anstehende Termine (nächste 5, 8 oder 12, ab jetzt).
  // Geteilte Logik mit /calendar/upcoming: expandiert wiederkehrende Serien,
  // sodass auch Termine erscheinen, deren Master-Start in der Vergangenheit liegt.
  if (allows('calendar')) try {
    // Der Deckel (fuenf, auf Wunsch 8 oder 12, #1680) zaehlt nur, was noch kommt (#1449); beendete Termine
    // von heute kommen ausserhalb mit - die Kachel zeigt sie zurueckgetreten,
    // das Heute-Blatt laesst sie weg. Welche beendet sind, entscheidet der
    // Browser an der Uhr: ein Termin endet auch zwischen zwei Abrufen.
    result.upcomingEvents = serializeEvents(getUpcomingEvents(d, {
      userId, limit: eventsLimit, fromToday: true, assignedTo: eventsAssignedTo, includeBirthdays,
      keepEndedToday: ENDED_TODAY_POOL, household: householdAudience, calendars: eventCalendars,
    }), { database: d, viewer: documentViewer(req), actorId: userId, isAdmin: isAdminUser(req) });
  } catch (err) {
    log.error('upcomingEvents error:', err.message);
    result.upcomingEvents = [];
  }

  /* DIE WOCHE FUER DEN STREIFEN des Kalender-Widgets (2x1). Eigene Frage neben
   * der Liste darueber: dort „was beginnt als Naechstes", hier „was findet an
   * den sieben Tagen ab heute statt" - auch was vorgestern begann und noch
   * laeuft (getEventsOverlappingDays).
   *
   * IMMER MITGELIEFERT, nicht nur auf Anfrage: der Anpassen-Modus schaltet die
   * Groesse als Vorschau um, ohne neu zu laden, und ein Streifen ohne Daten
   * hiesse dort „leere Woche" - ein plausibles Falsches. Die Kosten haelt die
   * Form klein: nur, was ein Punkt oder ein Band braucht, ohne Beschreibung,
   * Ort und Anhaenge.
   *
   * Dieselben Filter wie die Liste (Sichtbarkeit, „nur meine", Geburtstage)
   * und dieselbe Modulsperre ueber DENIED_PAYLOAD. Das Fenster hat einen Tag
   * Rand je Seite; welcher Tag ein Termin ist, entscheidet der Browser in
   * seiner Anzeigezone und klammert dort auf die sieben. */
  if (allows('calendar')) try {
    result.weekEvents = serializeEvents(getEventsOverlappingDays(d, {
      userId, fromKey: shiftDateKey(todayLocalKey, -1), days: 9,
      assignedTo: eventsAssignedTo, includeBirthdays, household: householdAudience, calendars: eventCalendars,
    }), { database: d, viewer: documentViewer(req), actorId: userId, isAdmin: isAdminUser(req) })
      .map(weekEventFields);
  } catch (err) {
    log.error('weekEvents error:', err.message);
    result.weekEvents = [];
  }

  // Offene Aufgaben: Sortierung in SQL (overdue zuerst, dann Fälligkeit, dann Priorität).
  // Faithful translation of the previous JS comparator:
  //   1. overdue (due_sort < now) before not-overdue
  //   2. within a group: earlier due date/time first; undated tasks last (NULLS LAST)
  //   3. ties broken by priority rank (urgent=0..none=4)
  // due_sort = due_date + due_time, falling back to 23:59:59 when only a date is set,
  // and NULL when there is no due_date at all.
  if (allows('tasks')) try {
    // Lokal, nicht UTC: verglichen wird gegen `due_date || 'T' || due_time`, und
    // beide stehen als lokale Eingabewerte in der DB. Ein UTC-Zeitstempel verschob
    // die Grenze „überfällig" um den Zonen-Offset.
    const nowIso = `${todayLocalKey}T${householdWall?.time
      ?? `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`}`;
    result.urgentTasks = d.prepare(`
      SELECT t.*, u.display_name AS assigned_name, u.avatar_color AS assigned_color,
        ${ASSIGNED_USERS_SQL},
        CASE WHEN t.due_date IS NULL THEN NULL
             ELSE t.due_date || 'T' || COALESCE(t.due_time, '23:59:59')
        END AS __due_sort
      FROM tasks t
      LEFT JOIN users u ON t.assigned_to = u.id
      WHERE t.status != 'done'
        -- Abgelegtes gehört nicht in „Heute auf einen Blick" (#688): eine
        -- archivierte Aufgabe ist aus dem Lauf genommen, und wer sie von hier aus
        -- öffnete, fand sie in der Liste nicht wieder.
        AND t.archived_at IS NULL
        AND ${taskScopeWhere('t', { bind: '@today' })}
        AND ${taskVisibleSql}${taskCategoryAnd}
      ORDER BY
        CASE WHEN __due_sort IS NOT NULL AND __due_sort < @now THEN 0 ELSE 1 END ASC,
        __due_sort IS NULL ASC,
        __due_sort ASC,
        CASE t.priority
          WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2
          WHEN 'low' THEN 3 ELSE 4
        END ASC
      LIMIT 5
    `).all({ now: nowIso, me: userId, today: todayLocalKey, ...taskCategoryBinds }).map(({ __due_sort, ...task }) => addAssignedUsers(task));
  } catch (err) {
    log.error('urgentTasks error:', err.message);
    result.urgentTasks = [];
  }

  // ZÄHLSTÄNDE FÜR DIE KENNZAHL-KACHELN.
  //
  // Sie lassen sich NICHT aus den Listen oben ableiten: `urgentTasks` schneidet

  // zählte, zeigte auf der Kachel „5 offen", solange zwölf offen sind - eine
  // Zahl, die genau bis zu ihrer Obergrenze stimmt, ist die gefährlichste Sorte.
  // Sichtbarkeit wie überall: der Betrachter zählt nur, was er sehen darf.
  if (allows('tasks')) try {
    result.openTaskCount = d.prepare(`
      SELECT COUNT(*) AS n FROM tasks t
      WHERE t.status != 'done' AND t.archived_at IS NULL
        AND ${taskScopeWhere('t', { bind: '@today' })}
        AND ${taskVisibleSql}${taskCategoryAnd}
    `).get({ me: userId, today: todayLocalKey, ...taskCategoryBinds }).n;
  } catch (err) {
    log.error('openTaskCount error:', err.message);
    result.openTaskCount = null;
  }

  // Überfällig ist die Zweitzeile der Aufgaben-Kachel: „7 offen" allein sagt
  // nicht, ob etwas brennt.
  if (allows('tasks')) try {
    result.overdueTaskCount = d.prepare(`
      SELECT COUNT(*) AS n FROM tasks t
      WHERE t.status != 'done' AND t.archived_at IS NULL
        AND t.due_date IS NOT NULL AND t.due_date < @today
        AND ${taskScopeWhere('t', { bind: '@today' })}
        AND ${taskVisibleSql}${taskCategoryAnd}
    `).get({ today: todayLocalKey, me: userId, ...taskCategoryBinds }).n;
  } catch (err) {
    log.error('overdueTaskCount error:', err.message);
    result.overdueTaskCount = null;
  }

  // Displays zeigen nur, was die Wand-Zeile braucht: Datum, Typ, Titel und Koch.
  // `notes` und `created_by` bleiben zurueck (#1903).


  // Neueste Notizen (gepinnte zuerst, dann aktuellste)
  if (allows('notes')) try {
    result.pinnedNotes = d.prepare(`
      SELECT n.*, u.display_name AS author_name, u.avatar_color AS author_color
      FROM notes n
      LEFT JOIN users u ON n.created_by = u.id
      WHERE 1 = 1 ${noteCategoryAnd}
      ORDER BY n.pinned DESC, n.updated_at DESC
      -- FUENF, WEIL DIE KACHEL ZWEI HOCH SEIN DARF - dieselbe Korrektur, die
      -- die Geburtstage oben schon bekommen haben und bei der die Notizen
      -- uebersehen wurden. Der Schnitt stand auf drei und war damit die
      -- Obergrenze fuer JEDE Kachelgroesse; die Notizkachel startet ab Werk auf
      -- 1x2, hat also Platz fuer fuenf Zeilen und bekam trotzdem nur drei
      -- geliefert. Wie viele wirklich erscheinen, entscheidet die Kachel
      -- (listRowCap in public/pages/dashboard.js) - der Server liefert nur
      -- den Vorrat fuer die groesste Fassung.
      LIMIT 5
    `).all({ me: userId, ...noteCategoryBinds });
    result.pinnedNotes = hydrateNotesWithCategories(d, result.pinnedNotes, userId);
    /* `pinnedNotes` HEISST SO, IST ES ABER NICHT: die Liste sortiert Gepinntes
     * nach vorn und schneidet bei drei ab - sie filtert nicht. Fuer die Vorschau
     * ist das richtig (sie zeigt, was oben liegt), als ZAHL war es zweimal
     * falsch: ein Haushalt ohne einen einzigen Pin las "3 angepinnt", einer mit
     * fuenf Pins ebenfalls "3" (Codex-Review zu PR #754). Die Kennzahlkachel
     * braucht deshalb eine eigene, echte Zahl. */
    result.pinnedNotesCount = d.prepare(`
      SELECT COUNT(*) AS n FROM notes n
      WHERE n.pinned = 1 ${noteCategoryAnd}
    `).get({ me: userId, ...noteCategoryBinds }).n;
    /* UND DIE MENGE, AUS DER DIE VORSCHAU SCHOEPFT - fuer die Badge und das
     * „+N weitere" der Kachel. `pinnedNotesCount` ist dafuer die falsche Zahl:
     * die Vorschau fuellt nach den angehefteten mit den neuesten auf, eine Badge
     * „1" ueber drei Karten waere derselbe Widerspruch wie vorher die „3" bei
     * fuenf angehefteten. Derselbe Kategoriefilter wie Liste und Pin-Zahl
     * (#814: Filter vor Schnitt UND Zahl). */
    result.notesTotal = d.prepare(`
      SELECT COUNT(*) AS n FROM notes n
      WHERE 1 = 1 ${noteCategoryAnd}
    `).get({ me: userId, ...noteCategoryBinds }).n;
  } catch (err) {
    log.error('pinnedNotes error:', err.message);
    result.pinnedNotes = [];
    result.pinnedNotesCount = 0;
    result.notesTotal = 0;
  }

  // Einkaufslisten mit offenen Artikeln (max. 3 Listen, je bis zu 6 offene Items).
  // Immer ueber ALLE Listen - was ausserhalb der Kachel vom Einkauf spricht,
  // liest dieses Feld und die beiden Zaehler oben.

  // DIE FASSUNG DER KACHEL (#1818), nur bei einer Auswahl. Die gewaehlten
  // Listen stehen da, AUCH OHNE OFFENES: wer eine Liste auf die Uebersicht
  // holt, will sie antippen, um den ersten Artikel einzutragen - genau dann
  // waere sie sonst verschwunden. Listen mit Offenem zuerst, damit der Deckel
  // von drei keine volle Liste hinter einer leeren versteckt; darin wie bisher
  // die zuletzt geaenderte.
  //
  // `listCount` zaehlt JEDE gewaehlte Liste, die es gibt - auch die ohne
  // Offenes. Daraus rechnet die Kachel "+n weitere Listen": eine gewaehlte
  // Liste, die der Deckel abschneidet, ist so als "+1" da und fehlt nie stumm.
  //
  // Scheitert die Abfrage, fehlt das Feld, und die Kachel zeigt alle Listen.


  // Alle User (für Avatar-Farben in Widgets)
  try {
    result.users = d.prepare(
      `SELECT u.id, u.display_name, u.avatar_color, u.avatar_data, ${memberPositionSql('u')} AS sort_order FROM users u
       WHERE ${householdMemberSql('u')}
       ORDER BY ${memberOrderSql('u')}`
    ).all();
  } catch (err) {
    result.users = [];
  }

  /* DIE FAMILIENKARTE HAT EIGENE TERMINE (#1449). Sie lieh sich die Liste der
   * Termin-Kachel: fuenf Kommende fuer den ganzen Haushalt und deren „nur
   * meine". An einem vollen Tag fiel so der Abendtermin eines Kindes heraus,
   * und mit „nur meine" standen alle anderen als „heute frei" da. Hier fragt
   * deshalb jedes Mitglied fuer sich: was heute war (die beendeten, damit
   * „fuer heute durch" von „frei" zu unterscheiden ist) und die naechsten
   * kommenden.
   *
   * „NUR MEINE" GILT HIER NICHT - die Karte zeigt jedes Mitglied, das ist ihr
   * Zweck (Empfehlung in #1449). Sichtbarkeit und abgewaehlte Geburtstage
   * gelten wie ueberall: der Betrachter sieht nur, was er sehen darf. */
  if (allows('calendar')) try {
    const seen = new Set();
    const merged = [];
    for (const member of result.users) {
      for (const event of getUpcomingEvents(d, {
        userId, limit: FAMILY_AHEAD_PER_MEMBER, fromToday: true, assignedTo: member.id, includeBirthdays,
        keepEndedToday: ENDED_TODAY_POOL, household: householdAudience,
      })) {
        const key = `${event.id}@${event.start_datetime}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(event);
      }
    }
    merged.sort((a, b) => String(a.start_datetime).localeCompare(String(b.start_datetime)));
    result.familyEvents = serializeEvents(merged, { database: d, viewer: documentViewer(req), actorId: userId, isAdmin: isAdminUser(req) });
  } catch (err) {
    log.error('familyEvents error:', err.message);
    result.familyEvents = [];
  }

  if (!birthdaysLeftOut) try {
    // family_user_color: die Identitaetsfarbe des verknuepften Mitglieds. Das
    // Widget zeigt Familien-Geburtstage damit in derselben Farbsprache wie die
    // Familien-Kachel; Kontakte ohne Verknuepfung bleiben NULL und behalten im
    // Frontend die neutrale Modul-Toenung (Etappe 4, Critique 2026-08-17).
    const rows = d.prepare(`
      SELECT b.*, u.avatar_color AS family_user_color
        FROM birthdays b
        LEFT JOIN users u ON u.id = b.family_user_id
       ORDER BY b.name COLLATE NOCASE ASC
    `).all();
    const hydrated = rows
      .flatMap((row) => hydrateBirthdayOccurrences(d, row))
      .sort((a, b) => a.days_until - b.days_until
        || a.name.localeCompare(b.name)
        || a.kind.localeCompare(b.kind));

    /* DIE ZAHL FUERS NAV-BADGE, UNGEDECKELT (#868).
     *
     * Sie darf NICHT aus `result.birthdays` abgeleitet werden: die Liste ist
     * gleich auf fuenf geschnitten, und das ist der Vorrat der KACHEL, keine
     * Aussage ueber den Bestand. Ein Haushalt mit sieben Geburtstagen in drei
     * Tagen bekaeme sonst beim Start eine Fuenf am Nav-Ziel und nach dem
     * ersten Besuch der Seite eine Sieben - dieselbe Frage, zwei Antworten.
     *
     * Der Schnitt bei DREI Tagen ist derselbe wie im Browser
     * (`BIRTHDAY_BADGE_DAYS` in public/utils/nav-badges.js); ein Guard haelt
     * beide zusammen. */
    result.birthdaySoonCount = hydrated.filter((b) => (b.days_until ?? 9999) <= 3).length;

    result.birthdays = hydrated
      // FUENF, WEIL DIE KACHEL ZWEI HOCH SEIN DARF. Der Schnitt stand auf drei
      // und war damit die Obergrenze fuer JEDE Kachelgroesse: in der
      // 1x2-Standardgroesse blieb darunter rund ein Drittel der Karte leer, weil
      // der Server gar nicht mehr hergab. Wie viele Zeilen wirklich erscheinen,
      // entscheidet die Kachel (`listRowCap` in public/pages/dashboard.js) - der
      // Server liefert nur den Vorrat fuer die groesste Fassung.
      .slice(0, 5);
    result.birthdayCount = rows.length;
    // Die Liste zaehlt ANLAESSE (Geburtstag und Namenstag je eine Zeile),
    // `birthdayCount` die Personen. Badge und „+N weitere" der Kachel brauchen
    // die Menge, aus der die Liste geschnitten ist - sonst stimmt der Rest nur,
    // solange niemand einen Namenstag hat.
    result.birthdayTotal = hydrated.length;
  } catch (err) {
    log.error('birthdays error:', err.message);
    result.birthdays = [];
    result.birthdayCount = 0;
    result.birthdayTotal = 0;
    result.birthdaySoonCount = 0;
  }

  // Countdowns (#647): Termine und Aufgaben, die jemand als Countdown markiert
  // hat, in EINER nach Nähe sortierten Liste. `todayLocalKey` und nicht der
  // UTC-Tag: „noch 1 Tag" gegenüber „heute" entscheidet sich am Kalendertag des
  // Betrachters, und westlich von UTC ist der ein anderer.
  //
  // DER EINZIGE TEIL DER ANTWORT, DER ZWEI MODULEN GEHÖRT, und deshalb steht
  // seine Sperre nicht als Zeile in DENIED_PAYLOAD, sondern als Argument: wem
  // der Kalender entzogen ist, dem fallen die Termin-Countdowns heraus und die
  // Aufgaben-Countdowns bleiben. Ein Alles-oder-nichts hätte die Kachel schon
  // beim Sperren EINES der beiden Module verschwinden lassen - dieselbe Falle,
  // die der haushaltweite Modulschalter im Review zu PR #793 gestellt hat. Die
  // Gesamtzahl entsteht in `getCountdowns` hinter demselben Filter, damit
  // Schnitt und Zahl dieselbe Menge meinen.
  if (wants('countdowns')) try {
    const countdowns = getCountdowns(d, {
      userId,
      todayKey: todayLocalKey,
      hiddenModules: denied,
    });
    result.countdowns = countdowns.items;
    // Wie `birthdayCount` neben `birthdays`: die Liste ist der Vorrat für die
    // größte Kachelfassung, die Zahl ist die Wahrheit über den Bestand.
    result.countdownTotal = countdowns.total;
  } catch (err) {
    log.error('countdowns error:', err.message);
    result.countdowns = [];
    result.countdownTotal = 0;
  }

  // Schnellzugriffe (#469): die Kachelreihe kommt mit der Uebersichts-Antwort
  // mit, statt einen zweiten Request beim Seitenaufbau zu kosten - es ist eine
  // kurze Liste, die genau hier gebraucht wird.
  //
  // KEINE ZEILE IN DENIED_PAYLOAD, und das ist kein Vergessen: ein Schnellzugriff
  // gehoert keinem Modul (siehe PERMISSION_WIDGETS). Die Achse, die er hat, ist
  // geteilt gegen privat, und die setzt `listQuickLinksFor` ueber die anfragende
  // Person durch - eine fremde private Kachel liegt also auch dann nicht auf der
  // Leitung, wenn der Browser sie nie zeichnen wuerde.
  if (wants('quicklinks')) try {
    result.quicklinks = listQuickLinksFor(userId, req.authRole === 'admin');
  } catch (err) {
    log.error('quick links error:', err.message);
    result.quicklinks = [];
  }

  // Vorrat „läuft bald ab" (Critique 2026-09-23): Chargen mit abgelaufenem oder
  // bald erreichtem MHD, haushaltsweit wie der Vorrat selbst (kein


  // Fehler setzt `null` - die Kachel zeigt dann „erneut versuchen" statt einer
  // leeren Liste, die „nichts laeuft ab" behaupten wuerde.

  // Displays erhalten nur den Namen: Menge, Einheit und Ort sind interne
  // Kennzahlen und gehoeren nicht an die Wand (#1903).


  // „Heute dran"-Karte: pro Mitglied die Zahl der heute fälligen oder über-
  // fälligen offenen Aufgaben. Eigene Aggregation statt Zählung aus urgentTasks,
  // dessen 5er-Limit die Zahlen je Mitglied verfälschen würde. Sichtbarkeit wie
  // überall: der Betrachter zählt nur, was er sehen darf.
  if (allows('tasks')) try {
    result.memberTodayTasks = d.prepare(`
      SELECT ta.user_id AS user_id, COUNT(*) AS open_count
      FROM tasks t JOIN task_assignments ta ON ta.task_id = t.id
      WHERE t.status != 'done' AND t.archived_at IS NULL
        AND t.due_date IS NOT NULL AND t.due_date <= @today
        AND ${taskScopeWhere('t', { bind: '@today' })}
        AND ${taskVisibleSql}${taskCategoryAnd}
      GROUP BY ta.user_id
    `).all({ today: todayLocalKey, me: userId, ...taskCategoryBinds });
  } catch (err) {
    log.error('memberTodayTasks error:', err.message);
    result.memberTodayTasks = [];
  }

  // Die Wand nennt die Aufgaben beim Namen (#1817), siehe `wallTasksByMember`.
  if (allows('tasks')) try {
    result.wallTasks = wallTasksByMember(d, {
      today: todayLocalKey,
      zone: householdTimeZone(d),
      now,
      categoryAnd: taskCategoryAnd,
      categoryBinds: taskCategoryBinds,
    });
  } catch (err) {
    log.error('wallTasks error:', err.message);
    result.wallTasks = [];
  }

  // „Alles erledigt"-Zustand des Tagesprogramms: nur mit der Zahl heute fälliger,
  // bereits erledigter Aufgaben lässt sich „alles geschafft" von „heute stand nie
  // etwas an" unterscheiden - die offene Liste allein kann das nicht.
  if (allows('tasks')) try {
    result.tasksDoneToday = d.prepare(`
      SELECT COUNT(*) AS n FROM tasks t
      WHERE t.status = 'done' AND t.archived_at IS NULL
        AND t.due_date = @today
        AND ${taskScopeWhere('t', { bind: '@today' })}
        AND ${taskVisibleSql}${taskCategoryAnd}
    `).get({ today: todayLocalKey, me: userId, ...taskCategoryBinds }).n;
  } catch (err) {
    log.error('tasksDoneToday error:', err.message);
    result.tasksDoneToday = 0;
  }

  // DIE HAUSHALTSFASSUNG (#1817): von der leeren Fassung aus, nur was die Wand
  // zeichnet. Hier, hinter jeder Abfrage - ein Block, den jemand oben ergaenzt,
  // erreicht die Wand erst ueber die Allowlist.
  res.json(householdAudience ? householdAudienceAnswer(result, emptyAnswer({ month: currentMonth })) : result);
  } catch (err) {
    log.error('Critical error:', err.message);
    res.status(500).json({ error: 'Dashboard could not be loaded.', code: 500 });
  }
});

export default router;
