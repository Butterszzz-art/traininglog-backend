// Emails a moderator about new profile reports and blocks (see
// src/routes/profiles.js). Apple Guideline 1.2 expects reports to be acted
// on within 24 hours, so a person needs to hear about them.
//
// Sent through Resend's HTTP API (https://resend.com/docs/api-reference) —
// no SDK, just fetch. Config:
//   RESEND_API_KEY        secret (firebase functions:secrets:set RESEND_API_KEY)
//   MODERATION_EMAIL_TO   who gets the alerts (comma-separated for several)
//   MODERATION_EMAIL_FROM sender; its domain must be verified in Resend
//
// With no API key or recipient it only logs, so local runs and tests never
// send mail.
const RESEND_URL = 'https://api.resend.com/emails';
const DEFAULT_FROM = 'Pocket Coach Moderation <moderation@pocketcoachcoms.org>';

function createModerationNotifier({ apiKey, to, from = DEFAULT_FROM, fetchImpl = globalThis.fetch, log = console } = {}) {
  const recipients = String(to || '').split(',').map(s => s.trim()).filter(Boolean);

  return async function notifyModerators(message) {
    log.warn('[moderation]', message);
    if (!apiKey || !recipients.length) return;

    const res = await fetchImpl(RESEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: from || DEFAULT_FROM,
        to: recipients,
        // First sentence as the subject so the inbox list is scannable.
        subject: `[Pocket Coach] ${String(message).split('. ')[0].slice(0, 120)}`,
        text: `${message}\n\nReports are in the Firestore console under profileReports. `
          + 'Apple expects action within 24 hours: remove the photo/bio (DELETE /api/profiles/:username/avatar as a PROFILE_ADMINS user) '
          + 'or suspend the account if it breaks the rules.',
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json())?.message || ''; } catch { /* non-JSON */ }
      throw new Error(`Resend HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
    }
  };
}

module.exports = { createModerationNotifier };
