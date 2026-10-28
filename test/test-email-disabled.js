import assert from 'node:assert/strict';
import test from 'node:test';
import { createEmailService, emailService } from '../server/services/email.js';

test('removed SMTP support ignores credentials and never contacts a transport or database', async () => {
  let touched = false;
  const service = createEmailService({
    db: { prepare() { touched = true; throw new Error('Database accessed'); } },
    nodemailer: { createTransport() { touched = true; throw new Error('Transport created'); } },
    env: { EMAIL_SMTP_HOST: 'smtp.example.test', EMAIL_FROM_ADDRESS: 'test@example.test' },
  });
  assert.equal(service.isConfigured(), false);
  assert.equal(service.isEnvControlled('host'), false);
  assert.deepEqual(service.getRawConfig(), {});
  assert.deepEqual(service.getPublicConfig(), { configured: false, passwordSet: false, envControlled: {} });
  await assert.rejects(service.sendMail({ to: 'test@example.test' }), /not available/);
  assert.deepEqual(await service.sendTest('test@example.test'), { ok: false, reason: 'not_configured', error: 'Email delivery is not available.' });
  assert.equal(touched, false);
  assert.equal(emailService.isConfigured(), false);
});
