import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'google-drive-sync-test-secret';
process.env.GOOGLE_DRIVE_CLIENT_ID = 'client';
process.env.GOOGLE_DRIVE_CLIENT_SECRET = 'secret';
process.env.GOOGLE_DRIVE_REDIRECT_URI = 'https://example.test/callback';
process.env.GOOGLE_DRIVE_SYNC_ENABLED = 'true';
const db = await import('../server/db.js');
const drive = await import('../server/services/google-drive-storage.js');
const documentStorage = await import('../server/services/document-storage.js');
const { default: driveRouter } = await import('../server/routes/document-storage-google-drive.js');
const { trackWriteRequest, untrackWriteRequest } = await import('../server/utils/restore-state.js');
const original = db.get();
const database = new Database(':memory:');
database.exec(`
  CREATE TABLE sync_config (key TEXT PRIMARY KEY,value TEXT,updated_at TEXT);
  CREATE TABLE users (id INTEGER PRIMARY KEY);
  INSERT INTO users VALUES (7);
  CREATE TABLE family_documents (
    id INTEGER PRIMARY KEY, name TEXT, original_name TEXT,mime_type TEXT,file_size INTEGER,
    content_data TEXT,storage_provider TEXT,storage_backend TEXT,storage_key TEXT,created_by INTEGER,
    visibility TEXT,description TEXT,category TEXT DEFAULT 'other',status TEXT DEFAULT 'active',
    expires_at TEXT,external_meta TEXT,updated_at TEXT
  );
  CREATE TABLE google_drive_sync_tombstones (account_id TEXT,file_id TEXT,PRIMARY KEY(account_id,file_id));
`);
db._setTestDatabase(database);
database.exec(db.MIGRATIONS.find(migration => migration.version === 261).up.replace(/CREATE TABLE google_drive_sync_tombstones[\s\S]*?\);/, ''));
const prefix = 'document_storage_google_drive_';
function cfg(key,value) { database.prepare('INSERT OR REPLACE INTO sync_config (key,value) VALUES (?,?)').run(prefix + key,String(value)); }
const folderType = 'application/vnd.google-apps.folder';
const readonly = 'https://www.googleapis.com/auth/drive.readonly';
let listing, getFile, exported, authOptions, created, deleted, tokenLoad, createFile;
const factory = {
  createOAuth2: () => ({ getToken: (...args) => tokenLoad(...args), setCredentials() {}, on() {}, generateAuthUrl(options) { authOptions = options; return 'auth'; } }),
  createDrive: () => ({ about:{ get: async () => ({ data:{ user:{ permissionId:'account' } } }) }, files: {
    create: options => createFile(options),
    delete: async ({ fileId }) => { deleted.push(fileId); },
    get: async (options) => options.alt ? { data: Buffer.from('binary') } : { data: await getFile(options.fileId) },
    list: async (options) => ({ data: await listing(options) }),
    export: async (options) => { exported = options; return { data: Buffer.from('pdf') }; },
  } }),
};
function reset() {
  database.exec('DELETE FROM family_documents; DELETE FROM sync_config; DELETE FROM google_drive_sync_tombstones;');
  for (const [key,value] of Object.entries({ refresh_token:'token',account_id:'account',folder_id:'app',granted_scopes:readonly,sync_owner_id:7 })) cfg(key,value);
  process.env.GOOGLE_DRIVE_SYNC_ENABLED = 'true';
  getFile = id => ({ id, name:'Source',mimeType:folderType,trashed:false });
  listing = async () => ({ files:[] });
  exported = null; created = null; deleted = [];
  tokenLoad = async () => ({ tokens:{ refresh_token:'new-token',access_token:'access',scope:readonly } });
  createFile = async options => { created = options; return { data:{ id:'uploaded' } }; };
  drive.__setGoogleApiFactoryForTests(factory);
}
function rows() { return database.prepare('SELECT * FROM family_documents ORDER BY storage_key').all(); }
async function enable() { return drive.configureSync({ enabled:true,folder_id:'source' },7); }

test('opt-in scopes and verified source-folder configuration', async () => {
  reset();
  drive.getAuthUrl({});
  assert.deepEqual(authOptions.scope,['https://www.googleapis.com/auth/drive.file',readonly]);
  cfg('granted_scopes','https://www.googleapis.com/auth/drive.file');
  await assert.rejects(enable(), /Reconnect/);
  cfg('granted_scopes',readonly);
  getFile = id => ({ id,mimeType:'text/plain' });
  await assert.rejects(enable(), /available Google Drive folder/);
  getFile = id => ({ id,name:'Verified source',mimeType:folderType });
  const status = await enable();
  assert.equal(status.sync.folder_name,'Verified source');
  process.env.GOOGLE_DRIVE_SYNC_ENABLED = 'false';
  drive.getAuthUrl({});
  assert.deepEqual(authOptions.scope,['https://www.googleapis.com/auth/drive.file']);
  assert.equal(drive.preservesRemoteFiles(),true);
  assert.deepEqual(await drive.syncIfEnabled(),{ skipped:'disabled' });
});

test('paginated recursive imports are private, stable and refresh only remote metadata', async () => {
  reset(); await enable();
  const calls = [];
  listing = async options => {
    calls.push(options);
    if (options.q.includes("'nested'")) return { files:[{ id:'sheet',name:'Budget',mimeType:'application/vnd.google-apps.spreadsheet' }] };
    if (options.pageToken) return { files:[{ id:'skip',name:'Drawing',mimeType:'application/vnd.google-apps.drawing' }] };
    return { nextPageToken:'page2',files:[{ id:'nested',mimeType:folderType },{ id:'file',name:'Invoice.pdf',mimeType:'application/pdf',size:'24' }] };
  };
  assert.deepEqual(await drive.syncNow(),{ imported:2,updated:0,unavailable:0,skipped:1 });
  assert.equal(calls.length,3);
  assert.equal(rows()[0].visibility,'private');
  assert.equal(rows()[0].created_by,7);
  const sheet = rows().find(r => r.storage_key === 'sheet');
  assert.equal(sheet.original_name,'Budget.pdf');
  database.prepare("UPDATE family_documents SET description='local',category='finance',visibility='restricted',status='archived',expires_at='2030-01-01' WHERE storage_key='file'").run();
  const before = rows().find(r => r.storage_key === 'file');
  await drive.syncNow();
  const after = rows().find(r => r.storage_key === 'file');
  for (const field of ['id','description','category','visibility','status','expires_at']) assert.equal(after[field],before[field]);
  assert.equal(rows().length,2);
});

test('completed scans mark missing unavailable, reappearances recover, local deletion suppresses reimport', async () => {
  reset(); await enable();
  listing = async () => ({ files:[{ id:'file',name:'a',mimeType:'text/plain' }] });
  await drive.syncNow();
  const imported = rows()[0];
  listing = async () => ({ files:[] });
  assert.equal((await drive.syncNow()).unavailable,1);
  assert.equal(JSON.parse(rows()[0].external_meta).drive_sync.available,false);
  listing = async () => ({ files:[{ id:'file',name:'b',mimeType:'text/plain' }] });
  await drive.syncNow();
  assert.equal(JSON.parse(rows()[0].external_meta).drive_sync.available,true);
  drive.suppressSyncDocument(imported);
  database.prepare('DELETE FROM family_documents').run();
  assert.equal((await drive.syncNow()).skipped,1);
  assert.equal(rows().length,0);
});

test('failed or incomplete scans leave all document rows untouched', async () => {
  reset(); await enable();
  listing = async () => ({ files:[{ id:'file',name:'a',mimeType:'text/plain' }] });
  await drive.syncNow();
  const before = rows();
  listing = async options => {
    if (options.pageToken) throw new Error('network failure');
    return { nextPageToken:'more',files:[{ id:'new',name:'new',mimeType:'text/plain' }] };
  };
  await assert.rejects(drive.syncNow(), /Google Drive sync failed/);
  assert.deepEqual(rows(),before);
  listing = async () => ({ incompleteSearch:true,files:[] });
  await assert.rejects(drive.syncNow(), /Google Drive sync failed/);
  assert.deepEqual(rows(),before);
  assert.ok(drive.getStatus().sync.last_error);
  assert.equal(drive.getStatus().sync.running,false);
});

test('scan concurrency and bounded traversal', async () => {
  reset(); await enable();
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  listing = () => new Promise(resolve => { release = resolve; started(); });
  const pending = drive.syncNow();
  await entered;
  assert.deepEqual(await drive.syncNow(),{ skipped:'running' });
  await assert.rejects(drive.configureSync({ enabled:false },7), /sync is running/);
  assert.throws(() => drive.disconnect(), /sync is running/);
  release({ files:[] }); await pending;
  listing = async () => ({ files:Array.from({ length:101 },(_,i) => ({ id:`folder${i}`,mimeType:folderType })) });
  await assert.rejects(drive.syncNow(), /Google Drive sync failed/);
  assert.equal(rows().length,0);
});

test('native Google files export PDF while ordinary files use media downloads', async () => {
  reset();
  getFile = id => ({ id,mimeType:'application/vnd.google-apps.document' });
  const pdf = await drive.readFile('doc');
  assert.equal(pdf.mime,'application/pdf'); assert.equal(pdf.buffer.toString(),'pdf');
  assert.deepEqual(exported,{ fileId:'doc',mimeType:'application/pdf' });
  getFile = id => ({ id,mimeType:'text/plain',size:6 });
  assert.equal((await drive.readFile('text')).buffer.toString(),'binary');
  getFile = id => ({ id,mimeType:'application/vnd.google-apps.drawing' });
  await assert.rejects(drive.readFile('drawing'),/cannot be exported/);
});

test('uploads target the verified source and local deletion never removes remote content', async () => {
  reset(); await enable();
  assert.equal(await drive.uploadFile({ buffer:Buffer.from('test'),originalName:'invoice.pdf',mime:'application/pdf' }),'uploaded');
  assert.equal(created.requestBody.name,'invoice.pdf');
  assert.deepEqual(created.requestBody.parents,['source']);
  process.env.GOOGLE_DRIVE_SYNC_ENABLED = 'false';
  await drive.uploadFile({ buffer:Buffer.from('data'),originalName:'after-toggle.txt' });
  assert.deepEqual(created.requestBody.parents,['source']);
  assert.equal(created.requestBody.name,'after-toggle.txt');
  assert.equal(drive.getStatus().folder_name,'Source');
  assert.equal(drive.getStatus().sync.enabled,false);
  const document = { storage_backend:'google_drive',storage_key:'uploaded' };
  await documentStorage.deleteDocumentContent(document);
  assert.deepEqual(deleted,[]);
  assert.ok(database.prepare('SELECT 1 FROM google_drive_sync_tombstones WHERE file_id = ?').get('uploaded'));
  // Compensation may remove only a new, uncommitted staged upload.
  await documentStorage.cleanupStagedUpload({ storage_backend:'google_drive',storage_key:'staged-only' });
  assert.deepEqual(deleted,['staged-only']);
  await assert.rejects(documentStorage.readDocumentContent({ ...document,external_meta:JSON.stringify({ drive_sync:{ available:false } }) }), /no longer available/);
});


function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise,resolve };
}

function trackedResponse() {
  const response = new EventEmitter();
  response.end = () => {};
  trackWriteRequest(response);
  return response;
}

test('a writer before or during a scan prevents importing an uncommitted upload', async () => {
  reset(); await enable();
  const writer = trackedResponse();
  assert.deepEqual(await drive.syncNow(),{ skipped:'write_in_progress' });
  untrackWriteRequest(writer); await Promise.resolve();
  const entered = deferred(), release = deferred();
  listing = async () => { entered.resolve(); return release.promise; };
  const scanning = drive.syncNow(); await entered.promise;
  const upload = trackedResponse();
  release.resolve({ files:[{ id:'uploaded-before-insert',name:'invoice.pdf',mimeType:'application/pdf' }] });
  assert.deepEqual(await scanning,{ skipped:'write_in_progress' });
  assert.equal(rows().length,0);
  untrackWriteRequest(upload); await Promise.resolve();
});

test('completed writes during a scan invalidate its snapshot too', async () => {
  reset(); await enable();
  const entered = deferred(), release = deferred();
  listing = async () => { entered.resolve(); return release.promise; };
  const scanning = drive.syncNow(); await entered.promise;
  const writer = trackedResponse();
  untrackWriteRequest(writer); await Promise.resolve();
  release.resolve({ files:[{ id:'stale',name:'stale',mimeType:'text/plain' }] });
  assert.deepEqual(await scanning,{ skipped:'write_in_progress' });
  assert.equal(rows().length,0);
});

test('configuration mutations exclude callbacks, scans, uploads and disconnects', async () => {
  reset(); await enable();
  const entered = deferred(), release = deferred();
  getFile = async id => { if (id === 'changed') { entered.resolve(); await release.promise; } return { id,name:'Source',mimeType:folderType }; };
  const configuring = drive.configureSync({ enabled:true,folder_id:'changed' },7);
  await entered.promise;
  await assert.rejects(drive.configureSync({ enabled:false },7), /operation is running/);
  await assert.rejects(drive.handleCallback('code',7), /operation is running/);
  await assert.rejects(drive.uploadFile({ buffer:Buffer.from('data') }), /configuration is changing/);
  assert.throws(() => drive.disconnect(), /operation is running/);
  assert.deepEqual(await drive.syncNow(),{ skipped:'configuration' });
  release.resolve(); await configuring;
  assert.equal(drive.getStatus().sync.folder_id,'changed');
});

test('OAuth callback holds the configuration lock from token exchange to commit', async () => {
  reset(); await enable();
  const entered = deferred(), release = deferred();
  tokenLoad = async () => { entered.resolve(); return release.promise; };
  const reconnecting = drive.handleCallback('code',7); await entered.promise;
  await assert.rejects(drive.handleCallback('other',7), /operation is running/);
  await assert.rejects(drive.configureSync({ enabled:false },7), /operation is running/);
  assert.deepEqual(await drive.syncNow(),{ skipped:'configuration' });
  release.resolve({ tokens:{ refresh_token:'new-token',scope:readonly } });
  await reconnecting;
  assert.equal(drive.getStatus().connected,true);
});

test('active uploads and other HTTP writers prevent configuration changes', async () => {
  reset(); await enable();
  const entered = deferred(), release = deferred();
  createFile = async () => { entered.resolve(); return release.promise; };
  const uploading = drive.uploadFile({ buffer:Buffer.from('data') }); await entered.promise;
  await assert.rejects(drive.configureSync({ enabled:false },7), /operation is running/);
  await assert.rejects(drive.handleCallback('code',7), /operation is running/);
  release.resolve({ data:{ id:'uploaded' } }); await uploading;
  const writer = trackedResponse();
  await assert.rejects(drive.configureSync({ enabled:false },7), /operation is running/);
  untrackWriteRequest(writer); await Promise.resolve();
  await drive.configureSync({ enabled:false },7);
});

test('reconnect skips unavailable representatives and verifies source when all are missing', async () => {
  reset(); await enable();
  const insert = database.prepare("INSERT INTO family_documents (name,storage_backend,storage_key,external_meta) VALUES (?,'google_drive',?,?)");
  insert.run('missing','missing',JSON.stringify({ drive_sync:{ available:false,source_folder_id:'source' } }));
  insert.run('present','present',JSON.stringify({ drive_sync:{ available:true,source_folder_id:'source' } }));
  const read = [];
  getFile = id => { read.push(id); if (id === 'missing') throw Object.assign(new Error('missing'),{ code:404 }); return { id,mimeType:folderType }; };
  await drive.handleCallback('code',7);
  assert.ok(read.includes('present')); assert.ok(!read.includes('missing'));
  database.prepare("UPDATE family_documents SET external_meta = ? WHERE storage_key = 'present'").run(JSON.stringify({ drive_sync:{ available:false,source_folder_id:'source' } }));
  read.length = 0;
  await drive.handleCallback('code',7);
  assert.ok(read.includes('source')); assert.ok(!read.includes('missing')); assert.ok(!read.includes('present'));
});

test('callback revalidates document/account binding after its final external await', async () => {
  reset(); await enable();
  const entered = deferred(), release = deferred();
  getFile = async id => { if (id === 'app') { entered.resolve(); await release.promise; } return { id,mimeType:folderType }; };
  const reconnecting = drive.handleCallback('code',7); await entered.promise;
  database.prepare("INSERT INTO family_documents (name,storage_backend,storage_key) VALUES ('new','google_drive','new')").run();
  release.resolve();
  await assert.rejects(reconnecting, /binding changed/);
  assert.equal(database.prepare('SELECT value FROM sync_config WHERE key = ?').get(prefix+'refresh_token').value,'token');
});

test('real migrated schema tags uploads before their first scan and preserves metadata', async () => {
  reset();
  assert.ok(original.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_google_drive_sync_document_insert'").get());
  const userId = original.prepare("INSERT INTO users (username,display_name,password_hash,role) VALUES ('sync-trigger','Sync trigger','unused','admin')").run().lastInsertRowid;
  const config = original.prepare('INSERT OR REPLACE INTO sync_config (key,value) VALUES (?,?)');
  for (const [key,value] of Object.entries({ sync_enabled:'true',sync_folder_id:'source',sync_owner_id:String(userId),account_id:'account',refresh_token:'token',folder_id:'app',granted_scopes:readonly })) config.run(prefix+key,value);
  const inserted = original.prepare("INSERT INTO family_documents (name,original_name,mime_type,file_size,content_data,storage_backend,storage_provider,storage_key,created_by,external_meta) VALUES ('first','first.txt','text/plain',4,'','google_drive','external','before-scan',?,?)").run(userId,JSON.stringify({ custom:'keep' })).lastInsertRowid;
  const metadata = () => JSON.parse(original.prepare('SELECT external_meta FROM family_documents WHERE id = ?').get(inserted).external_meta);
  assert.deepEqual(metadata(),{ custom:'keep',drive_sync:{ available:true,source_folder_id:'source',modified_time:null } });
  db._setTestDatabase(original);
  try {
    assert.equal((await drive.syncNow()).unavailable,1);
    assert.equal(metadata().drive_sync.available,false);
  } finally { db._setTestDatabase(database); }
});


test('manual sync, configuration and OAuth callback release their own tracked HTTP writer', async t => {
  reset();
  const app = express();
  app.use(express.json());
  app.use((req,res,next) => {
    req.authRole = 'admin'; req.session = { userId:7,googleDriveOAuthState:'state' };
    trackWriteRequest(res); next();
  });
  app.use('/',driveRouter);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const config = await fetch(`${base}/sync/config`,{ method:'PUT',headers:{ 'Content-Type':'application/json' },body:JSON.stringify({ enabled:true,folder_id:'source' }) });
  assert.equal(config.status,200);
  assert.equal((await config.json()).data.sync.enabled,true);
  const sync = await fetch(`${base}/sync`,{ method:'POST' });
  assert.equal(sync.status,200);
  assert.deepEqual((await sync.json()).data,{ imported:0,updated:0,unavailable:0,skipped:0 });
  const callback = await fetch(`${base}/callback?code=code&state=state`,{ redirect:'manual' });
  assert.equal(callback.status,302);
  assert.match(callback.headers.get('location'), /drive_ok=1/);
  assert.equal(database.prepare('SELECT value FROM sync_config WHERE key = ?').get(prefix+'refresh_token').value,'new-token');
});

test.after(() => { drive.__setGoogleApiFactoryForTests(null); database.close(); original.close(); });
