import crypto from 'crypto';
import { addSmsLog, SmsLogEntry } from './store.ts';

export interface CaregiverRecipient {
  name: string;
  phone: string;
}

export interface SmsDispatchSummary {
  configured: boolean;
  provider: string;
  attempted: number;
  sent: number;
  failed: number;
  notConfigured: number;
  skippedDuplicates: number;
  logs: SmsLogEntry[];
  summaryText: string;
}

const dispatchedIdempotencyKeys = new Set<string>();

export function normalizeIndianPhone(raw: string): string | null {
  const cleaned = String(raw || '').replace(/[\s()-]/g, '');
  if (/^\+[1-9][0-9]{7,14}$/.test(cleaned)) return cleaned;
  if (/^[6-9][0-9]{9}$/.test(cleaned)) return `+91${cleaned}`;
  if (/^91[6-9][0-9]{9}$/.test(cleaned)) return `+${cleaned}`;
  return null;
}

export function isSmsGatewayConfigured(): { configured: boolean; provider: string } {
  const sid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const token = process.env.TWILIO_AUTH_TOKEN?.trim();
  const from = process.env.TWILIO_FROM_NUMBER?.trim();
  if (sid && token && from) {
    return { configured: true, provider: 'twilio_rest_api' };
  }
  const webhook = process.env.SMS_WEBHOOK_URL?.trim();
  if (webhook && /^https?:\/\//i.test(webhook)) {
    return { configured: true, provider: 'sms_webhook_gateway' };
  }
  return { configured: false, provider: 'none' };
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

async function sendViaTwilio(to: string, body: string): Promise<{ ok: boolean; sid?: string; status?: string; error?: string; transient?: boolean }> {
  const sid = process.env.TWILIO_ACCOUNT_SID!.trim();
  const token = process.env.TWILIO_AUTH_TOKEN!.trim();
  const from = process.env.TWILIO_FROM_NUMBER!.trim();
  const appUrl = process.env.APP_URL?.trim().replace(/\/+$/, '');

  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`;
  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  const form = new URLSearchParams({ To: to, From: from, Body: body });
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
      signal: AbortSignal.timeout(8000),
    });
    const data = (await res.json().catch(() => ({}))) as { sid?: string; status?: string; code?: number; message?: string };
    if (res.ok) {
      return { ok: true, sid: data.sid, status: data.status };
    }
    const isTrialBlocked = data.code === 21608 || /unverified/i.test(data.message || '');
    return {
      ok: false,
      error: isTrialBlocked
        ? `Twilio trial restriction (code ${data.code || 21608}): verify recipient number ${to} in Twilio Console or upgrade Twilio account.`
        : data.message || `Twilio returned HTTP ${res.status}`,
      transient: res.status >= 500 || res.status === 429,
    };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Twilio network error', transient: true };
  }
}

async function sendViaWebhook(to: string, body: string, meta: { emergencyId: string; emergencyType: string }): Promise<{ ok: boolean; sid?: string; error?: string; transient?: boolean }> {
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
    const data = (await res.json().catch(() => ({}))) as { id?: string; messageId?: string; error?: string };
    if (res.ok) {
      return { ok: true, sid: data.messageId || data.id || `wh_${Date.now()}` };
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
  emergencyType: 'sos' | 'medical' | 'accident';
  citizenName: string;
  messageBody: string;
  recipients: CaregiverRecipient[];
}): Promise<SmsDispatchSummary> {
  const { configured, provider } = isSmsGatewayConfigured();
  const logs: SmsLogEntry[] = [];
  let sent = 0;
  let failed = 0;
  let notConfigured = 0;
  let skippedDuplicates = 0;

  if (!params.recipients || params.recipients.length === 0) {
    return {
      configured,
      provider,
      attempted: 0,
      sent: 0,
      failed: 0,
      notConfigured: 0,
      skippedDuplicates: 0,
      logs: [],
      summaryText: 'No trusted emergency contacts saved for SMS dispatch.',
    };
  }

  for (const recipient of params.recipients.slice(0, 5)) {
    const normalized = normalizeIndianPhone(recipient.phone);
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
        error: 'Invalid phone number format; expected 10-digit Indian mobile or E.164 number.',
        createdAt: nowIso,
        updatedAt: nowIso,
      });
      logs.push(entry);
      failed += 1;
      continue;
    }

    const idempotencyKey = `${params.emergencyId}:${normalized}`;
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
        error: 'Server SMS provider credentials (TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM_NUMBER or SMS_WEBHOOK_URL) are not configured. No external SMS was sent.',
        createdAt: nowIso,
        updatedAt: nowIso,
      });
      logs.push(entry);
      notConfigured += 1;
      continue;
    }

    let attempts = 0;
    let finalRes: { ok: boolean; sid?: string; error?: string; transient?: boolean } = {
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

    const entry = addSmsLog({
      id: `sms_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      emergencyId: params.emergencyId,
      emergencyType: params.emergencyType,
      recipientName: recipient.name.slice(0, 80),
      recipientPhone: normalized,
      message: params.messageBody.slice(0, 480),
      provider,
      status: finalRes.ok ? 'sent' : 'failed',
      attempts,
      providerMessageId: finalRes.sid,
      error: finalRes.error,
      createdAt: nowIso,
      updatedAt: new Date().toISOString(),
    });
    logs.push(entry);
    if (finalRes.ok) sent += 1;
    else failed += 1;
  }

  let summaryText = '';
  if (!configured) {
    summaryText = `SMS gateway unconfigured on server (${notConfigured} contact alert(s) logged as not_configured). Use direct 112/108 call or share tracking link.`;
  } else if (sent > 0 && failed === 0) {
    summaryText = `SMS dispatched via ${provider} to ${sent} trusted contact(s).`;
  } else if (sent > 0 && failed > 0) {
    summaryText = `SMS sent to ${sent} contact(s), failed for ${failed} contact(s).`;
  } else {
    summaryText = `SMS dispatch failed for ${failed} contact(s) (${logs[0]?.error || 'provider error'}).`;
  }

  return {
    configured,
    provider,
    attempted: logs.length,
    sent,
    failed,
    notConfigured,
    skippedDuplicates,
    logs,
    summaryText,
  };
}
