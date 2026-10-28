import { t } from '/i18n.js';
import { settingSwitchRowHtml } from '/settings/components.js';
import { getPreferences, savePreferences } from '/settings/preferences-cache.js';

/**
 * Modul-Schalter, die vor dem IA-Umbau je ein eigenes Blatt hatten: Budget,
 * Gesundheit und Haushaltshilfe trugen zusammen drei Checkboxen, kosteten aber
 * drei Sidebar-Einträge, drei Navigationsschritte und drei Requests
 * (Critique 2026-07-27). Ein Schalter je Karte, ein Blatt. Aufgaben kam später
 * nach demselben Muster dazu.
 */
const APPEARANCE_PATH = '/settings/personal/appearance';

const TOGGLES = [
  {
    id: 'tasks-subtasks-expanded',
    key: 'tasks_subtasks_expanded',
    read: (preferences) => Boolean(preferences.tasks_subtasks_expanded),
    payload: (checked) => ({ tasks_subtasks_expanded: checked }),
    savedKey: 'settings.tasksSubtasksExpandedSaved',
  },
];

// Nicht Teil von TOGGLES: das sind DREI Kontrollkästchen ueber EINEM
// Praeferenz-Schluessel (ein Array von Vorlagen-Schluesseln, die AUSGEBLENDET
// sind), nicht ein Schluessel je Schalter. Angehakt heisst sichtbar - die
// gespeicherte Form ist die Ausblendliste, dieselbe Umkehrung wie bei
// disabled_modules/hidden_modules anderswo in diesem Baum.

function checkedState(preferences) {
  return new Map(TOGGLES.map((toggle) => [toggle.id, toggle.read(preferences)]));
}

/**
 * SEIT R10 KEIN EIGENES BLATT MEHR (Re-Critique 2026-09-27, A7 P1-3): die
 * "Modul-Optionen" waren eine Sammelschublade fuer fuenf Module. Jeder Teil
 * steht jetzt als Abschnitt "Fuer den Haushalt" im Blatt SEINES Moduls
 * (registry.js, `part`). Die Ueberschrift mit dem Modulnamen entfaellt deshalb:
 * das Blatt heisst schon so, und darueber steht die Reichweite.
 */
const PARTS = ['tasks'];

/**
 * EIN TRAEGER JE TEIL, ZEILEN DARIN (R17, E9). Bis dahin stand jeder Schalter
 * in einer eigenen Karte mit Kartentitel und Hinweis darueber - 154 bis 225px
 * fuer eine Ja/Nein-Frage. Der Hinweis ist jetzt der Fuss der Gruppe.
 *
 * EINE ZEILE BRAUCHT KEINE UEBERSCHRIFT: der Kartentitel ueber einem einzelnen
 * Schalter ("Zyklus" ueber "Zyklus-Tab anzeigen", "Unteraufgaben" ueber
 * "Unteraufgaben in Aufgaben aufgeklappt lassen") sagte in einem Wort, was die
 * Zeile ausschreibt - und als Abschnittsueberschrift stuende "Zyklus" im Blatt
 * Gesundheit zweimal, wie vorher "Termine" im Kalender. Einen Titel traegt nur
 * die Gruppe mit mehreren Zeilen (Schichtplan-Vorlagen); er ist dort der
 * Suchtreffer.
 */
function groupHtml({ titleKey = null, rows, footer }) {
  return `
      ${titleKey ? `<h2 class="settings-section__title">${t(titleKey)}</h2>` : ''}
      <div class="row-carrier settings-group">${rows}</div>
      ${footer}`;
}

function partHtml(part, preferences, checked) {
  switch (part) {
    case 'tasks':
      return groupHtml({
        rows: settingSwitchRowHtml({
          label: t('settings.tasksSubtasksExpandedLabel'),
          checked: checked.get('tasks-subtasks-expanded'),
          attrs: { id: 'tasks-subtasks-expanded', 'aria-describedby': 'tasks-subtasks-expanded-hint' },
        }),
        footer: `
      <p class="form-hint settings-group__footer" id="tasks-subtasks-expanded-hint">${t('settings.tasksSubtasksExpandedHint')}</p>`,
      });
    default:
      return '';
  }
}

function renderPage(container, preferences, part) {
  const checked = checkedState(preferences);
  const parts = PARTS.includes(part) ? [part] : PARTS;
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', parts
    .map((entry) => `<section class="settings-section">${partHtml(entry, preferences, checked)}</section>`)
    .join(''));
}

function bindEvents(container) {

  for (const toggle of TOGGLES) {
    const input = container.querySelector(`#${toggle.id}`);
    input?.addEventListener('change', async () => {
      input.disabled = true;
      try {
        await savePreferences(toggle.payload(input.checked));
        window.yuvomi?.showToast(t(toggle.savedKey), 'success');
      } catch (error) {
        input.checked = !input.checked; // Rollback nur bei Save-Fehler
        window.yuvomi?.showToast(error.message || t('common.errorGeneric'), 'danger');
      } finally {
        if (input.isConnected) input.disabled = false;
      }
    });
  }

  // Kein Eintrag in TOGGLES: die drei Kontrollkaestchen teilen sich EINEN
  // Praeferenz-Schluessel (die Ausblendliste), ein Klick muss also alle drei
  // aktuellen Zustaende einsammeln, nicht nur den eigenen.

}

// Welcher Teil, sagt der Abschnitt (registry.js `props.part`): die Shell
// schreibt ihn an den Traeger, die Signatur bleibt die aller Blaetter.
export async function render(container, { user }) {
  void user;
  const preferences = await getPreferences();
  renderPage(container, preferences, container.dataset.part);
  bindEvents(container);
}
