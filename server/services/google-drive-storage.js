import { randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { google } from 'googleapis';
import * as db from '../db.js';
import { createLogger } from '../logger.js';
import { MAX_UPLOAD_BYTES } from '../utils/upload-limit.js';
import { hasActiveWriteRequests, getWriteRequestRevision } from '../utils/restore-state.js';

const log = createLogger('GoogleDriveStorage');
const CONFIG_PREFIX = 'document_storage_google_drive_';
const SELECTED_BACKEND_KEY = 'document_storage_selected_backend';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const READ_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const PDF_EXPORT_TYPES = new Set(['application/vnd.google-apps.document', 'application/vnd.google-apps.spreadsheet', 'application/vnd.google-apps.presentation']);
let syncRunning = false;
let configMutationRunning = false;
let activeUploads = 0;
export function isSyncAvailable() { return process.env.GOOGLE_DRIVE_SYNC_ENABLED === 'true'; }
export function preservesRemoteFiles() { return isSyncAvailable() || Boolean(cfgGet('sync_folder_id')); }
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const APP_FOLDER_NAME = 'Yuvomi';
const DOCUMENTS_FOLDER_NAME = 'Documents';
const DISPLAY_FOLDER_NAME = `${APP_FOLDER_NAME}/${DOCUMENTS_FOLDER_NAME}`;
const MAX_READ_BYTES = MAX_UPLOAD_BYTES;

const defaultGoogleApiFactory = {
  createOAuth2: (clientId, clientSecret, redirectUri) => (
    new google.auth.OAuth2(clientId, clientSecret, redirectUri)
  ),
  createDrive: (auth) => google.drive({ version: 'v3', auth }),
};
let googleApiFactory = defaultGoogleApiFactory;

export class GoogleDriveStorageError extends Error {
  constructor(storageCode, message, options = {}) {
    super(message, options);
    this.name = 'GoogleDriveStorageError';
    this.storageCode = storageCode;
  }
}

function cfgGet(field) {
  return db.get().prepare('SELECT value FROM sync_config WHERE key = ?')
    .get(`${CONFIG_PREFIX}${field}`)?.value ?? null;
}

function cfgSet(field, value) {
  db.get().prepare(`
    INSERT INTO sync_config (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  `).run(`${CONFIG_PREFIX}${field}`, String(value));
}

function cfgDel(field) {
  db.get().prepare('DELETE FROM sync_config WHERE key = ?')
    .run(`${CONFIG_PREFIX}${field}`);
}

const PARTIAL_CREDENTIAL_MESSAGE = 'GOOGLE_DRIVE_CLIENT_ID and GOOGLE_DRIVE_CLIENT_SECRET must both be set or both be empty.';

function credentialConfig() {
  const driveClientId = String(process.env.GOOGLE_DRIVE_CLIENT_ID || '').trim();
  const driveClientSecret = String(process.env.GOOGLE_DRIVE_CLIENT_SECRET || '').trim();
  const fallbackClientId = String(process.env.GOOGLE_CLIENT_ID || '').trim();
  const fallbackClientSecret = String(process.env.GOOGLE_CLIENT_SECRET || '').trim();
  const redirectUri = String(process.env.GOOGLE_DRIVE_REDIRECT_URI || '').trim();
  const hasDriveClientId = Boolean(driveClientId);
  const hasDriveClientSecret = Boolean(driveClientSecret);
  if (hasDriveClientId !== hasDriveClientSecret) {
    throw new GoogleDriveStorageError(
      'DOCUMENT_STORAGE_INVALID_CONFIG',
      PARTIAL_CREDENTIAL_MESSAGE
    );
  }
  return {
    clientId: hasDriveClientId ? driveClientId : fallbackClientId,
    clientSecret: hasDriveClientSecret ? driveClientSecret : fallbackClientSecret,
    redirectUri,
  };
}

function createClient() {
  const config = credentialConfig();
  if (!config.clientId || !config.clientSecret || !config.redirectUri) {
    throw new GoogleDriveStorageError(
      'DOCUMENT_STORAGE_NOT_CONFIGURED',
      'Google Drive OAuth credentials and GOOGLE_DRIVE_REDIRECT_URI must be configured.'
    );
  }
  return googleApiFactory.createOAuth2(
    config.clientId,
    config.clientSecret,
    config.redirectUri
  );
}

function attachTokenPersistence(client) {
  client.on?.('tokens', (tokens) => {
    if (tokens.access_token) cfgSet('access_token', tokens.access_token);
    if (tokens.expiry_date) cfgSet('token_expiry', tokens.expiry_date);
  });
}

function loadAuthorizedClient() {
  const refreshToken = cfgGet('refresh_token');
  if (!refreshToken) {
    throw new GoogleDriveStorageError(
      'DOCUMENT_STORAGE_NOT_CONFIGURED',
      'Google Drive is not connected.'
    );
  }
  const client = createClient();
  client.setCredentials({
    access_token: cfgGet('access_token') || undefined,
    refresh_token: refreshToken,
    expiry_date: cfgGet('token_expiry')
      ? Number.parseInt(cfgGet('token_expiry'), 10)
      : undefined,
  });
  attachTokenPersistence(client);
  return client;
}

function createDrive(client = loadAuthorizedClient()) {
  return googleApiFactory.createDrive(client);
}

function isNotFound(error) {
  return error?.code === 404
    || error?.status === 404
    || error?.response?.status === 404;
}

function driveQueryLiteral(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function findFolder(drive, name, parentId = null) {
  const parentClause = parentId ? ` and '${driveQueryLiteral(parentId)}' in parents` : '';
  const response = await drive.files.list({
    q: `name = '${driveQueryLiteral(name)}' and mimeType = '${FOLDER_MIME}' and trashed = false${parentClause}`,
    spaces: 'drive',
    fields: 'files(id,name)',
    pageSize: 1,
  });
  return response.data.files?.[0] ?? null;
}

async function createFolder(drive, name, parentId = null) {
  const response = await drive.files.create({
    requestBody: {
      name,
      mimeType: FOLDER_MIME,
      ...(parentId ? { parents: [parentId] } : {}),
    },
    fields: 'id,name',
  });
  return response.data;
}

async function ensureAppFolder(drive, { persist = true } = {}) {
  const storedId = cfgGet('folder_id');
  if (storedId) {
    try {
      const response = await drive.files.get({
        fileId: storedId,
        fields: 'id,name,mimeType,trashed',
      });
      if (response.data.mimeType === FOLDER_MIME && response.data.trashed !== true) {
        return { id: response.data.id, name: DISPLAY_FOLDER_NAME };
      }
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  const appFolder = await findFolder(drive, APP_FOLDER_NAME)
    || await createFolder(drive, APP_FOLDER_NAME);
  const documentsFolder = await findFolder(drive, DOCUMENTS_FOLDER_NAME, appFolder.id)
    || await createFolder(drive, DOCUMENTS_FOLDER_NAME, appFolder.id);
  if (persist) {
    cfgSet('folder_id', documentsFolder.id);
    cfgSet('folder_name', DISPLAY_FOLDER_NAME);
  }
  return { id: documentsFolder.id, name: DISPLAY_FOLDER_NAME };
}

async function streamToBuffer(value) {
  if (Buffer.isBuffer(value)) {
    if (value.length > MAX_READ_BYTES) {
      throw new GoogleDriveStorageError(
        'DOCUMENT_STORAGE_READ_FAILED',
        'The Google Drive document exceeds the maximum readable size.'
      );
    }
    return value;
  }
  if (value instanceof Uint8Array || typeof value === 'string') {
    return streamToBuffer(Buffer.from(value));
  }
  if (!value || typeof value[Symbol.asyncIterator] !== 'function') {
    throw new GoogleDriveStorageError(
      'DOCUMENT_STORAGE_READ_FAILED',
      'Google Drive returned an unreadable document response.'
    );
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of value) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_READ_BYTES) {
      throw new GoogleDriveStorageError(
        'DOCUMENT_STORAGE_READ_FAILED',
        'The Google Drive document exceeds the maximum readable size.'
      );
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

function safeOriginalName(value) {
  const basename = String(value || 'document').split(/[\\/]/).pop() || 'document';
  return basename.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180) || 'document';
}

function driveDocumentCount() {
  return db.get().prepare(`
    SELECT COUNT(*) AS count
    FROM family_documents
    WHERE storage_backend = 'google_drive'
  `).get().count;
}

function selectedBackend() {
  return db.get().prepare('SELECT value FROM sync_config WHERE key = ?')
    .get(SELECTED_BACKEND_KEY)?.value ?? null;
}

export function getAuthUrl(session) {
  const client = createClient();
  const state = randomBytes(32).toString('hex');
  if (session) session.googleDriveOAuthState = state;
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: isSyncAvailable() ? [DRIVE_SCOPE, READ_SCOPE] : [DRIVE_SCOPE],
    state,
  });
}

async function withConfigMutation(action) {
  if (syncRunning) throw new GoogleDriveStorageError('DOCUMENT_STORAGE_CONFIG_PROTECTED', 'A Google Drive sync is running.');
  if (configMutationRunning || activeUploads || hasActiveWriteRequests()) {
    throw new GoogleDriveStorageError('DOCUMENT_STORAGE_CONFIG_PROTECTED', 'Another document storage operation is running.');
  }
  configMutationRunning = true;
  try { return await action(); }
  finally { configMutationRunning = false; }
}

function driveBinding() {
  return {
    accountId: cfgGet('account_id'),
    sourceFolderId: cfgGet('sync_folder_id'),
    documents: db.get().prepare("SELECT storage_key, external_meta FROM family_documents WHERE storage_backend = 'google_drive' ORDER BY id").all(),
  };
}

function assertBindingUnchanged(binding) {
  if (JSON.stringify(driveBinding()) !== JSON.stringify(binding)) {
    throw new GoogleDriveStorageError('DOCUMENT_STORAGE_CONFIG_PROTECTED', 'The document storage binding changed. Retry the configuration.');
  }
}

export async function handleCallback(code, ownerId) {
  return withConfigMutation(() => handleCallbackLocked(code, ownerId));
}

async function handleCallbackLocked(code, ownerId) {
  const binding = driveBinding();
  const candidate = createClient();
  const { tokens } = await candidate.getToken(code);
  if (!tokens.refresh_token) {
    throw new GoogleDriveStorageError(
      'DOCUMENT_STORAGE_NOT_CONFIGURED',
      'Google did not return a refresh token. Revoke the previous grant and reconnect.'
    );
  }
  candidate.setCredentials(tokens);
  const drive = createDrive(candidate);
  const about = await drive.about.get({
    fields: 'user(displayName,emailAddress,permissionId)',
  });
  const account = about.data.user;
  if (!account?.permissionId) {
    throw new GoogleDriveStorageError(
      'DOCUMENT_STORAGE_CONNECTION_TEST_FAILED',
      'Google Drive did not return a stable account identity.'
    );
  }

  if (binding.documents.length || binding.sourceFolderId) {
    if (!binding.accountId || binding.accountId !== account.permissionId) {
      throw new GoogleDriveStorageError(
        'DOCUMENT_STORAGE_CONFIG_PROTECTED',
        'The connected Google account does not match the account that stores existing documents.'
      );
    }
    const representative = binding.documents.find(document => {
      try { return JSON.parse(document.external_meta || '{}')?.drive_sync?.available !== false; }
      catch { return true; }
    });
    try {
      if (representative) {
        await drive.files.get({ fileId: representative.storage_key, fields: 'id' });
      } else if (binding.sourceFolderId) {
        const source = (await drive.files.get({ fileId: binding.sourceFolderId, fields: 'id,mimeType,trashed' })).data;
        if (source.mimeType !== FOLDER_MIME || source.trashed) throw new Error('Source folder unavailable.');
      }
    } catch (error) {
      throw new GoogleDriveStorageError(
        'DOCUMENT_STORAGE_CONFIG_PROTECTED',
        'The proposed Google Drive connection cannot read an existing document or the source folder.',
        { cause: error }
      );
    }
  }

  const folder = await ensureAppFolder(drive, { persist: false });
  assertBindingUnchanged(binding);
  db.get().transaction(() => {
    if (tokens.access_token) cfgSet('access_token', tokens.access_token);
    else cfgDel('access_token');
    cfgSet('refresh_token', tokens.refresh_token);
    if (tokens.expiry_date) cfgSet('token_expiry', tokens.expiry_date);
    else cfgDel('token_expiry');
    cfgSet('folder_id', folder.id);
    cfgSet('folder_name', folder.name);
    cfgSet('account_id', account.permissionId);
    cfgSet('granted_scopes', tokens.scope || '');
    if (ownerId) cfgSet('sync_owner_id', ownerId);
    if (account.emailAddress) cfgSet('account_email', account.emailAddress);
    else cfgDel('account_email');
    if (account.displayName) cfgSet('account_name', account.displayName);
    else cfgDel('account_name');
    cfgDel('last_error');
  })();
  log.info('Google Drive OAuth connection saved.');
  return getStatus();
}

export function getStatus() {
  let config = null;
  let configurationError = null;
  try {
    config = credentialConfig();
  } catch (error) {
    if (
      error instanceof GoogleDriveStorageError
      && error.storageCode === 'DOCUMENT_STORAGE_INVALID_CONFIG'
    ) {
      configurationError = error;
    } else {
      throw error;
    }
  }
  const configured = Boolean(
    !configurationError
    && config?.clientId
    && config.clientSecret
    && config.redirectUri
  );
  const connected = Boolean(
    configured
    && cfgGet('refresh_token')
    && cfgGet('account_id')
    && cfgGet('folder_id')
  );
  const documentCount = driveDocumentCount();
  return {
    configured,
    connected,
    sync: getSyncStatus(),
    account_email: cfgGet('account_email'),
    account_name: cfgGet('account_name'),
    folder_name: cfgGet('sync_enabled') === 'true' && cfgGet('sync_folder_id') ? cfgGet('sync_folder_name') : cfgGet('folder_name') || DISPLAY_FOLDER_NAME,
    document_count: documentCount,
    last_test: cfgGet('last_test'),
    last_error: configurationError?.message || cfgGet('last_error'),
    can_disconnect: documentCount === 0 && selectedBackend() !== 'google_drive',
  };
}

export async function uploadFile(options = {}) {
  if (configMutationRunning) throw new GoogleDriveStorageError('DOCUMENT_STORAGE_CONFIG_PROTECTED', 'Google Drive configuration is changing. Retry the upload.');
  activeUploads++;
  try { return await uploadFileLocked(options); }
  finally { activeUploads--; }
}

async function uploadFileLocked({ buffer, mime = 'application/octet-stream', originalName } = {}) {
  const content = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  const drive = createDrive();
  const syncDestination = cfgGet('sync_enabled') === 'true' && cfgGet('sync_folder_id');
  const folder = syncDestination
    ? { id: syncDestination }
    : await ensureAppFolder(drive);
  try {
    const response = await drive.files.create({
      requestBody: {
        name: syncDestination ? safeOriginalName(originalName) : `${randomUUID()}-${safeOriginalName(originalName)}`,
        parents: [folder.id],
      },
      media: {
        mimeType: mime,
        body: Readable.from(content),
      },
      fields: 'id',
    });
    if (!response.data.id) throw new Error('Google Drive did not return a file ID.');
    return response.data.id;
  } catch (error) {
    if (error instanceof GoogleDriveStorageError) throw error;
    throw new GoogleDriveStorageError(
      'DOCUMENT_STORAGE_UPLOAD_FAILED',
      'The document could not be uploaded to Google Drive.',
      { cause: error }
    );
  }
}

export async function readFile(fileId) {
  const drive = createDrive();
  try {
    const metadata = await drive.files.get({
      fileId,
      fields: 'id,size,mimeType',
    });
    const size = Number(metadata.data.size);
    if (Number.isFinite(size) && size > MAX_READ_BYTES) {
      throw new GoogleDriveStorageError(
        'DOCUMENT_STORAGE_READ_FAILED',
        'The Google Drive document exceeds the maximum readable size.'
      );
    }
    const nativeType = metadata.data.mimeType?.startsWith('application/vnd.google-apps.');
    if (nativeType && !PDF_EXPORT_TYPES.has(metadata.data.mimeType)) {
      throw new GoogleDriveStorageError('DOCUMENT_STORAGE_READ_FAILED', 'This Google Drive document type cannot be exported.');
    }
    const response = nativeType
      ? await drive.files.export({ fileId, mimeType: 'application/pdf' }, { responseType: 'stream' })
      : await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
    return {
      buffer: await streamToBuffer(response.data),
      mime: nativeType ? 'application/pdf' : metadata.data.mimeType || 'application/octet-stream',
    };
  } catch (error) {
    if (error instanceof GoogleDriveStorageError) throw error;
    throw new GoogleDriveStorageError(
      'DOCUMENT_STORAGE_READ_FAILED',
      'The Google Drive document could not be read.',
      { cause: error }
    );
  }
}

export async function deleteFile(fileId) {
  const drive = createDrive();
  try {
    await drive.files.delete({ fileId });
  } catch (error) {
    if (isNotFound(error)) return;
    throw new GoogleDriveStorageError(
      'DOCUMENT_STORAGE_DELETE_FAILED',
      'The Google Drive document could not be deleted.',
      { cause: error }
    );
  }
}

export async function testConnection() {
  const expected = Buffer.from(`yuvomi-google-drive-test:${randomUUID()}`);
  let fileId = null;
  try {
    fileId = await uploadFile({
      buffer: expected,
      mime: 'application/octet-stream',
      originalName: '.connection-test.bin',
    });
    const actual = await readFile(fileId);
    if (!actual.buffer.equals(expected)) {
      throw new Error('Google Drive roundtrip verification failed.');
    }
    await deleteFile(fileId);
    fileId = null;
    cfgSet('last_test', new Date().toISOString());
    cfgDel('last_error');
    return { ok: true };
  } catch (error) {
    if (fileId) {
      try {
        await deleteFile(fileId);
      } catch {
        // Preserve the primary test failure.
      }
    }
    if (
      error instanceof GoogleDriveStorageError
      && (
        error.storageCode === 'DOCUMENT_STORAGE_INVALID_CONFIG'
        || error.storageCode === 'DOCUMENT_STORAGE_NOT_CONFIGURED'
      )
    ) {
      throw error;
    }
    cfgSet('last_error', 'Google Drive connection test failed.');
    throw new GoogleDriveStorageError(
      'DOCUMENT_STORAGE_CONNECTION_TEST_FAILED',
      'The Google Drive connection test failed.',
      { cause: error }
    );
  }
}

export function disconnect() {
  if (configMutationRunning || activeUploads || hasActiveWriteRequests()) throw new GoogleDriveStorageError('DOCUMENT_STORAGE_CONFIG_PROTECTED', 'Another document storage operation is running.');
  if (syncRunning) throw new GoogleDriveStorageError('DOCUMENT_STORAGE_CONFIG_PROTECTED', 'A Google Drive sync is running.');
  const count = driveDocumentCount();
  if (count > 0) {
    throw new GoogleDriveStorageError(
      'DOCUMENT_STORAGE_CONFIG_PROTECTED',
      'Google Drive cannot be disconnected while Drive-backed documents exist.'
    );
  }
  if (selectedBackend() === 'google_drive') {
    throw new GoogleDriveStorageError(
      'DOCUMENT_STORAGE_CONFIG_PROTECTED',
      'Select another upload destination before disconnecting Google Drive.'
    );
  }
  // Escape LIKE wildcards in the prefix so each literal underscore stays literal;
  // otherwise the sweep could widen to unrelated document_storage_* keys.
  const escapedPrefix = CONFIG_PREFIX.replace(/[\\%_]/g, '\\$&');
  db.get().prepare("DELETE FROM sync_config WHERE key LIKE ? ESCAPE '\\'")
    .run(`${escapedPrefix}%`);
  log.info('Google Drive disconnected without revoking shared OAuth credentials.');
}

export function __setGoogleApiFactoryForTests(factory) {
  googleApiFactory = factory || defaultGoogleApiFactory;
}

export const __test = {
  DRIVE_SCOPE,
  MAX_READ_BYTES,
  createClient,
  loadAuthorizedClient,
  ensureAppFolder,
  streamToBuffer,
};


function getSyncStatus() {
  return {
    available: isSyncAvailable(),
    enabled: isSyncAvailable() && cfgGet('sync_enabled') === 'true',
    reconnect_required: isSyncAvailable() && !String(cfgGet('granted_scopes')).split(' ').includes(READ_SCOPE),
    folder_id: cfgGet('sync_folder_id'), folder_name: cfgGet('sync_folder_name'),
    last_sync: cfgGet('sync_last_sync'), last_error: cfgGet('sync_last_error'), running: syncRunning,
  };
}

export async function configureSync(options = {}, ownerId) {
  return withConfigMutation(() => configureSyncLocked(options, ownerId));
}

async function configureSyncLocked({ enabled, folder_id: folderId } = {}, ownerId) {
  const binding = driveBinding();
  if (!isSyncAvailable()) throw new GoogleDriveStorageError('DOCUMENT_STORAGE_INVALID_CONFIG', 'Google Drive sync is not enabled on this server.');
  if (syncRunning) throw new GoogleDriveStorageError('DOCUMENT_STORAGE_CONFIG_PROTECTED', 'A Google Drive sync is running.');
  if (typeof enabled !== 'boolean') throw new GoogleDriveStorageError('DOCUMENT_STORAGE_INVALID_CONFIG', 'enabled must be a boolean.');
  if (!enabled) { cfgSet('sync_enabled', false); return getStatus(); }
  if (getSyncStatus().reconnect_required) throw new GoogleDriveStorageError('DOCUMENT_STORAGE_NOT_CONFIGURED', 'Reconnect Google Drive to grant read access for sync.');
  if (typeof folderId !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(folderId)) throw new GoogleDriveStorageError('DOCUMENT_STORAGE_INVALID_CONFIG', 'A valid Google Drive source folder ID is required.');
  const folder = (await createDrive().files.get({ fileId: folderId, fields: 'id,name,mimeType,trashed' })).data;
  if (folder.mimeType !== FOLDER_MIME || folder.trashed) throw new GoogleDriveStorageError('DOCUMENT_STORAGE_INVALID_CONFIG', 'The source must be an available Google Drive folder.');
  assertBindingUnchanged(binding);
  if (!db.get().prepare('SELECT id FROM users WHERE id = ?').get(ownerId)) throw new GoogleDriveStorageError('DOCUMENT_STORAGE_INVALID_CONFIG', 'A valid sync owner is required.');
  db.get().transaction(() => {
    cfgSet('sync_folder_id', folderId); cfgSet('sync_folder_name', folder.name);
    cfgSet('sync_owner_id', ownerId); cfgSet('sync_enabled', true); cfgDel('sync_last_error');
  })();
  return getStatus();
}

export function suppressSyncDocument(document) {
  if (!preservesRemoteFiles() || document.storage_backend !== 'google_drive' || !document.storage_key) return;
  db.get().prepare('INSERT OR IGNORE INTO google_drive_sync_tombstones (account_id, file_id) VALUES (?, ?)')
    .run(cfgGet('account_id') || '', document.storage_key);
}

export async function syncNow() {
  const status = getSyncStatus();
  if (!status.enabled) return { skipped: 'disabled' };
  if (configMutationRunning) return { skipped: 'configuration' };
  if (activeUploads || hasActiveWriteRequests()) return { skipped: 'write_in_progress' };
  const writeRevision = getWriteRequestRevision();
  if (syncRunning) return { skipped: 'running' };
  if (status.reconnect_required) throw new GoogleDriveStorageError('DOCUMENT_STORAGE_NOT_CONFIGURED', 'Reconnect Google Drive before syncing.');
  syncRunning = true;
  try {
    const database = db.get();
    const ownerId = Number(cfgGet('sync_owner_id'));
    const accountId = cfgGet('account_id') || '';
    if (!database.prepare('SELECT id FROM users WHERE id = ?').get(ownerId)) throw new Error('The Google Drive sync owner no longer exists.');
    const drive = createDrive();
    const root = status.folder_id;
    const rootMetadata = (await drive.files.get({ fileId: root, fields: 'id,mimeType,trashed' })).data;
    if (rootMetadata.mimeType !== FOLDER_MIME || rootMetadata.trashed) throw new Error('The Google Drive source folder is unavailable.');
    const queue = [root], visited = new Set(), files = new Map();
    let pages = 0;
    while (queue.length) {
      const folder = queue.shift();
      if (visited.has(folder)) continue;
      visited.add(folder);
      if (visited.size > 100) throw new Error('Google Drive sync exceeded the 100-folder limit.');
      let pageToken;
      do {
        if (++pages > 200) throw new Error('Google Drive sync exceeded the 200-page limit.');
        const response = await drive.files.list({
          q: `'${driveQueryLiteral(folder)}' in parents and trashed = false`, spaces: 'drive',
          pageSize: 100, pageToken, fields: 'nextPageToken,incompleteSearch,files(id,name,mimeType,size,modifiedTime)',
        });
        if (response.data.incompleteSearch) throw new Error('Google Drive returned an incomplete folder listing.');
        for (const file of response.data.files || []) {
          if (!file.id) throw new Error('Google Drive returned a file without an ID.');
          if (file.mimeType === FOLDER_MIME) queue.push(file.id);
          else files.set(file.id, file);
          if (files.size + queue.length > 10000) throw new Error('Google Drive sync exceeded the 10000-entry limit.');
        }
        pageToken = response.data.nextPageToken;
      } while (pageToken);
    }
    if (activeUploads || hasActiveWriteRequests() || getWriteRequestRevision() !== writeRevision) return { skipped: 'write_in_progress' };
    const counts = { imported: 0, updated: 0, unavailable: 0, skipped: 0 };
    // No writes or missing detection until every folder and page was read successfully.
    database.transaction(() => {
      for (const file of files.values()) {
        const native = file.mimeType?.startsWith('application/vnd.google-apps.');
        if ((native && !PDF_EXPORT_TYPES.has(file.mimeType)) || Number(file.size) > MAX_READ_BYTES) { counts.skipped++; continue; }
        if (database.prepare('SELECT 1 FROM google_drive_sync_tombstones WHERE account_id = ? AND file_id = ?').get(accountId, file.id)) { counts.skipped++; continue; }
        const existing = database.prepare("SELECT id, external_meta FROM family_documents WHERE storage_backend = 'google_drive' AND storage_key = ?").get(file.id);
        let meta = {};
        try { meta = JSON.parse(existing?.external_meta || '{}') || {}; } catch { /* Old metadata may be malformed. */ }
        const externalMeta = JSON.stringify({ ...meta, drive_sync: { available: true, source_folder_id: root, modified_time: file.modifiedTime || null } });
        const name = safeOriginalName(file.name);
        const original = native ? `${name}.pdf` : name;
        const mime = native ? 'application/pdf' : file.mimeType || 'application/octet-stream';
        const size = Number(file.size) || 0;
        if (existing) {
          database.prepare("UPDATE family_documents SET name = ?, original_name = ?, mime_type = ?, file_size = ?, external_meta = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?")
            .run(name, original, mime, size, externalMeta, existing.id);
          counts.updated++;
        } else {
          database.prepare("INSERT INTO family_documents (name,original_name,mime_type,file_size,content_data,storage_provider,storage_backend,storage_key,created_by,visibility,external_meta) VALUES (?,?,?,?,?,'external','google_drive',?,?,'private',?)")
            .run(name, original, mime, size, '', file.id, ownerId, externalMeta);
          counts.imported++;
        }
      }
      for (const row of database.prepare("SELECT id,storage_key,external_meta FROM family_documents WHERE storage_backend = 'google_drive'").all()) {
        let meta;
        try { meta = JSON.parse(row.external_meta || '{}'); } catch { continue; }
        if (meta?.drive_sync?.source_folder_id !== root || files.has(row.storage_key) || meta.drive_sync.available === false) continue;
        meta.drive_sync.available = false;
        database.prepare("UPDATE family_documents SET external_meta = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?").run(JSON.stringify(meta), row.id);
        counts.unavailable++;
      }
      cfgSet('sync_last_sync', new Date().toISOString()); cfgDel('sync_last_error');
    })();
    return counts;
  } catch (error) {
    cfgSet('sync_last_error', 'Google Drive sync failed. Check the connection, source folder and scan limits.');
    throw new GoogleDriveStorageError('DOCUMENT_STORAGE_SYNC_FAILED', 'Google Drive sync failed. Check the connection, source folder and scan limits.', { cause: error });
  } finally { syncRunning = false; }
}

export const syncIfEnabled = syncNow;
