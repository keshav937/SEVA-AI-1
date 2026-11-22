import crypto from 'crypto';
import { addSmsLog, getSmsLogById, SmsEventType, SmsLogEntry, updateSmsLogById, updateSmsLogByProviderId } from './store.ts';

export interface CaregiverRecipient {
  name: string;
  phone: string;
}

export interface SmsDispatchSummary {
  configured: boolean;
  provider: string;
  attempted: number;
  sent: number;
  queued: number;
  failed: number;
  notConfigured: number;
  skippedDuplicates: number;
  logs: SmsLogEntry[];
  summaryText: string;
}

const dispatchedIdempotencyKeys = new Set<string>();
let smsUpdateListener: ((log: SmsLogEntry) => void) | null = null;

export function registerSmsStatusListener(listener: (log: SmsLogEntry) => void) {
  smsUpdateListener = listener;
}

export function normalizePhoneE164(raw: string): string | null {
  const cleaned = String(raw || '').replace(/[\s().-]/g, '');
  if (/^\+[1-9][0-9]{7,14}$/.test(cleaned)) return cleaned;
  if (/^[6-9][0-9]{9}$/.test(cleaned)) return `+91${cleaned}`;
  if (/^91[6-9][0-9]{9}$/.test(cleaned)) return `+${cleaned}`;
  if (/^[1-9][0-9]{9,14}$/.test(cleaned)) return `+${cleaned}`;
  return null;
}

export const normalizeIndianPhone = normalizePhoneE164;

function getTwilioCredentials(): {
  sid: string;
  token: string;
  senderPhone: string | null;
  rawSenderPhone: string;
  msgServiceSid: string | null;
} {
  const sid = process.env.TWILIO_ACCOUNT_SID?.trim() || '';
  const token = process.env.TWILIO_AUTH_TOKEN?.trim() || '';
  const rawSender =
    process.env.TWILIO_PHONE_NUMBER?.trim() ||
    process.env.TWILIO_FROM_NUMBER?.trim() ||
    '';
  const senderPhone = rawSender ? normalizePhoneE164(rawSender) : null;
  const rawMsgSid = process.env.TWILIO_MESSAGING_SERVICE_SID?.trim() || '';
  const msgServiceSid = /^MG[a-f0-9]{32}$/i.test(rawMsgSid) ? rawMsgSid : null;

  return {
    sid,
    token,
    senderPhone,
    rawSenderPhone: rawSender,
    msgServiceSid,
  };
}

export function isSmsGatewayConfigured(): {
  configured: boolean;
  provider: string;
  mode: 'direct_phone_number' | 'messaging_service' | 'webhook' | 'none';
  senderPhoneConfigured: boolean;
  messagingServiceConfigured: boolean;
  voiceEnabled: boolean;
} {
  const { sid, token, senderPhone, msgServiceSid } = getTwilioCredentials();
  const voiceEnabled = String(process.env.TWILIO_VOICE_ENABLED || '').toLowerCase() === 'true';

  if (sid && token && (senderPhone || msgServiceSid)) {
    return {
      configured: true,
      provider: 'twilio_rest_api',
      mode: msgServiceSid ? 'messaging_service' : 'direct_phone_number',
      senderPhoneConfigured: Boolean(senderPhone),
      messagingServiceConfigured: Boolean(msgServiceSid),
      voiceEnabled,
    };
  }
  const webhook = process.env.SMS_WEBHOOK_URL?.trim();
  if (webhook && /^https?:\/\//i.test(webhook)) {
    return {
      configured: true,
      provider: 'sms_webhook_gateway',
      mode: 'webhook',
      senderPhoneConfigured: false,
      messagingServiceConfigured: false,
      voiceEnabled,
    };
  }
  return {
    configured: false,
    provider: 'none',
    mode: 'none',
    senderPhoneConfigured: Boolean(senderPhone),
    messagingServiceConfigured: Boolean(msgServiceSid),
    voiceEnabled,
  };
}

export function verifyTwilioWebhookSignature(params: {
  signatureHeader?: string;
  fullUrl: string;
  bodyParams: Record<string, string>;
}): boolean {
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  if (!authToken || !params.signatureHeader) return false;
  const sortedKeys = Object.keys(params.bodyParams || {}).sort();
  let data = params.fullUrl;
  for (const k of sortedKeys) {
    data += k + String(params.bodyParams[k] ?? '');
  }
  const expected = crypto.createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
  const sigBuf = Buffer.from(params.signatureHeader.trim());
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expBuf);
}

function mapTwilioStatus(rawStatus: string): 'queued' | 'sent' | 'delivered' | 'pending' | 'failed' {
  const s = String(rawStatus || '').toLowerCase();
  if (s === 'delivered') return 'delivered';
  if (s === 'sent') return 'sent';
  if (s === 'queued' || s === 'accepted') return 'queued';
  if (s === 'sending' || s === 'scheduled') return 'pending';
  if (s === 'failed' || s === 'undelivered' || s === 'canceled') return 'failed';
  return 'queued';
}

function formatTwilioError(code: number | undefined, message: string | undefined, to: string, from: string | null): string {
  const msg = message || 'Unknown Twilio API error';
  if (code === 21608 || /unverified/i.test(msg)) {
    return `Twilio trial restriction (code ${code || 21608}): Destination ${to} must be verified in your Twilio Console > Verified Caller IDs, or upgrade your Twilio account.`;
  }
  if (code === 21606) {
    return `Twilio sender error (code 21606): Configured TWILIO_PHONE_NUMBER (${from || 'missing'}) is not an SMS-capable phone number owned by your Twilio account.`;
  }
  if (code === 21211 || code === 21614) {
    return `Twilio destination error (code ${code}): Recipient ${to} is not a valid SMS-capable E.164 mobile number.`;
  }
  if (code === 20003) {
    return 'Twilio authentication failed (code 20003): Check TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.';
  }
  return code ? `Twilio error ${code}: ${msg}` : msg;
}

async function postTwilioMessage(params: {
  sid: string;
  token: string;
  to: string;
  body: string;
  fromPhone?: string | null;
  messagingServiceSid?: string | null;
}): Promise<{
  ok: boolean;
  sid?: string;
  status?: 'queued' | 'sent' | 'delivered' | 'pending';
  error?: string;
  code?: number;
  transient?: boolean;
}> {
  const appUrl = process.env.APP_URL?.trim().replace(/\/+$/, '');
  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(params.sid)}/Messages.json`;
  const auth = Buffer.from(`${params.sid}:${params.token}`).toString('base64');
  const form = new URLSearchParams({ To: params.to, Body: params.body });

  if (params.messagingServiceSid) {
    form.set('MessagingServiceSid', params.messagingServiceSid);
  } else if (params.fromPhone) {
    form.set('From', params.fromPhone);
  }

  if (appUrl && /^https?:\/\//i.test(appUrl) && !appUrl.includes('MY_APP_URL')) {
    form.set('StatusCallback', `${appUrl}/api/sms/twilio-webhook`);
  }

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
      signal: AbortSignal.timeout(10000),
    });
    const data = (await res.json().catch(() => ({}))) as {
      sid?: string;
      status?: string;
      code?: number;
      message?: string;
    };
    if (res.ok && data.sid) {
      const mapped = mapTwilioStatus(data.status || 'queued');
      return {
        ok: mapped !== 'failed',
        sid: data.sid,
        status: mapped === 'failed' ? 'queued' : mapped,
      };
    }
    return {
      ok: false,
      code: data.code,
      error: formatTwilioError(data.code, data.message || `Twilio returned HTTP ${res.status}`, params.to, params.fromPhone || null),
      transient: res.status >= 500 || res.status === 429,
    };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Twilio network error', transient: true };
  }
}

async function sendViaTwilio(
  to: string,
  body: string
): Promise<{
  ok: boolean;
  sid?: string;
  status?: 'queued' | 'sent' | 'delivered' | 'pending';
  error?: string;
  transient?: boolean;
}> {
  const { sid, token, senderPhone, rawSenderPhone, msgServiceSid } = getTwilioCredentials();

  if (!sid || !token) {
    return { ok: false, error: 'TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required.' };
  }
  if (!msgServiceSid && !senderPhone) {
    if (rawSenderPhone) {
      return {
        ok: false,
        error: `Configured TWILIO_PHONE_NUMBER "${rawSenderPhone}" is not a valid E.164 phone number (e.g. +15551234567).`,
      };
    }
    return {
      ok: false,
      error: 'TWILIO_PHONE_NUMBER (or optional TWILIO_MESSAGING_SERVICE_SID) is required to send SMS.',
    };
  }

  // If Messaging Service SID is unavailable, use the configured Twilio sender phone number directly.
  if (!msgServiceSid && senderPhone) {
    return postTwilioMessage({ sid, token, to, body, fromPhone: senderPhone });
  }

  // If Messaging Service SID IS configured, try it; if the Messaging Service has no sender in its pool, fall back directly to TWILIO_PHONE_NUMBER.
  const firstTry = await postTwilioMessage({ sid, token, to, body, messagingServiceSid: msgServiceSid });
  if (
    !firstTry.ok &&
    senderPhone &&
    (firstTry.code === 21703 ||
      firstTry.code === 21704 ||
      firstTry.code === 21705 ||
      /no.*phone number.*assigned|messaging service/i.test(firstTry.error || ''))
  ) {
    return postTwilioMessage({ sid, token, to, body, fromPhone: senderPhone });
  }

  return firstTry;
}

export async function fetchTwilioMessageStatus(messageSid: string): Promise<{
  ok: boolean;
  status?: SmsLogEntry['status'];
  error?: string;
}> {
  const { sid, token } = getTwilioCredentials();
  if (!sid || !token) {
    return { ok: false, error: 'Twilio credentials are not configured on the server.' };
  }
  const cleanMsgSid = messageSid.trim();
  if (!/^SM[a-f0-9]{32}$/i.test(cleanMsgSid)) {
    return { ok: false, error: 'Invalid Twilio Message SID.' };
  }
  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages/${encodeURIComponent(cleanMsgSid)}.json`;
  const auth = Buffer.from(`${sid}:${token}`).toString('base64');

  try {
    const res = await fetch(endpoint, {
      method: 'GET',
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(8000),
    });
    const data = (await res.json().catch(() => ({}))) as {
      status?: string;
      error_code?: number | null;
      error_message?: string | null;
      message?: string;
    };
    if (!res.ok) {
      return { ok: false, error: data.message || `Twilio status lookup returned HTTP ${res.status}` };
    }
    const mapped = mapTwilioStatus(data.status || 'queued');
    const errText =
      data.error_code || data.error_message
        ? `${data.error_code ? `Twilio error ${data.error_code}: ` : ''}${data.error_message || 'Delivery failed'}`
        : undefined;
    return { ok: true, status: mapped, error: errText };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Unable to reach Twilio status API' };
  }
}

export async function refreshTwilioSmsLogStatus(logId: string): Promise<SmsLogEntry | null> {
  const existing = getSmsLogById(logId);
  if (!existing || !existing.providerMessageId) return existing;
  if (existing.provider !== 'twilio_rest_api') return existing;

  const res = await fetchTwilioMessageStatus(existing.providerMessageId);
  if (!res.ok || !res.status) return existing;

  const updated = updateSmsLogById(existing.id, res.status, res.error);
  if (updated && smsUpdateListener) {
    smsUpdateListener(updated);
  }
  return updated;
}

function scheduleBackgroundStatusCheck(messageSid: string) {
  setTimeout(async () => {
    try {
      const check = await fetchTwilioMessageStatus(messageSid);
      if (check.ok && check.status) {
        const updated = updateSmsLogByProviderId(messageSid, check.status, check.error);
        if (updated && smsUpdateListener) {
          smsUpdateListener(updated);
        }
      }
    } catch {
      // Ignore background refresh network error
    }
  }, 4500);
}

async function sendViaWebhook(
  to: string,
  body: string,
  meta: { emergencyId: string; emergencyType: string }
): Promise<{ ok: boolean; sid?: string; status?: 'queued' | 'sent' | 'delivered'; error?: string; transient?: boolean }> {
  const webhookUrl = process.env.SMS_WEBHOOK_URL!.trim();
  const webhookToken = process.env.SMS_WEBHOOK_TOKEN?.trim();
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (webhookToken) headers.Authorization = `Bearer ${webhookToken}`;
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ to, message: body, ...meta }),
      signal: AbortSignal.timeout(8000),
    });
    const data = (await res.json().catch(() => ({}))) as { id?: string; messageId?: string; status?: string; error?: string };
    if (res.ok) {
      return {
        ok: true,
        sid: data.messageId || data.id || `wh_${Date.now()}`,
        status: data.status === 'delivered' ? 'delivered' : data.status === 'queued' ? 'queued' : 'sent',
      };
    }
    return {
      ok: false,
      error: data.error || `SMS gateway returned HTTP ${res.status}`,
      transient: res.status >= 500 || res.status === 429,
    };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'SMS gateway network timeout', transient: true };
  }
}

export async function dispatchCaregiverSmsAlerts(params: {
  emergencyId: string;
  emergencyType: SmsEventType;
  citizenName: string;
  messageBody: string;
  recipients: CaregiverRecipient[];
  dedupKeyOverride?: string;
}): Promise<SmsDispatchSummary> {
  const { configured, provider } = isSmsGatewayConfigured();
  const logs: SmsLogEntry[] = [];
  let sent = 0;
  let queued = 0;
  let failed = 0;
  let notConfigured = 0;
  let skippedDuplicates = 0;

  if (!params.recipients || params.recipients.length === 0) {
    return {
      configured,
      provider,
      attempted: 0,
      sent: 0,
      queued: 0,
      failed: 0,
      notConfigured: 0,
      skippedDuplicates: 0,
      logs: [],
      summaryText: 'No trusted emergency contacts saved for SMS dispatch.',
    };
  }

  for (const recipient of params.recipients.slice(0, 5)) {
    const normalized = normalizePhoneE164(recipient.phone);
    const nowIso = new Date().toISOString();

    if (!normalized) {
      const entry = addSmsLog({
        id: `sms_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
        emergencyId: params.emergencyId,
        emergencyType: params.emergencyType,
        recipientName: recipient.name.slice(0, 80),
        recipientPhone: recipient.phone.slice(0, 20),
        message: params.messageBody.slice(0, 480),
        provider,
        status: 'failed',
        attempts: 1,
        error: 'Invalid phone number format; expected E.164 (+91XXXXXXXXXX or international +...) or 10-digit Indian mobile.',
        createdAt: nowIso,
        updatedAt: nowIso,
      });
      logs.push(entry);
      failed += 1;
      continue;
    }

    const idempotencyKey = params.dedupKeyOverride
      ? `${params.dedupKeyOverride}:${normalized}`
      : `${params.emergencyType}:${params.emergencyId}:${normalized}`;
    if (dispatchedIdempotencyKeys.has(idempotencyKey)) {
      skippedDuplicates += 1;
      continue;
    }

    if (!configured) {
      dispatchedIdempotencyKeys.add(idempotencyKey);
      const entry = addSmsLog({
        id: `sms_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
        emergencyId: params.emergencyId,
        emergencyType: params.emergencyType,
        recipientName: recipient.name.slice(0, 80),
        recipientPhone: normalized,
        message: params.messageBody.slice(0, 480),
        provider: 'none',
        status: 'not_configured',
        attempts: 0,
        error:
          'Twilio credentials (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER) are not configured on the server. No external SMS was sent.',
        createdAt: nowIso,
        updatedAt: nowIso,
      });
      logs.push(entry);
      notConfigured += 1;
      continue;
    }

    let attempts = 0;
    let finalRes: { ok: boolean; sid?: string; status?: 'queued' | 'sent' | 'delivered' | 'pending'; error?: string; transient?: boolean } = {
      ok: false,
      error: 'Not attempted',
    };

    for (let tryNum = 1; tryNum <= 2; tryNum++) {
      attempts = tryNum;
      finalRes =
        provider === 'twilio_rest_api'
          ? await sendViaTwilio(normalized, params.messageBody)
          : await sendViaWebhook(normalized, params.messageBody, {
              emergencyId: params.emergencyId,
              emergencyType: params.emergencyType,
            });
      if (finalRes.ok || !finalRes.transient) break;
      await new Promise((r) => setTimeout(r, 350));
    }

    dispatchedIdempotencyKeys.add(idempotencyKey);
    const resolvedStatus: SmsLogEntry['status'] = finalRes.ok ? finalRes.status || 'queued' : 'failed';

    const entry = addSmsLog({
      id: `sms_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      emergencyId: params.emergencyId,
      emergencyType: params.emergencyType,
      recipientName: recipient.name.slice(0, 80),
      recipientPhone: normalized,
      message: params.messageBody.slice(0, 480),
      provider,
      status: resolvedStatus,
      attempts,
      providerMessageId: finalRes.sid,
      error: finalRes.error,
      createdAt: nowIso,
      updatedAt: new Date().toISOString(),
    });
    logs.push(entry);
    if (smsUpdateListener) smsUpdateListener(entry);

    if (finalRes.ok) {
      if (provider === 'twilio_rest_api' && finalRes.sid && (resolvedStatus === 'queued' || resolvedStatus === 'pending' || resolvedStatus === 'sent')) {
        scheduleBackgroundStatusCheck(finalRes.sid);
      }
      if (resolvedStatus === 'queued' || resolvedStatus === 'pending') queued += 1;
      else sent += 1;
    } else {
      failed += 1;
    }
  }

  const totalDispatched = sent + queued;
  let summaryText = '';
  if (!configured && failed === 0) {
    summaryText = `SMS gateway unconfigured on server (${notConfigured} alert(s) logged as not_configured). Use direct 112/108/Caregiver call or share tracking link.`;
  } else if (totalDispatched > 0 && failed === 0) {
    summaryText = `SMS ${queued > 0 && sent === 0 ? 'queued' : 'dispatched'} via ${provider} to ${totalDispatched} recipient(s).`;
  } else if (totalDispatched > 0 && failed > 0) {
    summaryText = `SMS dispatched to ${totalDispatched} recipient(s), failed for ${failed} recipient(s).`;
  } else {
    summaryText = `SMS dispatch failed (${logs[0]?.error || 'provider or validation error'}).`;
  }

  return {
    configured,
    provider,
    attempted: logs.length,
    sent: totalDispatched,
    queued,
    failed,
    notConfigured,
    skippedDuplicates,
    logs,
    summaryText,
  };
}
