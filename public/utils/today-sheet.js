/**
 * Modul: Heute-Blatt - der Beitrags-Vertrag
 * Zweck: Welche Module im Blatt „Heute wichtig" sprechen, in welcher Form, und
 *        nach welcher Regel das Blatt sortiert, deckelt und seine Coda setzt.
 * Abhaengigkeiten: /i18n.js, /permissions.js, /nav-icons.js, /utils/timezone.js,
 *                  /utils/pantry-status.js
 *
 * WARUM ES DIESEN VERTRAG GIBT (Dashboard-Critique 23.09.2026, P1). Das Blatt
 * las nur Termine, Aufgaben, Essen und Einkauf und schloss mit „Danach steht
 * heute nichts mehr an" - waehrend dieselbe Antwort von /dashboard zwei offene
 * Dosen und eine wartende Freigabe trug. Jede Quelle, die das Blatt nicht
 * kannte, war eine Stelle, an der die Coda log. Deshalb steht hier EINE Liste
 * von Quellen mit EINER Zeilenform, und Cockpit wie Wand lesen dieselbe.
 *
 * DIE ZEILE. Jede Quelle liefert Objekte dieser Form:
 *   kind      'dose' | 'approval' | ... - was die Zeile ist (Anker, Dedupe)
 *   sortKey   'HH:MM' - Platz im Tag; Zeitloses ordnet sich ein:
 *             00:00 schon faellig, 00:01 den ganzen Tag, 00:02 heute ohne Zeit
 *   tone      Raum der Zeile (CSS `today-cockpit-card--<tone>`, `wall-row--<tone>`)
 *   icon      Siegel-Zeichen (Name aus MODULE_ICON)
 *   title     was (Textfarbe), sub: woher (ruhiger Untertitel)
 *   timeLabel optionale Zeitangabe rechts; overdue faerbt sie
 *   route     Ziel beim Antippen
 *   who       Person, die die Zeile angeht (Ueberlappungszeichen) oder null
 *   priority  kleiner = wichtiger; entscheidet, was unter dem Deckel bleibt
 *   open      ist hier noch etwas ZU TUN? Nur offene Zeilen halten die Coda auf
 *
 * EINE NEUE QUELLE ANDOCKEN: ein Eintrag in TODAY_SHEET_SOURCES mit `module`,
 * `widget` und `collect(data, ctx)`, der aus einem Feld der /dashboard-Antwort
 * Zeilen dieser Form macht, dazu die Tonklassen `today-cockpit-card--<tone>` und
 * `wall-row--<tone>` in dashboard.css. Modulschalter, Widget-Recht und die
 * Kein-Echo-Regel prueft `sourceSpeaks()` fuer alle gleich; die Quelle muss nur
 * ihre Daten lesen. Das juengste Beispiel ist der Vorrat (`id: 'pantry'`,
 * liest `pantryExpiring.todayItems`/`todayCount`).
 */

import { t, formatTime } from '/i18n.js';
import { canSeeWidget as canSeeWidgetDefault, isPermAdmin, moduleAccess } from '/permissions.js';
import { MODULE_ICON } from '/nav-icons.js';
import { zonedDateKey, zonedTimeKey } from '/utils/timezone.js';
import { housekeepingSinceLabel } from '/utils/day-label.js';
import { pantryExpiryPhrase } from '/utils/pantry-status.js';
import { shiftTypeLabel } from '/utils/shift-label.js';

/** Zeitlose Plaetze im Tag - dieselben drei Stufen, die das Programm schon kennt. */
export const SORT_DUE_NOW = '00:00';
export const SORT_ALL_DAY = '00:01';
export const SORT_TODAY = '00:02';

/* DIE TONNE IST UM MITTAG ABGEHOLT. Die Abfuhr kennt keine Uhrzeit und keinen
 * Haken „abgeholt" - aber eine Tonne, die heute rausmusste, ist am Nachmittag
 * keine offene Sache mehr. Die Zeile bleibt als Auskunft stehen, haelt die
 * Coda aber nicht mehr auf. Mittag, weil die Abfuhr in aller Regel vormittags
 * faehrt; wer das anders erlebt, liest weiterhin „Abholung heute". */
const WASTE_PICKUP_SETTLED = '12:00';
/* Rausstellen heisst: am Vorabend. Die Zeile fuer die Abholung von morgen
 * steht deshalb im Programm am Abend. */
const WASTE_PUT_OUT_SORT = '18:00';

/**
 * Welche Erinnerungen das Blatt zeigt, und in wessen Ton.
 *
 * Nicht jede faellige Erinnerung ist eine Blatt-Zeile: Abfuhr und Schicht
 * haben hier eine eigene Quelle (eine zweite Zeile waere ein Echo), Zyklus und
 * Fasten sind Stupser ihrer eigenen Kacheln, und der Vorrat spricht ueber seine
 * eigene Quelle (`pantry`). Was hier nicht steht, spricht weiter ueber Toast
 * und Glocke. `echo` nennt das Widget, das dasselbe Objekt schon zeigen wuerde;
 * `widget` das Widget, dessen Sperre die Erinnerung stumm schaltet (nur wo das
 * Modul eine Kachel hat - sonst gilt allein das Modulrecht).
 */
const REMINDER_SHEET_ORIGINS = {
  task:                   { module: 'tasks',     widget: 'tasks',    tone: 'task',      icon: MODULE_ICON.tasks,     route: '/tasks',     kind: 'task',  echo: 'tasks' },
  event:                  { module: 'calendar',  widget: 'calendar', tone: 'event',     icon: MODULE_ICON.calendar,  route: '/calendar',  kind: 'event', echo: 'calendar' },
  document_expiry:        { module: 'documents',                     tone: 'documents', icon: MODULE_ICON.documents, route: '/documents' },
};

function openDoseCount(health) {
  const total = Number(health?.dosesTotal) || 0;
  const done = (Number(health?.dosesTaken) || 0) + (Number(health?.dosesSkipped) || 0);
  return Math.max(0, total - done);
}

function joinNames(names) {
  return [...new Set(names.filter(Boolean))].join(', ');
}

/**
 * Die Quellen neben Termin, Aufgabe und Essen (die baut das Programm in
 * dashboard.js selbst). Reihenfolge egal: das Blatt sortiert nach Tag.
 */
export const TODAY_SHEET_SOURCES = [
  {
    // Geburtstag und Namenstag heute. Steht er schon als Termin in der Antwort
    // (die Geburtstage laufen im Kalender mit, #927), spricht der Kalender fuer
    // ihn - im Blatt oder in seiner Kachel -, und hier kommt keine zweite Zeile.
    id: 'birthdays',
    module: 'calendar',
    widget: 'birthdays',
    collect(data, ctx) {
      const list = Array.isArray(data?.birthdays) ? data.birthdays : [];
      const events = Array.isArray(data?.upcomingEvents) ? data.upcomingEvents : [];
      const asEvent = new Set(events
        .filter((e) => e.birthday_name && String(e.start_datetime ?? '').slice(0, 10) === ctx.todayKey)
        .map((e) => e.birthday_name));
      return list
        .filter((b) => Number(b.days_until) === 0 && !asEvent.has(b.name))
        .map((b) => ({
          kind: 'birthday',
          objectId: b.id ?? null,
          sortKey: SORT_ALL_DAY,
          timeLabel: '',
          title: b.name,
          sub: b.kind === 'name_day' ? t('birthdays.nameDay') : t('contacts.birthdayLabel'),
          icon: MODULE_ICON.birthdays,
          tone: 'birthdays',
          // Der Geburtstag selbst (`?open=`, R22 D3), wie aus der Suche.
          route: b.id != null ? `/birthdays?open=${encodeURIComponent(String(b.id))}` : '/birthdays',
          who: null,
          priority: 60,
          open: false,
        }));
    },
  },
  {
    // Vorrat, der HEUTE ablaeuft (Dashboard-Critique 23.09.2026, #1448). Wie
    // die Tonne: mehrere Chargen eines Tages sind EINE Zeile, und sie ist ein
    // Auftrag (heute aufbrauchen), haelt also die Coda auf. Abgelaufenes und
    // „bald" bleiben der Vorrats-Kachel - das Blatt kennt nur heute. Die
    // Namen kommen gedeckelt (`todayItems`), die Zahl ungedeckelt
    // (`todayCount`); was darueber hinausgeht, steht als „+N weitere" da.
    id: 'pantry',
    module: 'pantry',
    widget: 'pantry',
    collect(data) {
      const slice = data?.pantryExpiring;
      const items = Array.isArray(slice?.todayItems) ? slice.todayItems : [];
      if (!items.length) return [];
      const names = joinNames(items.map((item) => item.name));
      const rest = Math.max(0, (Number(slice.todayCount) || 0) - items.length);
      const phrase = pantryExpiryPhrase(0);
      return [{
        kind: 'pantry',
        objectId: null,
        sortKey: SORT_ALL_DAY,
        timeLabel: '',
        title: rest ? `${names} ${t('dashboard.pantryExpiringMore', { count: rest })}` : names,
        sub: t(phrase.key),
        icon: MODULE_ICON.pantry,
        tone: 'pantry',
        route: '/pantry?filter=soon',
        who: null,
        priority: 30,
        open: true,
      }];
    },
  },
  {
    // Faellige Erinnerungen - die, um die man ausdruecklich gebeten hat. Eine
    // Erinnerung an eine Aufgabe, die ohnehin als Zeile im Blatt steht, ist
    // keine zweite Zeile wert.
    id: 'reminders',
    module: null,
    widget: null,
    collect(data, ctx) {
      const list = Array.isArray(data?.pendingReminders) ? data.pendingReminders : [];
      const rows = [];
      for (const reminder of list) {
        const origin = REMINDER_SHEET_ORIGINS[reminder.entity_type];
        if (!origin || ctx.moduleOff(origin.module)) continue;
        // Die Quelle selbst hat kein Widget, ihre Herkunft schon: ein gesperrtes
        // Gesundheits-Widget schweigt auch ueber die faellige Vorsorge (#467).
        if (origin.widget && !ctx.canSeeWidget(origin.widget)) continue;
        if (origin.echo && ctx.widgetShown(origin.echo)) continue;
        if (origin.kind && ctx.existing.some((row) => row.kind === origin.kind
          && String(row.objectId) === String(reminder.entity_id))) continue;
        rows.push({
          kind: 'reminder',
          objectId: reminder.id ?? null,
          sortKey: SORT_DUE_NOW,
          timeLabel: '',
          title: reminder.entity_title || t('reminders.toastTitle'),
          sub: t('reminders.toastTitle'),
          icon: origin.icon,
          tone: origin.tone,
          route: origin.route,
          who: null,
          priority: 5,
          open: true,
        });
      }
      return rows;
    },
  },
];

/**
 * Spricht diese Quelle fuer diesen Betrachter? Drei Riegel, fuer jede Quelle
 * gleich: das Modul ist an, das Widget ist ihm nicht verwehrt (#467 - ein
 * gesperrtes Gesundheits-Widget heisst auch: keine Dosen im Blatt), und die
 * Kachel steht NICHT sichtbar im Raster (Kein-Echo: jede Domaene hat genau
 * eine Repraesentation, Blatt ODER Kachel).
 */
export function sourceSpeaks(source, ctx) {
  if (source.module && ctx.moduleOff(source.module)) return false;
  if (source.widget && !ctx.canSeeWidget(source.widget)) return false;
  if (source.widget && ctx.widgetShown(source.widget)) return false;
  return source.allowed ? Boolean(source.allowed(ctx)) : true;
}

/** Module, die ein Display auf der Wand zeigen darf, obwohl sein Credential
 *  `none`-Zugang hat: der Server liefert sie nur fuer `audience=household`,
 *  und die Wand braucht sie im Programm (#1903). */
const WALL_DISPLAY_MODULES = new Set(['meals', 'shopping', 'housekeeping', 'waste', 'pantry']);

/**
 * Der Kontext, den jede Quelle liest. Die Riegel kommen von aussen, damit
 * Cockpit (mit Widget-Konfiguration) und Wand (ohne) dieselben Quellen fragen.
 */
export function todaySheetContext({
  todayKey, tomorrowKey, nowTime, cfg = [], isAdmin = isPermAdmin(), viewer = null,
  isModuleDisabled = () => false,
  canSeeWidget = canSeeWidgetDefault,
  existing = [],
  isDisplay = false,
} = {}) {
  const widgetShown = (id) => Array.isArray(cfg) && cfg.some((w) => w.id === id && w.visible);
  // Zwei Achsen, wie ueberall (#467): der Haushaltsschalter des Moduls und das
  // Modulrecht des Betrachters. Der Server liefert gesperrte Module ohnehin
  // leer - der Riegel hier haelt auch einen alten Stand im Speicher stumm.
  // Displays auf der Wand (isDisplay) kommen ohne Modulrecht, aber der Server
  // schickt die fuenf Wand-Quellen trotzdem. Nur der `moduleAccess`-Riegel
  // weicht - der Haushaltsschalter (`isModuleDisabled`) bleibt stets aktiv:
  // ein haushaltsweit abgeschaltetes Modul schweigt auch an der Wand.
  const moduleOff = (module) => {
    if (isModuleDisabled(module)) return true;
    if (isDisplay && WALL_DISPLAY_MODULES.has(module)) return false;
    return moduleAccess(module) === 'none';
  };
  return { todayKey, tomorrowKey, nowTime, isAdmin, viewer, moduleOff, canSeeWidget, widgetShown, existing };
}

/** Die Zeilen aller sprechenden Quellen, plus ob eine davon „heute erledigt" meldet. */
export function collectSourceRows(data, ctx, sources = TODAY_SHEET_SOURCES) {
  const rows = [];
  let settled = false;
  for (const source of sources) {
    if (!sourceSpeaks(source, ctx)) continue;
    rows.push(...source.collect(data, ctx));
    if (source.settled?.(data, ctx)) settled = true;
  }
  return { rows, settled };
}

/**
 * Welche Quellen tragen fuer diesen Betrachter gerade eine Zeile ins Blatt?
 * Die Kennzahlreihe fragt das, damit eine Zahl, die das Blatt schon nennt
 * (offene Freigaben), nicht noch einmal als Kachel daneben steht - die
 * Kein-Echo-Regel in die andere Richtung.
 */
export function speakingSourceIds(data, ctx, sources = TODAY_SHEET_SOURCES) {
  const ids = new Set();
  for (const source of sources) {
    if (sourceSpeaks(source, ctx) && source.collect(data, ctx).length) ids.add(source.id);
  }
  return ids;
}

const bySortKey = (a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0);
const byPriority = (a, b) => (a.priority ?? 50) - (b.priority ?? 50);

/**
 * Sortieren, deckeln, zaehlen - fuer Cockpit und Wand dieselbe Rechnung.
 *
 * Unter dem Deckel bleibt zuerst, was OFFEN ist: eine Auskunft (Schicht,
 * Geburtstag) darf keinen Auftrag hinter „+N weitere" schieben. Innerhalb
 * derselben Offenheit entscheidet die Prioritaet, dann der Platz im Tag.
 * Gezeigt wird danach wieder chronologisch - das Blatt ist ein Programm, keine
 * Rangliste.
 */
export function composeTodaySheet(rows, { cap }) {
  const sorted = [...rows].sort((a, b) => bySortKey(a, b) || byPriority(a, b));
  const openCount = sorted.filter((row) => row.open).length;
  if (sorted.length <= cap) return { rows: sorted, allRows: sorted, overflow: 0, openCount };
  const keep = new Set([...sorted]
    .sort((a, b) => (Number(Boolean(b.open)) - Number(Boolean(a.open))) || byPriority(a, b) || bySortKey(a, b))
    .slice(0, cap));
  const visible = sorted.filter((row) => keep.has(row));
  return { rows: visible, allRows: sorted, overflow: sorted.length - visible.length, openCount };
}

/**
 * Die Coda („Danach steht heute nichts mehr an") ist eine Entwarnung, und sie
 * darf nur fallen, wenn sie stimmt: es gibt Zeilen, keine davon ist noch offen,
 * und keine verschwindet hinter „+N weitere". Eine offene Dosis, eine wartende
 * Freigabe oder die Tonne am Morgen halten sie auf.
 */
export function codaAllowed(sheet) {
  return sheet.rows.length > 0 && sheet.overflow === 0 && sheet.openCount === 0;
}
