import { api } from "/api.js";
import { dateTimeText } from '/utils/date-format.js';
import { t } from "/i18n.js";
import { confirmModal, refocusAfterRender } from "/components/modal.js";
import {
  createDisclosure,
  createInfoList,
  createRetryState,
  createSettingRow,
  createStatusSummary
} from "/settings/components.js";
import { reloadAfterSave } from '/utils/reload-after-save.js';

function formatSyncTime(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return dateTimeText(date);
}

function showToast(message, tone = "default") {
  window.yuvomi?.showToast(message, tone);
}

function buildStatusSummary(data) {
  const drive = data.google_drive ?? {};
  return createStatusSummary({
    title: t("documents.storageGoogleDrive"),
    status: drive.sync?.folder_name || t("settings.documentStorageNotConfigured"),
    details: [t("settings.documentStorageGoogleDriveCount") + ": " + Number(drive.document_count ?? 0)],
    tone: drive.sync?.last_error ? "warning" : "neutral",
    level: 2,
  });
}

function renderPage(container) {
  container.replaceChildren();
  container.insertAdjacentHTML(
    "beforeend",
    `
    <section class="settings-section">
      <div class="settings-card" id="document-storage-card">
        <div id="document-storage-banner"></div>
        <p class="settings-card-description">${t("settings.documentStorageDriveSyncDescription")}</p>
        <div id="document-storage-status-host"></div>
        <div class="settings-providers" id="document-storage-providers-host"></div>
        <div id="document-storage-destination-host"></div>
      </div>
    </section>
  `
  );
}

function providerIcon(name) {
  const icon = document.createElement("i");
  icon.dataset.lucide = name;
  icon.setAttribute("aria-hidden", "true");
  return icon;
}

// Echte Warnung (amber): der Sachverhalt kann zu Datenverlust führen.
function buildProviderWarning(text) {
  const warning = document.createElement("p");
  warning.className = "settings-document-storage-warning";
  const label = document.createElement("span");
  label.textContent = text;
  warning.append(providerIcon("triangle-alert"), label);
  return warning;
}

// Information, kein Alarm: ruhiger Ton, damit nicht zwei Warnboxen stapeln.
function buildProviderNote(text, { icon = "info", hint = false } = {}) {
  const note = document.createElement("p");
  note.className = hint ? "settings-provider-note settings-provider-note--hint" : "settings-provider-note";
  const label = document.createElement("span");
  label.textContent = text;
  note.append(providerIcon(icon), label);
  return note;
}

// Führung, wenn die OAuth-Zugangsdaten fehlen: der Verbinden-Button ist dann
// inaktiv - ohne diese Zeile bliebe unklar, wie man ihn aktiviert.
function buildDriveSetupHint() {
  const hint = buildProviderNote(t("settings.documentStorageGoogleDriveSetupHint") + " ", {
    icon: "key-round",
    hint: true
  });
  const link = document.createElement("a");
  link.href =
    "https://github.com/ulsklyc/yuvomi/blob/main/docs/installation.md#google-drive-document-storage-optional";
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = t("settings.documentStorageGoogleDriveSetupLink");
  hint.querySelector("span")?.appendChild(link);
  return hint;
}

function buildGoogleDriveSync(drive, reload) {
  const sync = drive.sync;
  if (!sync?.available) return null;
  const section = document.createElement("section");
  section.className = "settings-provider";
  const title = document.createElement("h3");
  title.textContent = t("settings.documentStorageDriveSyncTitle");
  section.appendChild(title);
  section.appendChild(buildProviderNote(t("settings.documentStorageDriveSyncDescription")));
  section.appendChild(buildProviderNote(t("settings.documentStorageDriveSyncPrivacy")));
  if (sync.reconnect_required) section.appendChild(buildProviderNote(t("settings.documentStorageDriveSyncReconnect")));
  section.appendChild(createInfoList([
    { label: t("settings.documentStorageDriveSyncLast"), value: formatSyncTime(sync.last_sync) ?? t("settings.documentStorageNeverTested") },
    ...(sync.last_error ? [{ label: t("settings.documentStorageLastError"), value: sync.last_error }] : [])
  ]));
  const form = document.createElement("form");
  form.className = "settings-form settings-form--compact";
  const enabled = document.createElement("input");
  enabled.type = "checkbox";
  enabled.checked = Boolean(sync.enabled);
  const folder = document.createElement("input");
  folder.type = "text";
  folder.className = "form-input";
  folder.value = sync.folder_id || "";
  folder.autocomplete = "off";
  const group = document.createElement("div");
  group.className = "row-carrier settings-group";
  group.appendChild(createSettingRow({ label: t("settings.documentStorageDriveSyncEnabled"), control: enabled }));
  group.appendChild(createSettingRow({ label: t("settings.documentStorageDriveSyncFolder"), description: t("settings.documentStorageDriveSyncFolderHint"), control: folder }));
  form.appendChild(group);
  const actions = document.createElement("div");
  actions.className = "settings-form-actions";
  const save = document.createElement("button");
  save.type = "submit";
  save.className = "btn btn--secondary";
  save.textContent = t("common.save");
  save.disabled = !drive.connected;
  actions.appendChild(save);
  const run = document.createElement("button");
  run.type = "button";
  run.className = "btn btn--secondary";
  run.textContent = t("settings.documentStorageDriveSyncNow");
  run.disabled = !drive.connected || !sync.enabled || sync.reconnect_required || sync.running;
  actions.appendChild(run);
  form.appendChild(actions);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    save.disabled = true;
    try {
      await api.put("/documents/storage/google-drive/sync/config", { enabled: enabled.checked, folder_id: folder.value.trim() });
      showToast(t("settings.documentStorageDriveSyncSaved"), "success");
      await reloadAfterSave(() => reload());
    } catch (error) {
      showToast(error.message ?? t("common.errorGeneric"), "danger");
      save.disabled = false;
    }
  });
  run.addEventListener("click", async () => {
    run.disabled = true;
    save.disabled = true;
    try {
      const result = await api.post("/documents/storage/google-drive/sync", {});
      if (result?.data?.skipped || result?.skipped) {
        await reloadAfterSave(() => reload());
        return;
      }
      showToast(t("settings.documentStorageDriveSyncSuccess"), "success");
      await reloadAfterSave(() => reload());
    } catch (error) {
      showToast(error.message ?? t("common.errorGeneric"), "danger");
      run.disabled = false;
      save.disabled = false;
    }
  });
  section.appendChild(form);
  return section;
}

function buildGoogleDriveProvider(data, reload) {
  const drive = data.google_drive ?? {};
  const provider = document.createElement("section");
  provider.className = "settings-provider";

  // Statuszeile statt wiederholter Überschrift: die Disclosure benennt bereits
  // "Google Drive". Nur "Verbunden" trägt einen Success-Ton; die übrigen Zustände
  // bleiben neutral - "noch nicht verbunden" ist kein Fehler.
  const status = document.createElement("div");
  status.className = "settings-provider__status";
  const badge = document.createElement("span");
  badge.className = drive.connected
    ? "settings-provider__badge settings-provider__badge--connected"
    : "settings-provider__badge";
  badge.textContent = drive.connected
    ? t("settings.connected")
    : drive.configured
      ? t("settings.notConnected")
      : t("settings.notConfigured");
  status.appendChild(badge);
  provider.appendChild(status);

  const description = document.createElement("p");
  description.className = "settings-card-description";
  description.textContent = t("settings.documentStorageGoogleDriveDescription");
  provider.appendChild(description);
  provider.appendChild(
    createInfoList([
      { label: t("settings.documentStorageGoogleDriveAccount"), value: drive.account_email || "-" },
      { label: t("settings.documentStorageGoogleDriveFolder"), value: drive.folder_name || "Yuvomi/Documents" },
      { label: t("settings.documentStorageGoogleDriveCount"), value: String(Number(drive.document_count ?? 0)) },
      {
        label: t("settings.documentStorageLastTest"),
        value: formatSyncTime(drive.last_test) ?? t("settings.documentStorageNeverTested")
      },
      drive.last_error
        ? { label: t("settings.documentStorageLastError"), value: drive.last_error, tone: "danger" }
        : null
    ])
  );

  // Backup-Hinweis bleibt eine echte Warnung (DB-Backups sichern Drive-Metadaten,
  // nicht die Binärdateien). Der Datenschutz-Hinweis ist Information, kein Alarm.
  provider.appendChild(buildProviderWarning(t("settings.documentStorageBackupWarning")));
  provider.appendChild(buildProviderNote(t("settings.documentStorageGoogleDrivePrivacy")));
  if (!drive.configured) provider.appendChild(buildDriveSetupHint());

  const actions = document.createElement("div");
  actions.className = "settings-form-actions";
  // Verbinden ist die Kernaktion, solange nichts verbunden ist → Primary
  // (Modul-Akzent). Nach Verbindung tritt "Neu verbinden" als Secondary zurück.
  const connect = document.createElement("a");
  connect.className = drive.connected ? "btn btn--secondary" : "btn btn--primary";
  connect.href = "/api/v1/documents/storage/google-drive/auth";
  connect.textContent = drive.connected
    ? t("settings.documentStorageGoogleDriveReconnect")
    : t("settings.documentStorageGoogleDriveConnect");
  if (!drive.configured) {
    connect.className = "btn btn--secondary";
    connect.removeAttribute("href");
    connect.setAttribute("aria-disabled", "true");
  }
  actions.appendChild(connect);

  if (drive.connected) {
    const testButton = document.createElement("button");
    testButton.type = "button";
    testButton.className = "btn btn--secondary";
    testButton.textContent = t("settings.documentStorageTest");
    testButton.addEventListener("click", async () => {
      testButton.disabled = true;
      try {
        await api.post("/documents/storage/google-drive/test", {});
        showToast(t("settings.documentStorageTestSuccess"), "success");
        await reloadAfterSave(() => reload());
      } catch (error) {
        showToast(error.message ?? t("common.errorGeneric"), "danger");
      } finally {
        testButton.disabled = false;
      }
    });
    actions.appendChild(testButton);

    const disconnect = document.createElement("button");
    disconnect.type = "button";
    disconnect.className = "btn btn--danger";
    disconnect.textContent = t("settings.disconnect");
    disconnect.disabled = !drive.can_disconnect;
    if (!drive.can_disconnect) disconnect.title = t("settings.documentStorageGoogleDriveDisconnectBlocked");
    disconnect.addEventListener("click", async () => {
      const confirmed = await confirmModal(t("settings.documentStorageGoogleDriveDisconnectConfirm"), {
        confirmLabel: t("settings.disconnect")
      });
      if (!confirmed) return;
      disconnect.disabled = true;
      try {
        await api.delete("/documents/storage/google-drive/disconnect");
        showToast(
          t("settings.disconnectedToast", { provider: t("settings.documentStorageGoogleDriveTitle") }),
          "success"
        );
        await reload();
        refocusAfterRender();
      } catch (error) {
        showToast(error.message ?? t("common.errorGeneric"), "danger");
        disconnect.disabled = false;
      }
    });
    actions.appendChild(disconnect);
  }
  provider.appendChild(actions);
  const syncSection = buildGoogleDriveSync(drive, reload);
  if (syncSection) provider.appendChild(syncSection);
  return provider;
}

function handleDriveOAuthCallback(container, query) {
  const params = query instanceof URLSearchParams ? query : new URLSearchParams(query || "");
  const ok = params.get("drive_ok");
  const error = params.get("drive_error");
  if (!ok && !error) return;
  const banner = document.createElement("div");
  banner.className = `settings-banner ${ok ? "settings-banner--success" : "settings-banner--error"}`;
  banner.setAttribute("role", ok ? "status" : "alert");
  banner.textContent = ok
    ? t("settings.documentStorageGoogleDriveOAuthSuccess")
    : t("settings.documentStorageGoogleDriveOAuthError");
  container.querySelector("#document-storage-banner")?.replaceChildren(banner);
  try {
    const url = new URL(location.href);
    url.searchParams.delete("drive_ok");
    url.searchParams.delete("drive_error");
    history.replaceState(history.state, "", url.pathname + url.search + url.hash);
  } catch {
    // Ignore unavailable location state in restricted contexts.
  }
}

async function loadDocumentStorageConfig(container) {
  const statusHost = container.querySelector("#document-storage-status-host");
  const destinationHost = container.querySelector("#document-storage-destination-host");
  const providersHost = container.querySelector("#document-storage-providers-host");
  if (!statusHost || !destinationHost || !providersHost) return;

  const reload = () => loadDocumentStorageConfig(container);

  let data;
  try {
    const res = await api.get("/documents/storage/config");
    data = res.data ?? {};
  } catch (err) {
    statusHost.replaceChildren(
      createRetryState({
        message: err.message || t("common.errorGeneric"),
        onRetry: reload
      })
    );
    destinationHost.replaceChildren();
    providersHost.replaceChildren();
    return;
  }

  statusHost.replaceChildren(buildStatusSummary(data));

  const drive = createDisclosure({
    id: "document-storage-google-drive",
    summary: t("settings.documentStorageGoogleDriveTitle"),
    expanded: true,
    content: buildGoogleDriveProvider(data, reload)
  });
  providersHost.replaceChildren(drive);
  destinationHost.replaceChildren();
  window.lucide?.createIcons({ el: container });
}

export async function render(container, { query } = {}) {
  renderPage(container);
  handleDriveOAuthCallback(container, query);
  await loadDocumentStorageConfig(container);
  window.lucide?.createIcons({ el: container });
}
