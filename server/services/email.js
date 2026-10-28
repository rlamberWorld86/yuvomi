/**
 * Compatibility boundary for authentication flows after SMTP removal.
 * Email credentials in existing databases are retained but never read or used.
 */
export function createEmailService() {
  return {
    isConfigured: () => false,
    isEnvControlled: () => false,
    getRawConfig: () => ({}),
    getPublicConfig: () => ({ configured: false, passwordSet: false, envControlled: {} }),
    async sendMail() {
      throw new Error('Email delivery is not available.');
    },
    async sendTest() {
      return { ok: false, reason: 'not_configured', error: 'Email delivery is not available.' };
    },
  };
}

export const emailService = createEmailService();
