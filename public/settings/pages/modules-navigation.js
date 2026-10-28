import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { getPreferences, savePreferences } from '/settings/preferences-cache.js';
import { bindDisclosure, createRetryState, thirdPartyStatusLabel } from '/settings/components.js';
import {
  BUILT_IN_MODULES,
  DEFAULT_MODULE_ACCENT,


  NAV_SECTION,
  NAV_SECTIONS,
  NAV_SECTION_LABEL_KEYS,
  expandModuleOrder,
  moduleSection,
  normalizeModuleOrder,
  normalizeMobileNavOrder,
  resolveMobileNavOrder,
  sortNavigationItems,
} from '/settings/module-order.js';
import { MODULE_ICON, moduleIconHTML } from '/nav-icons.js';
import { moduleAccentVar } from '/utils/module-accent.js';
import { emptyStateHTML } from '/utils/empty-state.js';
import { rowMenuHtml } from '/utils/row-action.js';
import { installPopoverMenus } from '/utils/popover-menu.js';
import { sortableSet, restoreOrder } from '/utils/sortable.js';

/** Die Sortable-Instanzen des Blatts: frei bei jedem Neuaufbau (`render`). */
const navSortables = sortableSet();


// (als ein expandierbarer Eintrag) und Drittanbieter-Module — sortiert nach der
// normalisierten Modul-Reihenfolge der Preferences.
function buildRows(preferences) {
  const disabled = new Set(Array.isArray(preferences.disabled_modules) ? preferences.disabled_modules : []);
  // Zwei Mengen, zwei Fragen (#673): `disabled` = gibt es im Haushalt nicht,
  // `hidden` = will ich nicht in meiner Navigation sehen. Siehe parseHiddenModules
  // in server/routes/preferences.js.
  const hidden = new Set(Array.isArray(preferences.hidden_modules) ? preferences.hidden_modules : []);


  const rows = [];


  for (const module of BUILT_IN_MODULES) {

    rows.push({
      type: 'built-in',
      id: module.id,
      orderId: module.id,
      section: moduleSection(module.id),
      label: t(module.labelKey),
      icon: MODULE_ICON[module.id],
      enabled: module.locked || !disabled.has(module.id),
      hidden: hidden.has(module.id),
      locked: module.locked === true,
      sortable: module.locked !== true,
    });
  }

  // damit es konsistent mit der globalen Navigation erscheint.
  const ordered = rows;

  // Die gespeicherte Reihenfolge gilt nur innerhalb der drei Navigationsgruppen.
  // Dashboard und Settings bleiben an ihren festen Positionen.
  const normalizedOrder = normalizeModuleOrder(preferences.module_order || []);
  return sortNavigationItems(ordered, normalizedOrder);
}

/** Das Label des Griffs: Objekt und Position, wie im Einkauf und in den Verwaltern. */
function handleLabel(name, index, total) {
  return `${t('common.reorderHandle', { name })}, ${t('common.reorderPosition', { index, total })}`;
}

/* D10 ZEILEN-ENDZONE (#2180, wie die Verwalter in #2152).
 *
 * Bis dahin stand VOR dem Symbol ein Griff, der nur mit der Maus zog (auf dem
 * Telefon ausgeblendet), daneben ein sichtbares Auf/Ab-Paar - zwei Ziele je
 * Zeile, die auf dem Telefon als zweite Zeile unter dem Titel standen. Jetzt
 * endet die Zeile wie jede andere Liste der App: [Ausblenden][Mehr][Griff].
 * Der Griff ist ein Knopf, die Pfeiltasten an ihm verschieben die Zeile;
 * Nach oben/Nach unten stehen im Mehr-Menue (Schalter, Screenreader ohne
 * Pfeiltasten). Eine Gruppe mit nur einer sortierbaren Zeile hat keine
 * Reihenfolge und zeigt weder Griff noch Menue.
 */
function rowEndHtml(row, position) {
  if (!row.sortable || !position) return '';
  // Allein in ihrer Gruppe (Finanzen: nur Budget) haelt die Zeile den Platz von
  // Mehr und Griff frei - ein leerer Platz, kein toter Knopf -, sonst stuende
  // ihr Auge rechts neben der Augenspalte aller anderen Gruppen.
  if (position.total < 2) {
    return `
      <span class="row-action settings-module-row__slot" aria-hidden="true"></span>
      <span class="row-action list-row__drag settings-module-row__handle settings-module-row__slot" aria-hidden="true">
        <i data-lucide="grip-vertical" class="icon-md"></i>
      </span>`;
  }
  const { index, total } = position;
  const menu = rowMenuHtml({
    id: `module-order-menu-${row.orderId}`,
    label: t('common.moreActionsNamed', { name: row.label }),
    items: [
      { action: 'module-move-up', icon: 'chevron-up', label: t('category.moveUpNamed', { name: row.label }), disabled: index === 1 },
      { action: 'module-move-down', icon: 'chevron-down', label: t('category.moveDownNamed', { name: row.label }), disabled: index === total },
    ],
  });
  return `${menu}
      <button type="button" class="row-action list-row__drag settings-module-row__handle" data-module-handle
              aria-label="${esc(handleLabel(row.label, index, total))}" title="${esc(t('common.reorderHandleHint'))}"
              aria-keyshortcuts="ArrowUp ArrowDown">
        <i data-lucide="grip-vertical" class="icon-md" aria-hidden="true"></i>
      </button>`;
}

/** Die Endzone als ein Block: Ausblenden (falls vorhanden), dann Mehr und Griff. */
function endZoneHtml(row, position, hideHtml = '') {
  const tail = rowEndHtml(row, position);
  if (!hideHtml && !tail) return '';
  return `<div class="settings-module-row__end">${hideHtml}${tail}</div>`;
}

/* EIN BLATT, EINE REICHWEITE (#673, nachgeschärft nach der Critique vom 2026-08-16).
 *
 * Dieses Blatt gehört seit dem Umzug des Haushalts-Schalters nach
 * `modules-active` ganz der Person, die es öffnet: Reihenfolge, mobile Plätze
 * und dieser Knopf wirken ausschliesslich für sie. Deshalb steht hier nur noch
 * EIN Bedienelement je Zeile, und der Knopf muss keinen Nachbarn mehr von sich
 * abgrenzen.
 *
 * DREI DINGE, DIE DIE CRITIQUE GEMESSEN HAT UND DIE HIER JETZT ANDERS STEHEN:
 *
 * 1. Das Symbol ist FEST `eye-off`. Vorher wechselte es zwischen `eye` und
 *    `eye-off` und drehte damit das Register der ganzen App um: `eye` heisst in
 *    Yuvomi überall "zeig mir das" (Dokumentenvorschau, Gesundheit, Backup), es
 *    ist eine HANDLUNG. Als Zustandsanzeige auf einem Knopf, dessen Beschriftung
 *    eine Handlung ansagt, war es rückwärts lesbar.
 * 2. Der zugängliche Name ist STABIL und nennt sein Modul. Vorher trug der Knopf
 *    gleichzeitig `aria-pressed="true"` und "Für mich einblenden" - eine Ansage,
 *    die sich selbst widerspricht ("einblenden, gedrückt"). Ein Umschaltknopf
 *    trägt seinen Zustand in `aria-pressed`, nie zusätzlich im Namen. Und sechzehn
 *    wortgleiche "Für mich ausblenden" machten die Rotorliste unbrauchbar.
 * 3. Ein deaktivierter Knopf nennt seinen Grund über `aria-describedby` auf den
 *    Status-Chip derselben Zeile, statt nur "nicht verfügbar" zu sagen.
 *
 * Drittanbieter-Module tragen ihn nicht: `hidden_modules` prüft serverseitig
 * gegen dieselbe Allowlist wie der Haushalts-Schalter, und die kennt nur die
 * eingebauten Slugs; ein Knopf, dessen Wert der Server verwirft, wäre eine
 * Zusage, die niemand einhält.
 */
function hideToggleHtml(row, { hasStatusChip = true } = {}) {
  const label = row.groupLabelKey
    ? t(row.groupLabelKey)
    : t('settings.modulesHideForMe', { module: row.label });

  // keinen Status-Chip, ein `aria-describedby` auf eine Id, die es nicht gibt,
  // sagt der Hilfstechnik NICHTS - genau der Zustand, den dieser Verweis
  // beheben sollte (Review zu PR #790).
  const describedBy = (!row.enabled && hasStatusChip)
    ? ` aria-describedby="module-status-${esc(row.id)}"`
    : '';
  return `
    <button type="button" class="settings-module-hide" data-module-hide="${esc(row.id)}"
            aria-pressed="${row.hidden ? 'true' : 'false'}" ${row.enabled ? '' : 'disabled'}
            aria-label="${esc(label)}" title="${esc(label)}"${describedBy}>
      <i data-lucide="eye-off" aria-hidden="true"></i>
    </button>
  `;
}

/* EIN STATUSKANAL JE ZEILE (Critique 2026-08-16, P0).
 *
 * Vorher trug eine ausgeblendete Zeile ZWEI Statusworte nebeneinander -
 * "Aktiviert · Für mich ausgeblendet" -, und das betonte davon war das falsche:
 * "Aktiviert" ist eine gefüllte grüne Pille, "Für mich ausgeblendet" war grauer
 * Text. Als Endzustand des Ablaufs sagte die Zeile gleichzeitig "an" und "weg".
 *
 * Seit der Haushalts-Schalter drüben auf `modules-active` steht, ist "Aktiviert"
 * hier ohnehin keine Nachricht mehr: was hier steht, ist aktiv, sonst stünde es
 * nicht in der Navigation. Ein Chip erscheint deshalb nur noch, wenn er etwas
 * erklärt - meine Ausblendung, oder das Fehlen im Haushalt, das den Knopf
 * sperrt und über `aria-describedby` auch angesagt wird.
 */
function statusChipHtml(row) {
  if (!row.enabled) {
    return `<span class="settings-module-status settings-module-status--disabled" id="module-status-${esc(row.id)}">${esc(t('settings.thirdPartyModulesStatusDisabled'))}</span>`;
  }
  if (row.hidden) {
    return `<span class="settings-module-status settings-module-status--hidden">${esc(t('settings.modulesHiddenForMe'))}</span>`;
  }
  return '';
}

function builtInRowHtml(row, position) {
  const stateClass = row.enabled ? 'settings-module-row--enabled' : 'settings-module-row--disabled';
  const lockedClass = row.locked ? ' settings-module-row--locked' : '';
  const hiddenClass = row.hidden && row.enabled ? ' settings-module-row--hidden' : '';
  return `
    <div class="settings-module-row settings-module-row--sortable ${stateClass}${lockedClass}${hiddenClass}${row.sortable ? '' : ' settings-module-row--fixed'}" data-module-row-id="${esc(row.orderId)}"${row.sortable ? ` data-module-order-id="${esc(row.orderId)}" data-module-name="${esc(row.label)}"` : ''}>
      <div class="settings-module-row__icon" style="--module-row-accent:${moduleAccentVar(row.id)}">
        ${moduleIconHTML(row.icon)}
      </div>
      <div class="settings-module-row__body">
        <div class="settings-module-row__title">
          <strong>${esc(row.label)}</strong>
          ${row.locked ? `<span class="settings-module-origin">${esc(t('settings.modulesBuiltInBadge'))}</span>` : ''}
          ${statusChipHtml(row)}
        </div>
      </div>
      ${endZoneHtml(row, position, row.locked ? '' : hideToggleHtml(row))}
    </div>
  `;
}

function rowHtml(row, position = null) {

  // Drittanbieter-Zeilen erreichen Mitglieder nie: /modules?admin=1 wird für sie
  // gar nicht abgefragt, thirdPartyModules bleibt leer.
  return builtInRowHtml(row, position);
}

/** Die Zeilen einer Gruppe samt Position unter den sortierbaren (1-basiert). */
function sectionRowsHtml(sectionRows) {
  const total = sectionRows.filter((row) => row.sortable).length;
  let index = 0;
  return sectionRows.map((row) => rowHtml(row, row.sortable ? { index: ++index, total } : null)).join('');
}

function mobileCandidateRows(rows) {
  return rows.filter((row) => (
    row.enabled
    // Wer ein Modul aus seiner Navigation nimmt, will es auch nicht als
    // Mobil-Favorit angeboten bekommen (#673).
    && !row.hidden
    && !row.locked
    && row.sortable
    && !row.menuHidden
  ));
}

function mobileSlotHtml(rows, selectedIds, index) {
  const selectedId = selectedIds[index] ?? '';
  const selectedElsewhere = new Set(selectedIds.filter((_, slot) => slot !== index));
  const label = t('settings.mobileNavigationSlotLabel', { position: index + 1 });

  return `
    <label class="settings-mobile-nav-slot">
      <span class="settings-mobile-nav-slot__label">${esc(label)}</span>
      <select class="form-input" data-mobile-nav-slot aria-label="${esc(label)}"${selectedId ? '' : ' disabled'}>
        ${selectedId ? '' : `<option value="" selected>${esc(t('settings.mobileNavigationEmptyOption'))}</option>`}
        ${rows.map((row) => `
          <option value="${esc(row.orderId)}"${row.orderId === selectedId ? ' selected' : ''}${selectedElsewhere.has(row.orderId) ? ' disabled' : ''}>
            ${esc(row.label)}
          </option>
        `).join('')}
      </select>
    </label>
  `;
}

function desktopGroupHtml(section, rows) {
  const sectionRows = rows.filter((row) => row.section === section);
  if (!sectionRows.length) return '';

  return `
    <section class="settings-navigation-group" data-module-section="${section}">
      <h3 class="settings-navigation-group__title">${esc(t(NAV_SECTION_LABEL_KEYS[section]))}</h3>
      <div class="row-carrier settings-modules-list settings-modules-list--sortable" data-module-list>
        ${sectionRowsHtml(sectionRows)}
      </div>
    </section>
  `;
}

function renderPage(container, rows, mobileOrder) {
  container.replaceChildren();
  const desktopGroups = rows.length
    ? `<div class="settings-navigation-groups" id="module-toggles">${NAV_SECTIONS.map((section) => desktopGroupHtml(section, rows)).join('')}</div>`
    : emptyStateHTML({
      compact: true,
      title: t('settings.thirdPartyModulesEmptyTitle'),
      description: t('settings.thirdPartyModulesEmptyHint'),
    });
  const mobileRows = mobileCandidateRows(rows);

  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <section class="settings-navigation-panel">
        <h2 class="settings-navigation-panel__title">${t('settings.mobileNavigationTitle')}</h2>
        <p class="form-hint">${t('settings.mobileNavigationHint')}</p>
        <div class="settings-mobile-nav-slots">
          ${[0, 1, 2].map((index) => mobileSlotHtml(mobileRows, mobileOrder, index)).join('')}
        </div>
      </section>
      <section class="settings-navigation-panel">
        <h2 class="settings-navigation-panel__title">${t('settings.desktopNavigationTitle')}</h2>
        <p class="form-hint">${t('settings.desktopNavigationHint')}</p>
        <p class="form-hint">${t('settings.modulesDragHint')}</p>
        <p class="form-hint">${t('settings.modulesHiddenScopeHint')}</p>
        ${desktopGroups}
      </section>
    </section>
  `);
  window.lucide?.createIcons({ el: container });
}


// Eintrag). Wird vor dem Speichern via expandModuleOrder zurück auf die

function collectVisibleGlobalOrder(list) {
  return [...list.querySelectorAll('[data-module-order-id]')]
    .map((rowEl) => rowEl.dataset.moduleOrderId)
    .filter(Boolean);
}


function collectHiddenModuleIds(buttons) {
  const ids = new Set();
  for (const btn of buttons) {
    if (btn.getAttribute('aria-pressed') !== 'true') continue;
    const id = btn.dataset.moduleHide;

    ids.add(id);
  }
  return [...ids];
}

/**
 * Save-Payload dieses Blatts: ausschliesslich Persönliches.
 *
 * Bis zur Critique vom 2026-08-16 gab es hier zwei Payloads - eine für
 * Mitglieder (nur Reihenfolge) und eine für Admins (Reihenfolge PLUS
 * `disabled_modules`), weil der haushaltweite Schalter auf demselben Blatt
 * stand. Beides ist weg: der Schalter wohnt auf `modules-active`, und damit
 * schickt dieses Blatt für JEDE Rolle denselben Satz Schlüssel. Eine Payload,
 * die nicht mehr wissen muss, wer sie absendet, kann auch nicht mehr die
 * falsche sein.
 *
 * Verwaiste IDs sind unkritisch: normalizeModuleOrder filtert nicht gegen die
 * aktivierten Module, aber buildRows sortiert nur - eine ID ohne passende Zeile
 * bleibt wirkungslos.
 */
export function buildOrderPayload(visibleGlobalOrder, unrenderedIds = []) {
  const visible = expandModuleOrder(visibleGlobalOrder);
  // Was das Blatt nie gezeigt hat, darf es auch nicht loeschen: ein Mitglied
  // bekommt `/modules?admin=1` nicht, also stehen Drittanbieter-Module gar
  // nicht in seiner Liste. Ohne diesen Anhang wuerfe schon das Ausblenden
  // EINES eingebauten Moduls die gespeicherte Reihenfolge seiner eigenen
  // Zusatzmodule weg - still, denn sichtbar war sie hier nie (Codex-Review zu
  // PR #790).
  const missing = unrenderedIds.filter((id) => !visible.includes(id));
  return {
    module_order: [...visible, ...missing],
  };
}

export function buildMobileNavigationPayload(order) {
  return {
    mobile_nav_order: normalizeMobileNavOrder(order),
  };
}

async function saveNavigationState(list, unrenderedOrderIds = [], mobileOrder = null) {
  const payload = {
    ...buildOrderPayload(collectVisibleGlobalOrder(list), unrenderedOrderIds),
    hidden_modules: collectHiddenModuleIds(list.querySelectorAll('[data-module-hide]')),
    // Die drei Mobil-Plaetze fahren mit, wenn ein Ausblenden sie verschoben hat.
    // Ohne das behauptete der Toast eine Verschiebung, die der Server nicht
    // kennt: die Regel dieses Blatts ist "was die Leiste zeigt, ist was
    // gespeichert wird", und sie galt fuer den Ausblende-Pfad nicht
    // (Codex-Review zu PR #790).
    ...(mobileOrder ? { mobile_nav_order: mobileOrder } : {}),
  };
  const response = await savePreferences(payload);
  window.yuvomi?.setHiddenModules?.(response?.data?.hidden_modules ?? payload.hidden_modules);
  window.yuvomi?.setModuleOrder?.(response?.data?.module_order ?? payload.module_order);
  if (mobileOrder) {
    window.yuvomi?.setMobileNavOrder?.(response?.data?.mobile_nav_order ?? payload.mobile_nav_order);
  }
}

/**
 * Die Reihenfolge einer Gruppe verschieben und speichern (#2180) - EIN Weg
 * fuer Griff (Ziehen und Pfeiltasten) und Mehr-Menue.
 *
 * - EIN ZUG ZUR ZEIT (wie die Verwalter, Codex an #2177): solange gespeichert
 *   wird (auch eine Ausblendung, die denselben Payload schickt), entfaellt ein
 *   Schritt per Taste oder Menue, und ein Zug per Ziehen wird zurueckgenommen
 *   - auf die Folge, die gerade speichert, sonst auf die gespeicherte.
 * - SCHEITERT DAS SPEICHERN, steht wieder die gespeicherte Folge da
 *   (`restoreOrder`), statt dass das Blatt neu gebaut wird: der Fokus bleibt
 *   auf dem Griff oder dem Mehr-Knopf, von dem der Zug kam.
 * - Griff-Labels (Position) und die Grenzen von Auf/Ab im Menue ziehen nach
 *   jedem Zug nach.
 *
 * Die Liste je Gruppe ist `[data-module-list]`; ihre Kinder sind Zeilen mit
 * `data-module-row-id`, die sortierbaren tragen `data-module-order-id`.
 *
 * @param {object} opts
 * @param {() => Promise<void>} opts.save   - schreibt das ganze Blatt (Reihenfolge + Ausblendungen)
 * @param {{ saving: boolean, queued: boolean }} opts.lock - die Sperre, die auch das Ausblenden nimmt
 * @param {(ok: boolean, error?: Error) => void} [opts.notify] - Toast
 * @param {() => Promise<void>} [opts.afterSave] - holt einen waehrenddessen gemerkten Save nach
 */
export function createModuleReorder({ save, lock, notify = () => {}, afterSave = async () => {} }) {
  const committed = new Map();
  const pending = new Map();
  const idOf = (row) => row.dataset.moduleRowId;
  const idsOf = (list) => [...list.children].map(idOf);
  const sortableRows = (list) => [...list.children].filter((row) => row.dataset?.moduleOrderId);

  function refresh(list) {
    const rows = sortableRows(list);
    rows.forEach((row, i) => {
      row.querySelector('[data-module-handle]')
        ?.setAttribute('aria-label', handleLabel(row.dataset.moduleName ?? '', i + 1, rows.length));
      const up = row.querySelector('[data-action="module-move-up"]');
      const down = row.querySelector('[data-action="module-move-down"]');
      if (up) up.disabled = i === 0;
      if (down) down.disabled = i === rows.length - 1;
    });
  }

  function adopt(list) {
    committed.set(list, idsOf(list));
  }

  async function persist(list) {
    if (lock.saving) {
      restoreOrder(list, pending.get(list) ?? committed.get(list) ?? idsOf(list), idOf);
      refresh(list);
      return null;
    }
    const ids = idsOf(list);
    if (ids.join('|') === (committed.get(list) ?? []).join('|')) return null;
    lock.saving = true;
    pending.set(list, ids);
    refresh(list);
    let ok = true;
    try {
      await save();
    } catch (error) {
      ok = false;
      restoreOrder(list, committed.get(list) ?? ids, idOf);
      refresh(list);
      notify(false, error);
    } finally {
      lock.saving = false;
      pending.delete(list);
    }
    if (ok) {
      committed.set(list, ids);
      notify(true);
    }
    // Auch nach einem Fehlschlag: eine waehrenddessen gemerkte Ausblendung steht
    // schon im DOM und wurde gemeldet; sie wird jetzt mit der wiederhergestellten
    // Reihenfolge gespeichert, statt bis zum Neuladen nur angezeigt zu bleiben.
    await afterSave();
    return ok;
  }

  /** Ein Schritt um einen Platz unter den sortierbaren Zeilen; `focus` laeuft nach dem Umhaengen. */
  function move(row, delta, { focus } = {}) {
    if (lock.saving) return null;
    const list = row?.parentElement;
    if (!list) return null;
    const rows = sortableRows(list);
    const target = rows[rows.indexOf(row) + delta];
    if (!target) return null;
    if (delta < 0) list.insertBefore(row, target);
    else list.insertBefore(target, row);
    // Umhaengen nimmt dem Knopf in der Zeile den Fokus: zurueck an seinen Platz.
    focus?.();
    return persist(list);
  }

  /** Pfeil hoch/runter am fokussierten Griff; der Fokus bleibt auf dem Griff. */
  function onKeydown(event) {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return null;
    const handle = event.target?.closest?.('[data-module-handle]');
    if (!handle) return null;
    event.preventDefault();
    const row = handle.closest('[data-module-order-id]');
    return move(row, event.key === 'ArrowUp' ? -1 : 1, { focus: () => handle.focus() });
  }

  /** Nach oben/Nach unten aus dem Mehr-Menue; der Fokus geht an den Mehr-Knopf der Zeile. */
  function onClick(event) {
    const item = event.target?.closest?.('[data-action="module-move-up"], [data-action="module-move-down"]');
    if (!item || item.disabled) return null;
    const row = item.closest('[data-module-order-id]');
    if (!row) return null;
    const delta = item.dataset.action === 'module-move-up' ? -1 : 1;
    return move(row, delta, { focus: () => row.querySelector('.row-action--more')?.focus() });
  }

  return { adopt, persist, move, refresh, onKeydown, onClick };
}

function bindModuleListEvents(container, user, rows, unrenderedOrderIds = []) {
  const list = container.querySelector('#module-toggles');
  if (!list) return;

  /* EINE SPERRE FUER BEIDE SCHREIBWEGE, UND SIE VERSCHLUCKT NICHTS.
   *
   * Sortieren und Ausblenden schicken denselben Payload aus demselben DOM
   * (`module_order` UND `hidden_modules`), also darf nicht beides gleichzeitig
   * laufen. Zwei getrennte Flags hatten das Problem nur halbiert: eine
   * Ausblendung konnte waehrend eines Sortier-Saves starten (Gegenpruefung zur
   * Review von #790).
   *
   * Eine Ausblendung waehrend eines laufenden Saves wird gemerkt und danach
   * gespeichert; ein Zug waehrend eines Saves entfaellt (createModuleReorder). */
  const lock = { saving: false, queued: false };
  let busy = false;

  const flush = async (toastKey) => {
    if (lock.saving) { lock.queued = true; return; }
    lock.saving = true;
    try {
      await saveNavigationState(list, unrenderedOrderIds);
      window.yuvomi?.showToast(t(toastKey), 'success');
    } catch (error) {
      window.yuvomi?.showToast(error.message ?? t('common.errorGeneric'), 'danger');
      await render(container, { user });
      return;
    } finally {
      lock.saving = false;
    }
    if (lock.queued) {
      lock.queued = false;
      await flush(toastKey);
    }
  };

  const reorder = createModuleReorder({
    save: () => saveNavigationState(list, unrenderedOrderIds),
    lock,
    notify: (ok, error) => {
      if (ok) window.yuvomi?.showToast(t('settings.modulesOrderSaved'), 'success');
      else window.yuvomi?.showToast(error?.message ?? t('common.errorGeneric'), 'danger');
    },
    afterSave: async () => {
      if (!lock.queued) return;
      lock.queued = false;
      await flush('settings.modulesSaved');
    },
  });

  // Die Mehr-Menues der Zeilen: Lage, Schliessen nach der Wahl, Pfeiltasten.
  installPopoverMenus(list);
  navSortables.clear();
  for (const groupList of list.querySelectorAll('[data-module-list]')) {
    reorder.adopt(groupList);
    // Jede Gruppe ist ihre eigene Liste: ein Zug ueber die Gruppengrenze gibt es
    // nicht (die Reihenfolge gilt nur innerhalb der Gruppe). Gesperrte Zeilen
    // (Uebersicht, Einstellungen) tragen keinen Griff und ziehen nicht.
    navSortables.add(groupList, {
      handle: '[data-module-handle]',
      draggable: '[data-module-order-id]',
      onEnd: () => reorder.persist(groupList),
    }).catch(() => { /* ohne SortableJS bleiben Pfeiltasten und Menue */ });
  }

  list.addEventListener('keydown', (event) => { reorder.onKeydown(event); });
  list.addEventListener('click', (event) => {

    reorder.onClick(event);
  });

  /* AUSBLENDEN OHNE DEN FOKUS ZU VERLIEREN (Critique 2026-08-16, P1).
   *
   * Vorher rief dieser Pfad im Erfolgs- UND im Fehlerfall `render()` und baute
   * damit das ganze Blatt neu. Gemessen war der Tastaturfokus danach auf
   * `document.body`: wer drei Module ausblenden will, tabbt sich dreimal durch
   * bis zu 53 Bedienelemente zurück - bei einer Funktion, die man typischerweise
   * mehrfach hintereinander benutzt.
   *
   * Der Zustand wird deshalb in der Zeile getauscht statt neu gebaut. Der
   * Vollrender bleibt genau dort, wo er hingehört: im Fehlerfall, wo der
   * Serverstand die Wahrheit ist und der Fokus das kleinere Problem.
   */
  list.addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-module-hide]');
    if (!btn || btn.disabled || busy) return;
    const wasHidden = btn.getAttribute('aria-pressed') === 'true';
    const previousMobile = readMobileSlotValues(container);

    applyHiddenState(btn, !wasHidden);
    markRowHidden(rows, btn.dataset.moduleHide, !wasHidden);

    // collectHiddenModuleIds gleich darauf einen Zustand, den niemand gesetzt hat.

    // NICHT `disabled` waehrend des Speicherns: ein deaktivierter Knopf gibt den
    // Fokus ab, und genau den sollte dieser Pfad behalten (gemessen: sonst
    // landet er trotz In-place-Update auf `body`). Entprellt wird ueber eine
    // Sperre im Closure; `aria-busy` sagt der Hilfstechnik, dass gerade
    // geschrieben wird.
    busy = true;
    btn.setAttribute('aria-busy', 'true');

    // Erst die Plaetze neu aufloesen, dann speichern: was gleich in der Leiste
    // steht, ist der Wert, der mitgeschrieben werden muss.
    refreshMobileSlots(container, rows, user);
    const nextMobile = readMobileSlotValues(container);
    const mobileChanged = nextMobile.join('|') !== previousMobile.join('|');

    try {
      if (lock.saving) { lock.queued = true; } else {
        lock.saving = true;
        try {
          await saveNavigationState(list, unrenderedOrderIds, mobileChanged ? nextMobile : null);
        } finally {
          lock.saving = false;
        }
        if (lock.queued) { lock.queued = false; await flush('settings.modulesOrderSaved'); }
      }
      window.yuvomi?.showToast(hideToastMessage(container, previousMobile), 'success');
    } catch (error) {
      window.yuvomi?.showToast(error.message ?? t('common.errorGeneric'), 'danger');
      await render(container, { user });
    } finally {
      busy = false;
      btn.removeAttribute('aria-busy');
    }
  });
}


function readMobileSlotValues(container) {
  return [...container.querySelectorAll('[data-mobile-nav-slot]')].map((select) => select.value);
}

function slotLabel(container, index) {
  const select = container.querySelectorAll('[data-mobile-nav-slot]')[index];
  return select?.selectedOptions?.[0]?.textContent?.trim() ?? '';
}

function hideToastMessage(container, previousMobile) {
  const current = readMobileSlotValues(container);
  const changed = current.findIndex((value, index) => value !== previousMobile[index]);
  if (changed === -1) return t('settings.modulesSaved');
  return t('settings.modulesHiddenSavedSlot', {
    position: changed + 1,
    module: slotLabel(container, changed),
  });
}

/**
 * Die drei Auswahlfelder neu aufbauen, ohne das übrige Blatt anzufassen.
 *
 * Aufgelöst wird gegen das, was gerade in den Feldern steht: die Anzeige ist
 * die Wahrheit (siehe den Block über `hideToastMessage`). Ein ausgeblendetes
 * Ziel fällt heraus, der Rest rückt nach, und der Toast sagt, welcher Platz
 * sich dadurch geändert hat.
 */
function refreshMobileSlots(container, rows, user) {
  const wrap = container.querySelector('.settings-mobile-nav-slots');
  if (!wrap) return;
  const candidates = mobileCandidateRows(rows);
  const order = resolveMobileNavOrder(readMobileSlotValues(container), candidates.map((row) => row.orderId));
  wrap.replaceChildren();
  wrap.insertAdjacentHTML('beforeend',
    [0, 1, 2].map((index) => mobileSlotHtml(candidates, order, index)).join(''));
  bindMobileNavigationEvents(container, user);
}

/** Den Zustand auch im Datenmodell nachziehen - die Mobil-Kandidaten lesen ihn. */
function markRowHidden(rows, id, hidden) {
  if (!Array.isArray(rows) || !id) return;
  for (const row of rows) {
    if (row.id === id) row.hidden = hidden;


  }
}


function applyHiddenState(btn, hidden) {
  btn.setAttribute('aria-pressed', String(hidden));

  const row = btn.closest('.settings-module-row');
  if (!row) return;
  const disabled = row.classList.contains('settings-module-row--disabled');
  row.classList.toggle('settings-module-row--hidden', hidden && !disabled);
  const title = row.querySelector('.settings-module-row__title');
  const chip = title?.querySelector('.settings-module-status--hidden');
  if (hidden && title && !chip && !disabled) {
    title.insertAdjacentHTML('beforeend',
      `<span class="settings-module-status settings-module-status--hidden">${esc(t('settings.modulesHiddenForMe'))}</span>`);
  } else if (!hidden && chip) {
    chip.remove();
  }
}

export

function bindMobileNavigationEvents(container, user) {
  const selects = [...container.querySelectorAll('[data-mobile-nav-slot]')];
  if (!selects.length) return;

  selects.forEach((changedSelect) => {
    changedSelect.addEventListener('change', async () => {
      // Alle drei Plaetze so, wie sie dastehen. Die Anzeige ist die Wahrheit -
      // ein Wert aus dem gespeicherten Stand daneben zu mischen, verschob beim
      // Verdichten ein unberuehrtes Ziel (Gegenpruefung zur Review von #790).
      const payload = buildMobileNavigationPayload(selects.map((select) => select.value));
      selects.forEach((select) => { select.disabled = true; });

      try {
        const response = await savePreferences(payload);
        const savedOrder = response?.data?.mobile_nav_order ?? payload.mobile_nav_order;
        window.yuvomi?.setMobileNavOrder?.(savedOrder);
        window.yuvomi?.showToast(t('settings.mobileNavigationSaved'), 'success');
        await render(container, { user });
      } catch (error) {
        selects.forEach((select) => { select.disabled = false; });
        window.yuvomi?.showToast(error.message ?? t('common.errorGeneric'), 'danger');
      }
    });
  });
}

export async function render(container, { user }) {
  const isAdmin = user?.role === 'admin';
  const [preferencesResult] = await Promise.allSettled([
    getPreferences(),
  ]);

  /* OHNE PRAEFERENZEN WIRD HIER NICHT GERENDERT (Codex-Review zu PR #790).
   *
   * Vorher fuhr dieses Blatt bei einem gescheiterten `GET /preferences` mit
   * `{}` fort: jeder Ausblenden-Knopf stand auf "nicht gedrueckt", die
   * Reihenfolge kam aus den Voreinstellungen. Erholte sich die Verbindung, bevor
   * jemand klickte, schrieb der erste Klick genau diesen erfundenen Zustand als
   * Wahrheit zurueck - und loeschte damit die uebrigen Ausblendungen und die
   * gespeicherte Reihenfolge. Ein Blatt, das seinen Ausgangszustand nicht kennt,
   * darf ihn nicht speichern; es bietet einen zweiten Versuch an.
   *
   * Die Drittanbieter-Liste ist der andere Fall und bleibt tolerant: fehlt sie,
   * fehlen ein paar Zeilen, aber nichts wird falsch geschrieben - ihre Ids
   * ueberleben ueber `unrenderedOrderIds`. */
  if (preferencesResult.status !== 'fulfilled' || !preferencesResult.value) {
    container.replaceChildren();
    container.appendChild(createRetryState({
      message: preferencesResult.reason?.message ?? t('common.errorGeneric'),
      onRetry: () => render(container, { user }),
    }));
    return;
  }
  // getPreferences() liefert bereits das entpackte Preferences-Objekt (kein
  // `{ data }`-Envelope wie api.get). Ein zusätzliches `?.data` machte
  // `preferences` dauerhaft leer: disabled_modules war nie gesetzt, jeder
  // Re-Render nach einem Toggle hakte die Checkbox wieder an (#615).
  const preferences = preferencesResult.value;

  const rows = buildRows(preferences);
  /* Was in der gespeicherten Reihenfolge steht, hier aber keine Zeile hat.
   * Fuer ein Mitglied sind das seine Drittanbieter-Module: `/modules?admin=1`
   * beantwortet ihm der Server nicht, also kennt dieses Blatt sie nicht - und
   * duerfte sie deshalb erst recht nicht aus seiner Reihenfolge streichen. */
  const renderedOrderIds = new Set(expandModuleOrder(rows.map((row) => row.orderId)));
  const unrenderedOrderIds = (Array.isArray(preferences.module_order) ? preferences.module_order : [])
    .filter((id) => !renderedOrderIds.has(id));
  const availableMobileIds = mobileCandidateRows(rows).map((row) => row.orderId);
  const mobileOrder = resolveMobileNavOrder(preferences.mobile_nav_order, availableMobileIds);
  navSortables.clear();
  renderPage(container, rows, mobileOrder);

  bindModuleListEvents(container, user, rows, unrenderedOrderIds);
  bindMobileNavigationEvents(container, user);
}

// Die Endzone als Markup (test:manager-endzone).
export const __test = { rowHtml, sectionRowsHtml };
