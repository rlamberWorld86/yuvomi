import express from 'express';
import { runExternalJob, untrackWriteRequest } from '../utils/restore-state.js';
import { refuseWhileRestoring } from '../middleware/restore-gate.js';
import { requireAdmin } from '../auth.js';
import { createLogger } from '../logger.js';
import * as googleDriveStorage from '../services/google-drive-storage.js';

const log = createLogger('GoogleDriveStorageRoutes');
const router = express.Router();
// Seit R10 ein Abschnitt im Modulblatt Dokumente (die Alt-Adresse leitet nur um).
const SETTINGS_URL = '/settings/modules/documents?section=documents-storage';

function sendStorageError(res, error) {
  const storageCode = error?.storageCode;
  const status = storageCode === 'DOCUMENT_STORAGE_CONFIG_PROTECTED'
    ? 409
    : (
        storageCode === 'DOCUMENT_STORAGE_INVALID_CONFIG'
        || storageCode === 'DOCUMENT_STORAGE_NOT_CONFIGURED'
      )
      ? 400
      : 502;
  return res.status(status).json({
    error: error?.message || 'Google Drive document storage operation failed.',
    code: status,
    storage_code: storageCode || 'DOCUMENT_STORAGE_OPERATION_FAILED',
  });
}

router.get('/auth', requireAdmin, refuseWhileRestoring, (req, res) => {
  try {
    res.redirect(googleDriveStorage.getAuthUrl(req.session));
  } catch (error) {
    log.error('GET /auth error:', error);
    sendStorageError(res, error);
  }
});

router.get('/callback', requireAdmin, refuseWhileRestoring, async (req, res) => {
  const { code, error, state } = req.query;
  if (error || !code) {
    delete req.session.googleDriveOAuthState;
    return res.redirect(`${SETTINGS_URL}&drive_error=1`);
  }
  if (
    !state
    || !req.session.googleDriveOAuthState
    || state !== req.session.googleDriveOAuthState
  ) {
    delete req.session.googleDriveOAuthState;
    log.error('OAuth state mismatch');
    return res.redirect(`${SETTINGS_URL}&drive_error=1`);
  }
  delete req.session.googleDriveOAuthState;

  try {
    untrackWriteRequest(res);
    await runExternalJob(async () => {
      await Promise.resolve();
      return googleDriveStorage.handleCallback(code, req.authUserId || req.session.userId);
    });
    return res.redirect(`${SETTINGS_URL}&drive_ok=1`);
  } catch (callbackError) {
    log.error('GET /callback error:', callbackError);
    return res.redirect(`${SETTINGS_URL}&drive_error=1`);
  }
});

router.post('/test', requireAdmin, refuseWhileRestoring, async (_req, res) => {
  try {
    const data = await runExternalJob(() => googleDriveStorage.testConnection());
    res.json({ data });
  } catch (error) {
    log.error('POST /test error:', error);
    sendStorageError(res, error);
  }
});

router.delete('/disconnect', requireAdmin, refuseWhileRestoring, async (req, res) => {
  try {
    untrackWriteRequest(res);
    const data = await runExternalJob(async () => {
      await Promise.resolve();
      googleDriveStorage.disconnect();
      return googleDriveStorage.getStatus();
    });
    res.json({ data });
  } catch (error) {
    log.error('DELETE /disconnect error:', error);
    sendStorageError(res, error);
  }
});

router.put('/sync/config', requireAdmin, refuseWhileRestoring, async (req, res) => {
  try {
    untrackWriteRequest(res);
    const data = await runExternalJob(async () => {
      await Promise.resolve();
      return googleDriveStorage.configureSync(req.body, req.authUserId || req.session.userId);
    });
    res.json({ data });
  } catch (error) { sendStorageError(res, error); }
});

router.post('/sync', requireAdmin, refuseWhileRestoring, async (_req, res) => {
  try {
    untrackWriteRequest(res);
    const data = await runExternalJob(async () => {
      await Promise.resolve();
      return googleDriveStorage.syncNow();
    });
    res.json({ data });
  }
  catch (error) { sendStorageError(res, error); }
});

export default router;
