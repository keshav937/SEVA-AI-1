import 'dotenv/config';
import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import http from 'http';
import multer from 'multer';
import path from 'path';
import { WebSocket, WebSocketServer } from 'ws';
import {
  analyzeCivicReport,
  CIVIC_CATEGORIES,
  DEPARTMENT_BY_CATEGORY,
  isGeminiConfigured,
  processSaathiConversation,
  synthesizeWithGemini,
  transcribeWithGemini,
} from './server/ai.ts';
import {
  isElevenLabsConfigured,
  listElevenLabsVoices,
  SupportedVoiceLanguage,
  synthesizeWithElevenLabs,
  transcribeWithElevenLabs,
  VOICE_LANGUAGE_CAPABILITIES,
} from './server/elevenlabs.ts';
import {
  fetchNearbyPlaces,
  geocodeLocationQuery,
  NearbyCategoryKey,
  NearbySearchMode,
  PlacesProviderError,
  reverseGeocode,
} from './server/places.ts';
import {
  CaregiverRecipient,
  dispatchCaregiverSmsAlerts,
  isSmsGatewayConfigured,
  normalizePhoneE164,
  refreshTwilioSmsLogStatus,
  registerSmsStatusListener,
  verifyTwilioWebhookSignature,
} from './server/sms.ts';
import {
  addAuditLog,
  addCallLog,
  addPlatformNotification,
  AuthorityRole,
  AuthoritySession,
  CitizenComplaintAgainstAuthority,
  claimFirstRunAuthorityPasscode,
  CLOSED_REPORT_STATUSES,
  ComplaintBoxStatus,
  computePerformanceAndAnalytics,
  computeSlaDeadlines,
  createAuthoritySession,
  createCitizenComplaint,
  deleteCaregiver,
  EmergencyRequestStatus,
  findReportByIdempotencyKey,
  getActiveReportsForSlaCheck,
  getAuditLogs,
  getAuthorityComplaintsForSession,
  getAuthoritySession,
  getCallLogsByUid,
  getCaregiversByUid,
  getCitizenComplaintById,
  getCitizenComplaintsByUid,
  getMedicalRequests,
  getNotificationsForAuthority,
  getNotificationsForCitizen,
  getOfficers,
  getOperationalReportById,
  getOperationalReports,
  getOperationalSosEvents,
  getPublicHeatmapIncidents,
  getRecentReportsForContext,
  getSlaConfig,
  getSmsLogById,
  getSmsLogs,
  getTrackingSession,
  isAuthorityPasscodeConfigured,
  markAllNotificationsRead,
  markNotificationRead,
  MedicalRequestRecord,
  OperationalReportRecord,
  OperationalReportStatus,
  PlatformNotification,
  registerIdempotencyKey,
  SLA_PAUSED_OR_CLOSED_STATUSES,
  SlaConfig,
  updateCitizenComplaint,
  updateMedicalRequest,
  updateOfficerAvailability,
  updateOperationalReport,
  updateOperationalSos,
  updateSlaConfig,
  updateSmsLogByProviderId,
  UploadedFileRef,
  upsertCaregiver,
  upsertMedicalRequest,
  upsertOfficerProfile,
  upsertOperationalReport,
  upsertOperationalSos,
  upsertTrackingSession,
  verifyAuthorityPasscode,
} from './server/store.ts';

const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';

const UPLOAD_DIR = path.resolve(process.cwd(), 'data', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const ALLOWED_UPLOAD_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const rateBuckets = new Map<string, { count: number; resetAt: number }>();
function checkRateLimit(key: string, maxRequests = 60, windowMs = 60_000): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= maxRequests) return false;
  bucket.count += 1;
  return true;
}

function getBearerToken(req: express.Request): string | undefined {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return undefined;
  return header.slice(7).trim();
}

function saveUploadedFileToDisk(file: Express.Multer.File, caption?: string): UploadedFileRef {
  const ext = ALLOWED_UPLOAD_MIME[file.mimetype];
  if (!ext) {
    throw new Error(`Unsupported file format (${file.mimetype}). Allowed: JPEG, PNG, WEBP, PDF.`);
  }
  const id = `upl_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
  const filename = `${id}${ext}`;
  const destPath = path.resolve(UPLOAD_DIR, filename);
  if (!destPath.startsWith(UPLOAD_DIR + path.sep)) {
    throw new Error('Invalid destination path.');
  }
  fs.writeFileSync(destPath, file.buffer);
  return {
    id,
    filename,
    url: `/api/uploads/${filename}`,
    originalName: (file.originalname || filename).slice(0, 120),
    mimeType: file.mimetype,
    size: file.size,
    ...(caption ? { caption: caption.slice(0, 200) } : {}),
    uploadedAt: new Date().toISOString(),
  };
}

async function startServer() {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  const clientTopics = new Map<WebSocket, Set<string>>();

  wss.on('connection', (ws) => {
    clientTopics.set(ws, new Set());
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type?: string; topic?: string };
        const topics = clientTopics.get(ws);
        if (!topics || !msg.topic) return;
        if (msg.type === 'subscribe') topics.add(msg.topic);
        if (msg.type === 'unsubscribe') topics.delete(msg.topic);
      } catch {
        // Ignore malformed socket frames
      }
    });
    ws.on('close', () => {
      clientTopics.delete(ws);
    });
  });

  function broadcast(topic: string, event: string, payload: unknown) {
    const message = JSON.stringify({ topic, event, payload, timestamp: new Date().toISOString() });
    for (const [client, topics] of clientTopics.entries()) {
      if (client.readyState === WebSocket.OPEN && topics.has(topic)) {
        client.send(message);
      }
    }
  }

  registerSmsStatusListener((log) => {
    broadcast('authority:all', 'sms:updated', log);
  });

  function pushNotification(params: Omit<PlatformNotification, 'id' | 'read' | 'createdAt'>): PlatformNotification {
    const saved = addPlatformNotification(params);
    if (saved.targetType === 'citizen' && saved.targetUid) {
      broadcast(`citizen:${saved.targetUid}`, 'notification:new', saved);
    } else if (saved.targetType === 'officer' && saved.targetUid) {
      broadcast(`officer:${saved.targetUid}`, 'notification:new', saved);
      broadcast('authority:all', 'notification:new', saved);
    } else {
      broadcast('authority:all', 'notification:new', saved);
    }
    return saved;
  }

  app.set('trust proxy', 1);
  app.use(express.json({ limit: '6mb' }));
  app.use(express.urlencoded({ extended: false }));

  // Role isolation guard: block authenticated Authority tokens from invoking citizen-only routes
  function rejectIfAuthorityToken(req: express.Request, res: express.Response): boolean {
    const token = getBearerToken(req);
    if (token && getAuthoritySession(token)) {
      res.status(403).json({
        error: 'Dashboard Isolation Enforced: Authority accounts cannot access citizen-only routes or submit citizen actions.',
        code: 'ROLE_ISOLATION_FORBIDDEN',
      });
      return true;
    }
    return false;
  }

  function canSessionAccessReport(session: AuthoritySession, report: OperationalReportRecord): boolean {
    if (session.role === 'admin') return true;
    if (session.role === 'supervisor') {
      return (
        session.department === 'All Departments' ||
        session.department === 'Emergency Control Room' ||
        report.department === session.department
      );
    }
    // Field authority officer: department match AND either unassigned or assigned to this officer
    if (report.department !== session.department) return false;
    if (!report.assignedOfficerUid && !report.assignedOfficer) return true;
    return (
      report.assignedOfficerUid === session.uid ||
      Boolean(report.assignedOfficer && report.assignedOfficer.toLowerCase() === session.name.toLowerCase())
    );
  }

  function formatStatusSmsMessage(report: OperationalReportRecord, extraNote?: string): string {
    return `SEVA AI Update [${report.complaintId}]: Status is now "${report.status}" (${report.department}).${
      extraNote ? ` Note: ${extraNote.slice(0, 120)}` : ''
    }`;
  }

  async function maybeDispatchComplaintSms(
    report: OperationalReportRecord,
    eventType: 'complaint_status_updated' | 'resolution_completed',
    extraNote?: string
  ) {
    const recipientPhone = report.reporterPhone;
    if (!recipientPhone || report.smsUpdatesOptIn === false) return null;
    return dispatchCaregiverSmsAlerts({
      emergencyId: `${report.id}:${report.status}`,
      emergencyType: eventType,
      citizenName: report.reporterDisplayName,
      messageBody: formatStatusSmsMessage(report, extraNote),
      recipients: [{ name: report.reporterDisplayName, phone: recipientPhone }],
    });
  }

  // Background Automated SLA Escalation Scheduler (runs independent of UI)
  function runSlaEscalationSweep() {
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const activeReports = getActiveReportsForSlaCheck();

    for (const r of activeReports) {
      if (!r.slaDeadlineAt) continue;
      const deadlineMs = new Date(r.slaDeadlineAt).getTime();
      if (!Number.isFinite(deadlineMs)) continue;
      const createdMs = new Date(r.createdAt).getTime() || nowMs;
      const totalWindowMs = Math.max(1000, deadlineMs - createdMs);
      const remainingMs = deadlineMs - nowMs;

      // Approaching SLA Warning at <= 25% remaining
      if (remainingMs > 0 && remainingMs <= totalWindowMs * 0.25 && !r.slaWarningSentAt) {
        const warned = updateOperationalReport(r.id, (prev) => ({
          ...prev,
          slaWarningSentAt: nowIso,
        }));
        if (warned) {
          pushNotification({
            targetType: warned.assignedOfficerUid ? 'officer' : 'authority',
            targetUid: warned.assignedOfficerUid,
            targetDepartment: warned.department,
            type: 'sla_approaching',
            priority: 'high',
            title: `Approaching SLA Deadline (${warned.complaintId})`,
            message: `${warned.title} (${warned.severity}) is nearing SLA deadline (${warned.slaDeadlineAt}).`,
            relatedType: 'report',
            relatedId: warned.id,
          });
          broadcast('authority:all', 'report:updated', warned);
        }
        continue;
      }

      // SLA Breached -> Automatic Multi-Level Escalation without duplicates
      if (nowMs >= deadlineMs) {
        const overdueMs = nowMs - deadlineMs;
        const currentLevel = r.escalationLevel || 0;
        let nextLevel: 1 | 2 | 3 | null = null;
        if (currentLevel < 1) {
          nextLevel = 1;
        } else if (currentLevel === 1 && overdueMs >= Math.max(2500, totalWindowMs * 0.5)) {
          nextLevel = 2;
        } else if (currentLevel === 2 && overdueMs >= Math.max(5000, totalWindowMs * 1.0)) {
          nextLevel = 3;
        }

        if (!nextLevel) continue;
        const alreadyLogged = (r.escalations || []).some((e) => e.level === nextLevel);
        if (alreadyLogged) continue;

        const targetRole =
          nextLevel === 3
            ? 'Senior Authority / Admin'
            : nextLevel === 2
            ? 'Department Supervisor'
            : 'Assigned Officer / Duty Lead';

        const reason = `Automated SLA Breach Escalation (Level ${nextLevel}): Complaint exceeded ${r.severity} SLA deadline (${r.slaDeadlineAt}).`;

        const escalated = updateOperationalReport(r.id, (prev) => {
          if ((prev.escalations || []).some((e) => e.level === nextLevel)) return prev;
          return {
            ...prev,
            status: 'Escalated',
            slaBreachedAt: prev.slaBreachedAt || nowIso,
            escalationLevel: nextLevel!,
            escalations: [
              ...(prev.escalations || []),
              {
                id: `esc_auto_${Date.now()}_${nextLevel}`,
                level: nextLevel!,
                targetRole,
                reason,
                escalatedBy: 'Automated SLA Engine',
                automated: true,
                status: 'open',
                createdAt: nowIso,
              },
            ],
            timeline: [
              ...prev.timeline,
              {
                step: `auto_escalated_l${nextLevel}`,
                label: `Auto-Escalated (Level ${nextLevel}: ${targetRole})`,
                actorRole: 'Automated SLA Engine',
                note: reason,
                timestamp: nowIso,
              },
            ],
            updatedAt: nowIso,
          };
        });

        if (escalated) {
          addAuditLog({
            actorUid: 'sla_scheduler',
            actorRole: 'system',
            department: escalated.department,
            action: `auto_escalation_level_${nextLevel}`,
            targetId: escalated.complaintId,
            detail: reason,
          });
          pushNotification({
            targetType: nextLevel === 1 && escalated.assignedOfficerUid ? 'officer' : 'supervisor',
            targetUid: nextLevel === 1 ? escalated.assignedOfficerUid : undefined,
            targetDepartment: escalated.department,
            type: 'report_escalated',
            priority: 'emergency',
            title: `SLA Breached · L${nextLevel} Escalation (${escalated.complaintId})`,
            message: `${escalated.title} escalated to ${targetRole}.`,
            relatedType: 'escalation',
            relatedId: escalated.id,
          });
          pushNotification({
            targetType: 'citizen',
            targetUid: escalated.reporterUid,
            type: 'report_escalated',
            priority: 'high',
            title: `Complaint Escalated (${escalated.complaintId})`,
            message: `Your report exceeded target SLA and was automatically escalated to ${targetRole}.`,
            relatedType: 'report',
            relatedId: escalated.id,
          });
          broadcast('authority:all', 'report:updated', escalated);
          broadcast(`citizen:${escalated.reporterUid}`, 'report:updated', escalated);
        }
      }
    }
  }

  setInterval(runSlaEscalationSweep, 3000);

  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/')) {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    }
    next();
  });

  // =========================================================================
  // HEALTH & CAPABILITIES
  // =========================================================================
  app.get('/api/health', (_req, res) => {
    const smsCap = isSmsGatewayConfigured();
    res.json({
      status: 'ok',
      service: 'SEVA AI Civic & Emergency Platform',
      timestamp: new Date().toISOString(),
      capabilities: {
        elevenlabsConfigured: isElevenLabsConfigured(),
        geminiConfigured: isGeminiConfigured(),
        authorityPasscodeConfigured: isAuthorityPasscodeConfigured(),
        smsConfigured: smsCap.configured,
        smsProvider: smsCap.provider,
        smsMode: smsCap.mode,
        smsSenderConfigured: smsCap.senderPhoneConfigured,
        smsMessagingServiceConfigured: smsCap.messagingServiceConfigured,
        voiceCallingEnabled: smsCap.voiceEnabled,
      },
    });
  });

  // =========================================================================
  // PERSISTENT FILE UPLOADS (EVIDENCE, RESOLUTION PHOTOS, ACCIDENTS, COMPLAINTS)
  // =========================================================================
  app.post('/api/uploads', upload.array('files', 8), (req, res) => {
    const uploadedList: UploadedFileRef[] = [];
    const files = (req.files as Express.Multer.File[]) || [];
    if (files.length === 0) {
      return res.status(400).json({ error: 'At least one image or PDF file is required.' });
    }
    try {
      for (const f of files) {
        uploadedList.push(saveUploadedFileToDisk(f, req.body?.caption));
      }
      return res.json({ files: uploadedList });
    } catch (err: any) {
      return res.status(400).json({ error: err?.message || 'File upload failed.' });
    }
  });

  app.get('/api/uploads/:filename', (req, res) => {
    const safeName = path.basename(req.params.filename || '');
    if (!safeName || !/^[a-zA-Z0-9._-]+$/.test(safeName)) {
      return res.status(400).json({ error: 'Invalid filename.' });
    }
    const targetPath = path.resolve(UPLOAD_DIR, safeName);
    if (!targetPath.startsWith(UPLOAD_DIR + path.sep) || !fs.existsSync(targetPath)) {
      return res.status(404).json({ error: 'Uploaded file not found.' });
    }
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.sendFile(targetPath);
  });

  // =========================================================================
  // 1. ELEVENLABS & GEMINI VOICE ENDPOINTS (SEVA SAATHI)
  // =========================================================================
  app.get('/api/voice/capabilities', async (_req, res) => {
    const voiceData = await listElevenLabsVoices();
    const geminiOk = isGeminiConfigured();
    const activeVoiceProvider = voiceData.configured ? 'elevenlabs' : geminiOk ? 'gemini' : 'browser';
    res.json({
      elevenlabsConfigured: voiceData.configured,
      geminiVoiceFallback: geminiOk,
      activeVoiceProvider,
      voices: voiceData.voices,
      voiceLookupError: voiceData.error || null,
      languages: Object.values(VOICE_LANGUAGE_CAPABILITIES),
    });
  });

  app.post('/api/voice/tts', async (req, res) => {
    const ip = req.ip || 'unknown';
    if (!checkRateLimit(`tts:${ip}`, 35, 60_000)) {
      return res.status(429).json({ error: 'Voice synthesis rate limit exceeded. Please wait briefly.' });
    }

    const { text, voiceId, language } = req.body as {
      text?: string;
      voiceId?: string;
      language?: SupportedVoiceLanguage;
    };

    if (!text || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'Text is required for speech synthesis.' });
    }

    if (isElevenLabsConfigured() && language !== 'bn' && language !== 'as') {
      try {
        const audioBuffer = await synthesizeWithElevenLabs({ text, voiceId, language });
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Content-Length', audioBuffer.length);
        res.setHeader('X-Voice-Provider', 'elevenlabs');
        res.setHeader('Cache-Control', 'no-store');
        return res.send(audioBuffer);
      } catch (err: any) {
        if (!isGeminiConfigured()) {
          return res.status(502).json({
            error: err?.message || 'ElevenLabs TTS failed.',
            code: err?.code || 'ELEVENLABS_TTS_FAILED',
            fallbackAvailable: true,
          });
        }
      }
    }

    if (isGeminiConfigured()) {
      try {
        const wavBuffer = await synthesizeWithGemini({ text, voiceId, language });
        res.setHeader('Content-Type', 'audio/wav');
        res.setHeader('Content-Length', wavBuffer.length);
        res.setHeader('X-Voice-Provider', 'gemini');
        res.setHeader('Cache-Control', 'no-store');
        return res.send(wavBuffer);
      } catch (err: any) {
        return res.status(502).json({
          error: err?.message || 'Speech synthesis unavailable right now.',
          code: 'GEMINI_TTS_FAILED',
          fallbackAvailable: true,
        });
      }
    }

    return res.status(503).json({
      error: 'No server speech synthesis key is configured. Add ELEVENLABS_API_KEY or GEMINI_API_KEY in Settings > Secrets.',
      code: 'VOICE_ENGINE_UNCONFIGURED',
      fallbackAvailable: true,
    });
  });

  app.post('/api/voice/stt', upload.single('audio'), async (req, res) => {
    const ip = req.ip || 'unknown';
    if (!checkRateLimit(`stt:${ip}`, 35, 60_000)) {
      return res.status(429).json({ error: 'Speech recognition rate limit exceeded. Please wait briefly.' });
    }

    const file = req.file;
    if (!file || !file.buffer || file.buffer.length < 400) {
      return res.status(400).json({ error: 'Audio recording is empty or too short. Please speak clearly and try again.' });
    }

    const language = (req.body?.language as SupportedVoiceLanguage | 'auto') || 'auto';

    if (isElevenLabsConfigured()) {
      try {
        const result = await transcribeWithElevenLabs({
          audioBuffer: file.buffer,
          mimeType: file.mimetype || 'audio/webm',
          filename: file.originalname || 'recording.webm',
          language,
        });

        if (!result.text) {
          return res.status(422).json({
            error: 'No clear speech was detected in the recording. Please try speaking closer to the microphone.',
            code: 'EMPTY_TRANSCRIPTION',
          });
        }

        return res.json({
          provider: 'elevenlabs_scribe_v1',
          text: result.text,
          languageCode: result.languageCode,
          languageProbability: result.languageProbability,
        });
      } catch (err: any) {
        if (!isGeminiConfigured()) {
          return res.status(502).json({
            error: err?.message || 'ElevenLabs speech recognition failed.',
            code: err?.code || 'ELEVENLABS_STT_FAILED',
            fallbackAvailable: true,
          });
        }
      }
    }

    if (isGeminiConfigured()) {
      try {
        const gemResult = await transcribeWithGemini({
          audioBuffer: file.buffer,
          mimeType: file.mimetype || 'audio/webm',
          language,
        });

        if (!gemResult.text) {
          return res.status(422).json({
            error: 'No clear speech was detected in the recording. Please try speaking closer to the microphone.',
            code: 'EMPTY_TRANSCRIPTION',
          });
        }

        return res.json({
          provider: 'gemini_3_5_transcribe',
          text: gemResult.text,
          languageCode: gemResult.languageCode,
        });
      } catch (err: any) {
        return res.status(502).json({
          error: err?.message || 'Speech recognition failed. You can edit or type your message below.',
          code: 'GEMINI_STT_FAILED',
          fallbackAvailable: true,
        });
      }
    }

    return res.status(503).json({
      error: 'No speech transcription service key is configured on the server.',
      code: 'VOICE_ENGINE_UNCONFIGURED',
      fallbackAvailable: true,
    });
  });

  app.post('/api/voice/assistant', async (req, res) => {
    const ip = req.ip || 'unknown';
    if (!checkRateLimit(`saathi:${ip}`, 45, 60_000)) {
      return res.status(429).json({ error: 'Assistant rate limit exceeded. Please wait briefly.' });
    }

    const { message, language, history, userContext } = req.body as {
      message?: string;
      language?: SupportedVoiceLanguage;
      history?: Array<{ role: 'user' | 'assistant'; text: string }>;
      userContext?: {
        isSignedIn?: boolean;
        role?: string;
        currentAddress?: string;
        lat?: number;
        lng?: number;
        myReportsSummary?: Array<{ complaintId: string; referenceNumber?: string; title: string; category: string; status: string; updatedAt: string }>;
        includeAuthorityStats?: boolean;
      };
    };

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'A message or transcribed utterance is required.' });
    }

    try {
      const authSession = getAuthoritySession(getBearerToken(req));
      let authorityStatsSummary;
      if (userContext?.includeAuthorityStats && authSession) {
        const all = getOperationalReports({ fraudQueue: 'operational', includeSensitive: true });
        authorityStatsSummary = {
          total: all.length,
          pending: all.filter((r) => !CLOSED_REPORT_STATUSES.has(r.status)).length,
          resolved: all.filter((r) => r.status === 'Verified Resolution' || r.status === 'Resolved – Awaiting Verification').length,
          emergencies: all.filter((r) => r.isEmergency && !CLOSED_REPORT_STATUSES.has(r.status)).length,
          recentHeadlines: all.slice(0, 5).map((r) => `${r.complaintId}: ${r.category} (${r.status}) at ${r.locality || r.address}`),
        };
      }

      const aiResponse = await processSaathiConversation({
        userMessage: message.trim().slice(0, 1500),
        language: language || 'en',
        history: Array.isArray(history) ? history.slice(-6) : [],
        userContext: {
          isSignedIn: Boolean(userContext?.isSignedIn),
          role: userContext?.role || 'citizen',
          currentAddress: userContext?.currentAddress,
          lat: userContext?.lat,
          lng: userContext?.lng,
          myReportsSummary: Array.isArray(userContext?.myReportsSummary) ? userContext!.myReportsSummary : [],
          authorityStatsSummary,
        },
      });

      return res.json(aiResponse);
    } catch (err: any) {
      console.error('SEVA SAATHI assistant error:', err);
      return res.status(502).json({
        error: err?.message || 'Unable to process civic assistant request.',
      });
    }
  });

  // =========================================================================
  // 2. AI CIVIC REPORT ANALYSIS & SEVA TRUST VERIFICATION ENGINE
  // =========================================================================
  app.post('/api/ai/analyze-report', async (req, res) => {
    const ip = req.ip || 'unknown';
    if (!checkRateLimit(`analyze:${ip}`, 30, 60_000)) {
      return res.status(429).json({ error: 'Analysis rate limit exceeded.' });
    }

    const { category, title, description, severity, address, lat, lng, photoDataUrl } = req.body as {
      category?: string;
      title?: string;
      description?: string;
      severity?: string;
      address?: string;
      lat?: number;
      lng?: number;
      photoDataUrl?: string;
    };

    if (!description || !title || typeof lat !== 'number' || typeof lng !== 'number') {
      return res.status(400).json({ error: 'Title, description, and valid coordinates are required for AI analysis.' });
    }

    let photoBase64: string | undefined;
    let photoMimeType: string | undefined;
    let currentImageHash: string | undefined;

    if (photoDataUrl && typeof photoDataUrl === 'string' && photoDataUrl.startsWith('data:image/')) {
      const match = photoDataUrl.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/);
      if (match) {
        photoMimeType = match[1];
        photoBase64 = match[2];
        currentImageHash = crypto.createHash('sha256').update(photoBase64).digest('hex').slice(0, 24);
      }
    }

    try {
      const result = await analyzeCivicReport({
        category: category || CIVIC_CATEGORIES[0],
        title: title.slice(0, 160),
        description: description.slice(0, 3000),
        severity: severity || 'Medium',
        address: address || '',
        lat,
        lng,
        photoBase64,
        photoMimeType,
        recentReportsContext: getRecentReportsForContext(),
        currentImageHash,
      });
      return res.json({ ...result, imageHash: currentImageHash });
    } catch (err: any) {
      console.error('AI analysis failed:', err);
      return res.status(502).json({
        error: err?.message || 'AI analysis service unavailable. You can still submit manually.',
      });
    }
  });

  // =========================================================================
  // 3. NEARBY PLACES, HOSPITALS/POLICE STRICT LOOKUP & GEOCODING
  // =========================================================================
  app.get('/api/places/nearby', async (req, res) => {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const radius = Number(req.query.radius || 2000);
    const categoriesParam = String(req.query.categories || 'healthcare,public_safety');
    const strictMedicalSafety = String(req.query.strictMedicalSafety || '').toLowerCase() === 'true';
    const rawMode = String(req.query.mode || '').trim() as NearbySearchMode;
    const mode: NearbySearchMode | undefined =
      rawMode === 'medical_facilities' ||
      rawMode === 'police_only' ||
      rawMode === 'strict_medical_safety' ||
      rawMode === 'general'
        ? rawMode
        : undefined;
    const forceRefresh = String(req.query.refresh || '').toLowerCase() === 'true';

    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return res.status(400).json({ error: 'Valid GPS coordinates (lat, lng) are required.' });
    }
    if (!Number.isFinite(radius) || radius < 100 || radius > 50000) {
      return res.status(400).json({ error: 'Search radius must be between 100 meters and 50,000 meters (50 km).' });
    }

    const categories = categoriesParam
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean) as NearbyCategoryKey[];

    try {
      const data = await fetchNearbyPlaces({
        lat,
        lng,
        radiusMeters: radius,
        categories,
        strictMedicalSafety,
        mode,
        forceRefresh,
      });
      return res.json(data);
    } catch (err: any) {
      const statusCode = err instanceof PlacesProviderError ? err.httpStatus : 502;
      const code = err instanceof PlacesProviderError ? err.code : 'UPSTREAM_FETCH_FAILED';
      return res.status(statusCode).json({
        error: err?.message || 'Unable to retrieve nearby places from OpenStreetMap services.',
        code,
      });
    }
  });

  app.get('/api/places/reverse', async (req, res) => {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: 'Valid lat and lng parameters are required.' });
    }
    const result = await reverseGeocode(lat, lng);
    return res.json(result);
  });

  app.get('/api/places/search', async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 3) {
      return res.status(400).json({ error: 'Please enter at least 3 characters to search a city, landmark, or street.' });
    }
    const found = await geocodeLocationQuery(q);
    if (!found) {
      return res.status(404).json({ error: `No matching location found for "${q}". Try adding city/state name.` });
    }
    return res.json(found);
  });

  // =========================================================================
  // 4. REAL-TIME LIVE GPS TRACKING SESSIONS
  // =========================================================================
  app.post('/api/tracking/update', (req, res) => {
    const { shareToken, ownerUid, ownerDisplayName, status, lat, lng, accuracyMeters, address, expiresAt } = req.body as {
      shareToken?: string;
      ownerUid?: string;
      ownerDisplayName?: string;
      status?: 'active' | 'paused' | 'stopped' | 'revoked';
      lat?: number;
      lng?: number;
      accuracyMeters?: number;
      address?: string;
      expiresAt?: string;
    };

    if (!shareToken || !/^[a-zA-Z0-9_-]{8,128}$/.test(shareToken) || typeof lat !== 'number' || typeof lng !== 'number') {
      return res.status(400).json({ error: 'Valid shareToken and GPS coordinates are required.' });
    }

    const existing = getTrackingSession(shareToken);
    const nowIso = new Date().toISOString();
    const point = {
      lat,
      lng,
      accuracyMeters: typeof accuracyMeters === 'number' ? accuracyMeters : 0,
      address: (address || '').slice(0, 300),
      timestamp: nowIso,
    };

    const nextHistory = existing ? [...existing.history.slice(-99), point] : [point];
    const updated = {
      shareToken,
      ownerUid: existing?.ownerUid || ownerUid || 'citizen',
      ownerDisplayName: existing?.ownerDisplayName || (ownerDisplayName || 'SEVA Citizen').slice(0, 60),
      status: status || 'active',
      lat,
      lng,
      accuracyMeters: point.accuracyMeters,
      address: point.address,
      expiresAt: existing?.expiresAt || expiresAt || new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      updatedAt: nowIso,
      history: nextHistory,
    };

    upsertTrackingSession(updated);
    broadcast(`track:${shareToken}`, 'tracking:update', updated);
    return res.json(updated);
  });

  app.get('/api/tracking/:shareToken', (req, res) => {
    const rec = getTrackingSession(req.params.shareToken);
    if (!rec) {
      return res.status(404).json({ error: 'Tracking session not found or expired.' });
    }
    if (rec.status === 'revoked') {
      return res.status(410).json({ error: 'This live location sharing link has been revoked or expired.', status: 'revoked' });
    }
    return res.json({
      shareToken: rec.shareToken,
      ownerDisplayName: rec.ownerDisplayName,
      status: rec.status,
      lat: rec.lat,
      lng: rec.lng,
      accuracyMeters: rec.accuracyMeters,
      address: rec.address,
      expiresAt: rec.expiresAt,
      updatedAt: rec.updatedAt,
      history: rec.history,
    });
  });

  // =========================================================================
  // 5. AUTHORITY RBAC AUTHENTICATION & OFFICER ROSTER
  // =========================================================================
  app.get('/api/auth/authority-config', (_req, res) => {
    res.json({
      passcodeConfigured: isAuthorityPasscodeConfigured(),
    });
  });

  app.post('/api/auth/claim-authority-passcode', (req, res) => {
    const { passcode } = req.body as { passcode?: string };
    if (!passcode || passcode.trim().length < 6) {
      return res.status(400).json({ error: 'Department passcode must be at least 6 characters.' });
    }
    if (isAuthorityPasscodeConfigured()) {
      return res.status(409).json({ error: 'An official authority passcode is already configured.' });
    }
    const ok = claimFirstRunAuthorityPasscode(passcode);
    if (!ok) {
      return res.status(400).json({ error: 'Unable to configure passcode.' });
    }
    return res.json({ configured: true });
  });

  app.post('/api/auth/verify-authority', (req, res) => {
    const ip = req.ip || 'unknown';
    if (!checkRateLimit(`auth:${ip}`, 20, 60_000)) {
      return res.status(429).json({ error: 'Too many verification attempts. Please wait a minute.' });
    }

    const { uid, email, name, department, jurisdiction, designation, roleChoice, phone, passcode, googleSignedIn } =
      req.body as {
        uid?: string;
        email?: string;
        name?: string;
        department?: string;
        jurisdiction?: string;
        designation?: string;
        roleChoice?: AuthorityRole;
        phone?: string;
        passcode?: string;
        googleSignedIn?: boolean;
      };

    if (!email || !department || !passcode) {
      return res.status(400).json({ error: 'Officer email, department, and official access code are required.' });
    }

    if (!isAuthorityPasscodeConfigured()) {
      return res.status(412).json({
        error: 'Authority department passcode has not been configured yet.',
        code: 'PASSCODE_NOT_CONFIGURED',
      });
    }

    if (!verifyAuthorityPasscode(passcode)) {
      return res.status(403).json({ error: 'Invalid department access code.' });
    }

    const safeUid =
      uid && /^[a-zA-Z0-9_-]{3,128}$/.test(uid)
        ? uid
        : `officer_${crypto.createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 16)}`;

    const isAdmin =
      Boolean(googleSignedIn) &&
      (email.toLowerCase() === 'guptakeshav2178@gmail.com' ||
        department === 'Platform Administration' ||
        roleChoice === 'admin');

    const session = createAuthoritySession({
      uid: safeUid,
      email: email.trim().slice(0, 200),
      name: (name || 'Authority Officer').trim().slice(0, 120),
      department,
      jurisdiction: jurisdiction || 'Citywide',
      designation: designation?.trim().slice(0, 100),
      roleChoice: roleChoice === 'supervisor' ? 'supervisor' : 'authority',
      phone: phone?.trim().slice(0, 20),
      isAdmin,
    });

    addAuditLog({
      actorUid: safeUid,
      actorRole: session.role,
      department: session.department,
      action: 'authority_login',
      targetId: safeUid,
      detail: `Authenticated ${session.role} (${session.name}) in ${department} (${jurisdiction || 'Citywide'}).`,
    });

    return res.json({
      token: session.token,
      uid: session.uid,
      name: session.name,
      role: session.role,
      department: session.department,
      jurisdiction: session.jurisdiction,
      designation: session.designation,
      expiresAt: session.expiresAt,
    });
  });

  app.get('/api/authority/officers', (req, res) => {
    const session = getAuthoritySession(getBearerToken(req));
    if (!session) return res.status(401).json({ error: 'Authorized department session required.' });
    const dept = req.query.department ? String(req.query.department) : undefined;
    return res.json({ officers: getOfficers(dept) });
  });

  app.post('/api/authority/officers', (req, res) => {
    const session = getAuthoritySession(getBearerToken(req));
    if (!session) return res.status(401).json({ error: 'Authorized department session required.' });
    if (session.role !== 'supervisor' && session.role !== 'admin') {
      return res.status(403).json({ error: 'Supervisor or Administrator privileges required to register field personnel.' });
    }
    const { name, email, department, designation, jurisdiction, phone, role } = req.body as {
      name?: string;
      email?: string;
      department?: string;
      designation?: string;
      jurisdiction?: string;
      phone?: string;
      role?: AuthorityRole;
    };
    if (!name?.trim() || !email?.trim() || !department?.trim()) {
      return res.status(400).json({ error: 'Officer name, email, and department are required.' });
    }
    const uid = `officer_${crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 16)}`;
    const officer = upsertOfficerProfile({
      uid,
      name: name.trim().slice(0, 120),
      email: email.trim().slice(0, 200),
      department: department.trim().slice(0, 80),
      role: role === 'supervisor' ? 'supervisor' : 'authority',
      designation: (designation || 'Field Engineer / Inspector').trim().slice(0, 100),
      jurisdiction: (jurisdiction || session.jurisdiction || 'Citywide').trim().slice(0, 100),
      phone: phone?.trim().slice(0, 20),
      availability: 'available',
      lastActiveAt: new Date().toISOString(),
    });
    addAuditLog({
      actorUid: session.uid,
      actorRole: session.role,
      department: session.department,
      action: 'officer_registered',
      targetId: officer.uid,
      detail: `Registered ${officer.name} (${officer.designation}) in ${officer.department}.`,
    });
    return res.json({ officer });
  });

  app.patch('/api/authority/officers/availability', (req, res) => {
    const session = getAuthoritySession(getBearerToken(req));
    if (!session) return res.status(401).json({ error: 'Authorized department session required.' });
    const { uid, availability } = req.body as { uid?: string; availability?: 'available' | 'busy' | 'off_duty' };
    const targetUid = uid || session.uid;
    if (targetUid !== session.uid && session.role !== 'supervisor' && session.role !== 'admin') {
      return res.status(403).json({ error: 'Only supervisors or admins can update another officer availability.' });
    }
    if (!availability || !['available', 'busy', 'off_duty'].includes(availability)) {
      return res.status(400).json({ error: 'Valid availability state required (available, busy, off_duty).' });
    }
    const updated = updateOfficerAvailability(targetUid, availability);
    if (!updated) return res.status(404).json({ error: 'Officer not found.' });
    return res.json({ officer: updated });
  });

  // =========================================================================
  // 6. CIVIC REPORTS LIFECYCLE (SYNC + AUTO AI VERIFY, DEDUP, FOLLOW-UP, CONFIRM/REOPEN)
  // =========================================================================
  app.post('/api/reports/sync', async (req, res) => {
    if (rejectIfAuthorityToken(req, res)) return;
    const body = req.body as OperationalReportRecord;
    if (!body?.id || !body?.complaintId || !body?.reporterUid || !body?.title) {
      return res.status(400).json({ error: 'Invalid report payload.' });
    }

    const idemKey = body.idempotencyKey?.trim();
    if (idemKey) {
      const deduped = findReportByIdempotencyKey(idemKey);
      if (deduped) {
        return res.json({
          synced: true,
          deduplicated: true,
          complaintId: deduped.complaintId,
          referenceNumber: deduped.referenceNumber,
          report: deduped,
        });
      }
    }

    const existing = getOperationalReportById(body.id);
    const nowIso = new Date().toISOString();

    let payloadToSave: OperationalReportRecord = {
      ...body,
      department: body.department || DEPARTMENT_BY_CATEGORY[body.category] || 'Municipal Corporation',
      timeline: Array.isArray(body.timeline) && body.timeline.length > 0
        ? body.timeline
        : [
            {
              step: 'submitted',
              label: 'Submitted by Citizen',
              actorRole: 'Citizen',
              note: body.address,
              timestamp: body.createdAt || nowIso,
            },
          ],
    };

    // Automatic AI Verification on new submissions when not already pre-analyzed
    if (!existing && !body.aiVerifiedAt) {
      let photoBase64: string | undefined;
      let photoMimeType: string | undefined;
      let currentImageHash = body.imageHash;
      if (body.photoDataUrl && typeof body.photoDataUrl === 'string' && body.photoDataUrl.startsWith('data:image/')) {
        const match = body.photoDataUrl.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/);
        if (match) {
          photoMimeType = match[1];
          photoBase64 = match[2];
          currentImageHash = currentImageHash || crypto.createHash('sha256').update(photoBase64).digest('hex').slice(0, 24);
        }
      }

      try {
        const aiResult = await analyzeCivicReport({
          category: body.category || CIVIC_CATEGORIES[0],
          title: body.title.slice(0, 160),
          description: (body.description || body.title).slice(0, 3000),
          severity: body.severity || 'Medium',
          address: body.address || '',
          lat: Number(body.lat) || 0,
          lng: Number(body.lng) || 0,
          photoBase64,
          photoMimeType,
          recentReportsContext: getRecentReportsForContext(),
          currentImageHash,
        });

        const shouldVerify = aiResult.recommendedAction === 'accept' && aiResult.fraudRiskScore < 45;
        payloadToSave = {
          ...payloadToSave,
          imageHash: currentImageHash,
          aiSummary: aiResult.summary,
          aiSuggestedCategory: aiResult.suggestedCategory,
          aiDetectedCategory: aiResult.aiDetectedCategory,
          aiSuggestedSeverity: aiResult.suggestedSeverity,
          aiConfidence: aiResult.confidence,
          aiDuplicateCheck: aiResult.duplicateCheckResult,
          aiMissingInfoFlags: aiResult.missingInfoFlags,
          aiRecommendedAction: aiResult.recommendedAction,
          aiVerifiedAt: nowIso,
          imageMatchesDescription: aiResult.imageMatchesDescription,
          detectedIssueFromImage: aiResult.detectedIssueFromImage,
          fraudRiskScore: aiResult.fraudRiskScore,
          fraudProbability: aiResult.fraudProbability,
          fraudRiskLevel: aiResult.fraudRiskLevel,
          fraudIndicators: aiResult.fraudIndicators || [],
          fraudExplanation: aiResult.fraudExplanation,
          evidenceCompleteness: aiResult.evidenceCompleteness,
          recommendedActionText: aiResult.recommendedActionText,
          fraudQueueStatus:
            aiResult.fraudRiskScore >= 80
              ? 'investigation_queue'
              : aiResult.fraudRiskScore >= 60
              ? 'restricted_queue'
              : aiResult.fraudRiskScore >= 30 || aiResult.isDuplicate
              ? 'validation_needed'
              : 'cleared',
          verificationStatus: shouldVerify ? 'Verified' : 'Flagged for Manual Review',
          status: shouldVerify ? 'Verified' : 'AI Verification Pending',
          timeline: [
            ...payloadToSave.timeline,
            {
              step: shouldVerify ? 'ai_verified' : 'ai_verification_pending',
              label: shouldVerify
                ? `AI Verified (${aiResult.confidence}% confidence)`
                : `AI Flagged for Manual Review (Risk ${aiResult.fraudRiskScore}/100)`,
              actorRole: 'SEVA AI Verification Engine',
              note: aiResult.recommendedActionText,
              timestamp: nowIso,
            },
          ],
        };
      } catch (err: any) {
        payloadToSave = {
          ...payloadToSave,
          imageHash: currentImageHash,
          status: 'AI Verification Pending',
          verificationStatus: 'Pending Verification',
          aiVerificationError: err?.message || 'AI Verification service unavailable; queued for manual authority review.',
          fraudIndicators: payloadToSave.fraudIndicators || [],
          timeline: [
            ...payloadToSave.timeline,
            {
              step: 'ai_verification_pending',
              label: 'AI Verification Pending (Queued for Authority Review)',
              actorRole: 'System',
              note: err?.message || 'AI key unavailable or request timed out.',
              timestamp: nowIso,
            },
          ],
        };
      }
    }

    const saved = upsertOperationalReport(payloadToSave);
    if (idemKey) {
      registerIdempotencyKey(idemKey, saved.id);
    }

    if (!existing) {
      pushNotification({
        targetType: 'citizen',
        targetUid: saved.reporterUid,
        type: 'report_submitted',
        priority: saved.isEmergency ? 'emergency' : 'normal',
        title: `Report ${saved.complaintId} Submitted`,
        message: `Ref ${saved.referenceNumber} · Routed to ${saved.department}. Status: ${saved.status}.`,
        relatedType: 'report',
        relatedId: saved.id,
      });

      pushNotification({
        targetType: 'authority',
        targetDepartment: saved.department,
        type:
          saved.fraudQueueStatus === 'restricted_queue' || saved.fraudQueueStatus === 'investigation_queue'
            ? 'report_flagged'
            : 'report_new',
        priority: saved.isEmergency ? 'emergency' : saved.severity === 'High' || saved.severity === 'Critical' ? 'high' : 'normal',
        title: saved.isEmergency ? `EMERGENCY: ${saved.title}` : `New Civic Report (${saved.complaintId})`,
        message: `${saved.category} · ${saved.severity} · ${saved.address} (${saved.status})`,
        relatedType: 'report',
        relatedId: saved.id,
      });
    }

    broadcast('authority:all', 'report:new', saved);
    broadcast(`citizen:${saved.reporterUid}`, 'report:updated', saved);

    return res.json({
      synced: true,
      complaintId: saved.complaintId,
      referenceNumber: saved.referenceNumber,
      report: saved,
    });
  });

  app.get('/api/reports/lookup/:ref', (req, res) => {
    const ref = (req.params.ref || '').trim();
    if (!ref) return res.status(400).json({ error: 'Reference or Complaint ID required.' });
    const found = getOperationalReportById(ref);
    if (!found) {
      return res.status(404).json({ error: `No civic report matched reference "${ref}".` });
    }
    return res.json({ report: found });
  });

  app.get('/api/citizen/reports/:uid', (req, res) => {
    if (rejectIfAuthorityToken(req, res)) return;
    const reports = getOperationalReports({ fraudQueue: 'all', includeSensitive: true }).filter(
      (r) => r.reporterUid === req.params.uid
    );
    return res.json({ reports });
  });

  app.post('/api/citizen/reports/:id/follow-up', (req, res) => {
    if (rejectIfAuthorityToken(req, res)) return;
    const { uid, note, evidenceFiles } = req.body as {
      uid?: string;
      note?: string;
      evidenceFiles?: UploadedFileRef[];
    };
    const target = getOperationalReportById(req.params.id);
    if (!target) return res.status(404).json({ error: 'Report not found.' });
    if (!uid || target.reporterUid !== uid) {
      return res.status(403).json({ error: 'Only the reporting citizen can add follow-up evidence.' });
    }
    if (!note?.trim() && (!evidenceFiles || evidenceFiles.length === 0)) {
      return res.status(400).json({ error: 'Provide follow-up notes or attach evidence file(s).' });
    }

    const nowIso = new Date().toISOString();
    const updated = updateOperationalReport(req.params.id, (prev) => {
      const nextUploads = [...(prev.citizenEvidenceUploads || []), ...(evidenceFiles || [])];
      const nextDesc = note?.trim()
        ? `${prev.description}\n[Citizen Follow-Up ${new Date().toLocaleDateString()}]: ${note.trim()}`.slice(0, 3000)
        : prev.description;
      return {
        ...prev,
        description: nextDesc,
        citizenEvidenceUploads: nextUploads,
        additionalEvidenceRequested: false,
        status: prev.status === 'Submitted' || prev.additionalEvidenceRequested ? 'AI Verification Pending' : prev.status,
        timeline: [
          ...prev.timeline,
          {
            step: 'citizen_follow_up',
            label: evidenceFiles?.length ? 'Citizen Uploaded Additional Evidence' : 'Citizen Added Follow-Up Details',
            actorRole: 'Citizen',
            note: note?.trim() || `${evidenceFiles?.length || 0} evidence file(s) uploaded`,
            timestamp: nowIso,
          },
        ],
        updatedAt: nowIso,
      };
    });

    if (!updated) return res.status(404).json({ error: 'Update failed.' });

    pushNotification({
      targetType: 'authority',
      targetDepartment: updated.department,
      type: 'citizen_evidence_submitted',
      priority: 'high',
      title: `Follow-Up Evidence Added (${updated.complaintId})`,
      message: `${updated.reporterDisplayName} submitted additional details/evidence.`,
      relatedType: 'report',
      relatedId: updated.id,
    });
    broadcast('authority:all', 'report:updated', updated);
    broadcast(`citizen:${updated.reporterUid}`, 'report:updated', updated);

    return res.json({ report: updated });
  });

  app.post('/api/citizen/reports/:id/resolution-response', async (req, res) => {
    if (rejectIfAuthorityToken(req, res)) return;
    const { uid, action, rating, comment, disputeReason } = req.body as {
      uid?: string;
      action?: 'confirm' | 'reopen';
      rating?: number;
      comment?: string;
      disputeReason?: string;
    };

    const target = getOperationalReportById(req.params.id);
    if (!target) return res.status(404).json({ error: 'Report not found.' });
    if (!uid || target.reporterUid !== uid) {
      return res.status(403).json({ error: 'Only the reporting citizen can confirm or reopen this issue.' });
    }
    if (action !== 'confirm' && action !== 'reopen') {
      return res.status(400).json({ error: 'Action must be "confirm" or "reopen".' });
    }
    if (action === 'reopen' && (!disputeReason || disputeReason.trim().length < 5)) {
      return res.status(400).json({ error: 'Please explain why the issue remains unresolved (min 5 characters).' });
    }

    const nowIso = new Date().toISOString();
    const updated = updateOperationalReport(req.params.id, (prev) => {
      if (action === 'confirm') {
        const cleanRating = typeof rating === 'number' ? Math.max(1, Math.min(5, Math.round(rating))) : 5;
        return {
          ...prev,
          status: 'Verified Resolution',
          citizenConfirmedResolution: true,
          feedbackRating: cleanRating,
          feedbackComment: comment?.trim().slice(0, 500) || prev.feedbackComment,
          resolutionEvidence: prev.resolutionEvidence
            ? {
                ...prev.resolutionEvidence,
                approvalStatus: 'approved',
                approvedBy: prev.resolutionEvidence.approvedBy || prev.reporterDisplayName,
                approvedAt: prev.resolutionEvidence.approvedAt || nowIso,
              }
            : prev.resolutionEvidence,
          timeline: [
            ...prev.timeline,
            {
              step: 'verified_resolution',
              label: `Verified Resolution Confirmed by Citizen (${cleanRating}/5)`,
              actorRole: 'Citizen',
              note: comment?.trim() || undefined,
              timestamp: nowIso,
            },
          ],
          updatedAt: nowIso,
        };
      } else {
        const reasonText = disputeReason!.trim().slice(0, 600);
        return {
          ...prev,
          status: 'Reopened',
          citizenConfirmedResolution: false,
          reopenReason: reasonText,
          disputeHistory: [
            ...(prev.disputeHistory || []),
            {
              id: `dsp_${Date.now()}`,
              reason: reasonText,
              raisedBy: prev.reporterDisplayName,
              createdAt: nowIso,
            },
          ],
          timeline: [
            ...prev.timeline,
            {
              step: 'reopened',
              label: 'Issue Disputed & Reopened by Citizen',
              actorRole: 'Citizen',
              note: reasonText,
              timestamp: nowIso,
            },
          ],
          updatedAt: nowIso,
        };
      }
    });

    if (!updated) return res.status(404).json({ error: 'Update failed.' });

    pushNotification({
      targetType: updated.assignedOfficerUid ? 'officer' : 'authority',
      targetUid: updated.assignedOfficerUid,
      targetDepartment: updated.department,
      type: action === 'reopen' ? 'report_reopened' : 'report_confirmed',
      priority: action === 'reopen' ? 'high' : 'normal',
      title:
        action === 'reopen'
          ? `Report REOPENED (${updated.complaintId})`
          : `Verified Resolution (${updated.complaintId})`,
      message: action === 'reopen' ? `Citizen dispute: ${disputeReason}` : `Rated ${updated.feedbackRating}/5 by citizen.`,
      relatedType: 'report',
      relatedId: updated.id,
    });
    broadcast('authority:all', 'report:updated', updated);
    broadcast(`citizen:${updated.reporterUid}`, 'report:updated', updated);

    if (action === 'confirm') {
      await maybeDispatchComplaintSms(updated, 'resolution_completed', `Confirmed (${updated.feedbackRating}/5)`);
    } else {
      await maybeDispatchComplaintSms(updated, 'complaint_status_updated', `Reopened: ${disputeReason}`);
    }

    return res.json({ report: updated });
  });

  app.get('/api/heatmap', (req, res) => {
    const category = req.query.category ? String(req.query.category) : '';
    const severity = req.query.severity ? String(req.query.severity) : '';
    const ward = req.query.ward ? String(req.query.ward) : '';

    let incidents = getPublicHeatmapIncidents();
    if (category && category !== 'All') incidents = incidents.filter((i) => i.category === category);
    if (severity && severity !== 'All') incidents = incidents.filter((i) => i.severity === severity);
    if (ward && ward !== 'All') incidents = incidents.filter((i) => i.ward.toLowerCase().includes(ward.toLowerCase()));

    return res.json({
      updatedAt: new Date().toISOString(),
      minimumClusterThreshold: 1,
      incidents,
    });
  });

  // =========================================================================
  // 7. AUTHORITY REPORT OPERATIONS (GET, AI-VERIFY, VERIFY, PRIORITY, ASSIGN, MANAGE, APPROVE, ESCALATE, SLA CONFIG)
  // =========================================================================
  app.get('/api/authority/sla-config', (req, res) => {
    const session = getAuthoritySession(getBearerToken(req));
    if (!session) return res.status(401).json({ error: 'Authorized department session required.' });
    return res.json({ slaConfig: getSlaConfig() });
  });

  app.put('/api/authority/sla-config', (req, res) => {
    const session = getAuthoritySession(getBearerToken(req));
    if (!session) return res.status(401).json({ error: 'Authorized department session required.' });
    if (session.role !== 'admin') {
      return res.status(403).json({ error: 'Administrator privileges required to update SLA rules.' });
    }
    const { slaConfig, applyToOpenReports } = req.body as {
      slaConfig?: SlaConfig;
      applyToOpenReports?: boolean;
    };
    if (!slaConfig?.bySeverity) {
      return res.status(400).json({ error: 'Valid slaConfig.bySeverity payload is required.' });
    }
    const saved = updateSlaConfig(slaConfig);
    if (applyToOpenReports) {
      for (const r of getActiveReportsForSlaCheck()) {
        const nextDeadlines = computeSlaDeadlines(r.severity, r.isEmergency, r.createdAt, r.category);
        updateOperationalReport(r.id, (prev) => ({
          ...prev,
          slaDeadlineAt: nextDeadlines.slaDeadlineAt,
          slaResponseDeadlineAt: nextDeadlines.slaResponseDeadlineAt,
        }));
      }
    }
    addAuditLog({
      actorUid: session.uid,
      actorRole: session.role,
      department: session.department,
      action: 'sla_config_updated',
      targetId: 'sla_config',
      detail: `Updated SLA configuration${applyToOpenReports ? ' and recalculated active reports' : ''}.`,
    });
    return res.json({ slaConfig: saved });
  });

  app.get('/api/authority/reports', (req, res) => {
    const session = getAuthoritySession(getBearerToken(req));
    if (!session) {
      return res.status(401).json({ error: 'Authorized department session required.' });
    }

    const fraudQueue = (req.query.fraudQueue as 'operational' | 'fraud_review' | 'all') || 'all';
    const department = req.query.department
      ? String(req.query.department)
      : session.role === 'admin' ||
        session.role === 'supervisor' ||
        session.department === 'Emergency Control Room' ||
        session.department === 'All Departments'
      ? 'All Departments'
      : session.department;

    const rawReports = getOperationalReports({
      department,
      category: req.query.category ? String(req.query.category) : undefined,
      status: req.query.status ? String(req.query.status) : undefined,
      severity: req.query.severity ? String(req.query.severity) : undefined,
      verificationStatus: req.query.verificationStatus ? String(req.query.verificationStatus) : undefined,
      search: req.query.search ? String(req.query.search) : undefined,
      onlyOverdue: req.query.onlyOverdue === 'true',
      onlyReopened: req.query.onlyReopened === 'true',
      onlyEmergency: req.query.onlyEmergency === 'true',
      onlyEscalated: req.query.onlyEscalated === 'true',
      onlyUnassigned: req.query.onlyUnassigned === 'true',
      fraudQueue,
      includeSensitive: true,
    });

    const reports = rawReports.filter((r) => canSessionAccessReport(session, r));
    const scopedAll = getOperationalReports({ fraudQueue: 'all', includeSensitive: true }).filter((r) =>
      canSessionAccessReport(session, r)
    );
    const nowMs = Date.now();
    const sosEvents = getOperationalSosEvents();
    const medicalRequests = getMedicalRequests();

    return res.json({
      session: {
        uid: session.uid,
        name: session.name,
        department: session.department,
        jurisdiction: session.jurisdiction,
        designation: session.designation,
        role: session.role,
      },
      stats: {
        total: scopedAll.length,
        newReports: scopedAll.filter((r) => r.status === 'Submitted').length,
        pending: scopedAll.filter((r) => !CLOSED_REPORT_STATUSES.has(r.status)).length,
        verified: scopedAll.filter((r) => r.status === 'Verified' || r.verificationStatus === 'Verified').length,
        assigned: scopedAll.filter((r) => r.status === 'Assigned' || r.status === 'In Progress').length,
        inProgress: scopedAll.filter((r) => r.status === 'In Progress').length,
        unassigned: scopedAll.filter((r) => !r.assignedOfficer && !r.assignedOfficerUid && !CLOSED_REPORT_STATUSES.has(r.status)).length,
        awaitingReview: scopedAll.filter((r) => r.status === 'Resolved – Awaiting Verification').length,
        resolved: scopedAll.filter(
          (r) => r.status === 'Verified Resolution' || r.status === 'Resolved – Awaiting Verification'
        ).length,
        verifiedResolution: scopedAll.filter((r) => r.status === 'Verified Resolution').length,
        rejected: scopedAll.filter((r) => r.status === 'Rejected with reason').length,
        reopened: scopedAll.filter((r) => r.status === 'Reopened').length,
        escalated: scopedAll.filter((r) => r.status === 'Escalated' || (r.escalations && r.escalations.length > 0)).length,
        overdue: scopedAll.filter(
          (r) => !SLA_PAUSED_OR_CLOSED_STATUSES.has(r.status) && r.slaDeadlineAt && new Date(r.slaDeadlineAt).getTime() < nowMs
        ).length,
        highPriority: scopedAll.filter((r) => r.severity === 'High' || r.severity === 'Critical').length,
        activeSos: sosEvents.filter((s) => s.status === 'active' || s.status === 'acknowledged').length,
        activeMedical: medicalRequests.filter((m) => m.status !== 'Completed').length,
        underVerification: scopedAll.filter(
          (r) =>
            r.status === 'AI Verification Pending' ||
            r.verificationStatus === 'Pending Verification' ||
            r.verificationStatus === 'Flagged for Manual Review' ||
            r.fraudQueueStatus === 'restricted_queue' ||
            r.fraudQueueStatus === 'investigation_queue'
        ).length,
      },
      slaConfig: getSlaConfig(),
      reports,
      sosEvents,
      medicalRequests,
      officers: getOfficers('All Departments'),
      smsLogs: getSmsLogs().slice(0, 100),
      auditLogs: session.role === 'admin' || session.role === 'supervisor' ? getAuditLogs().slice(0, 120) : getAuditLogs().slice(0, 40),
    });
  });

  app.post('/api/authority/reports/:id/ai-verify', async (req, res) => {
    const session = getAuthoritySession(getBearerToken(req));
    if (!session) return res.status(401).json({ error: 'Authorized department session required.' });

    const target = getOperationalReportById(req.params.id);
    if (!target) return res.status(404).json({ error: 'Report not found.' });
    if (!canSessionAccessReport(session, target)) {
      return res.status(403).json({ error: 'Access denied: Report belongs to another department or officer.' });
    }

    let photoBase64: string | undefined;
    let photoMimeType: string | undefined;
    if (target.photoDataUrl && target.photoDataUrl.startsWith('data:image/')) {
      const m = target.photoDataUrl.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/);
      if (m) {
        photoMimeType = m[1];
        photoBase64 = m[2];
      }
    }

    const nowIso = new Date().toISOString();
    try {
      const aiResult = await analyzeCivicReport({
        category: target.category,
        title: target.title,
        description: target.description,
        severity: target.severity,
        address: target.address,
        lat: target.lat,
        lng: target.lng,
        photoBase64,
        photoMimeType,
        recentReportsContext: getRecentReportsForContext().filter((r) => r.id !== target.complaintId),
        currentImageHash: target.imageHash,
      });

      const updated = updateOperationalReport(target.id, (prev) => ({
        ...prev,
        aiSummary: aiResult.summary,
        aiSuggestedCategory: aiResult.suggestedCategory,
        aiDetectedCategory: aiResult.aiDetectedCategory,
        aiSuggestedSeverity: aiResult.suggestedSeverity,
        aiConfidence: aiResult.confidence,
        aiDuplicateCheck: aiResult.duplicateCheckResult,
        aiMissingInfoFlags: aiResult.missingInfoFlags,
        aiRecommendedAction: aiResult.recommendedAction,
        aiVerificationError: undefined,
        aiVerifiedAt: nowIso,
        imageMatchesDescription: aiResult.imageMatchesDescription,
        detectedIssueFromImage: aiResult.detectedIssueFromImage,
        fraudRiskScore: aiResult.fraudRiskScore,
        fraudProbability: aiResult.fraudProbability,
        fraudRiskLevel: aiResult.fraudRiskLevel,
        fraudIndicators: aiResult.fraudIndicators || [],
        fraudExplanation: aiResult.fraudExplanation,
        evidenceCompleteness: aiResult.evidenceCompleteness,
        recommendedActionText: aiResult.recommendedActionText,
        updatedAt: nowIso,
      }));

      broadcast('authority:all', 'report:updated', updated);
      return res.json({ report: updated, aiResult });
    } catch (err: any) {
      const updated = updateOperationalReport(target.id, (prev) => ({
        ...prev,
        aiVerificationError: err?.message || 'AI analysis service unavailable.',
        updatedAt: nowIso,
      }));
      return res.status(502).json({
        error: err?.message || 'AI Verification service unavailable.',
        report: updated,
      });
    }
  });

  app.post('/api/authority/reports/:id/verify', async (req, res) => {
    const session = getAuthoritySession(getBearerToken(req));
    if (!session) return res.status(401).json({ error: 'Authorized department session required.' });

    const { decision, notes, requestEvidenceNote, overrideCategory, overrideSeverity } = req.body as {
      decision?: 'verify' | 'flag' | 'reject' | 'request_evidence';
      notes?: string;
      requestEvidenceNote?: string;
      overrideCategory?: string;
      overrideSeverity?: 'Low' | 'Medium' | 'High' | 'Critical';
    };

    const target = getOperationalReportById(req.params.id);
    if (!target) return res.status(404).json({ error: 'Report not found.' });
    if (!canSessionAccessReport(session, target)) {
      return res.status(403).json({ error: 'Access denied: Report belongs to another department or officer.' });
    }
    if (!decision) return res.status(400).json({ error: 'Verification decision required.' });
    if (decision === 'reject' && (!notes || notes.trim().length < 5)) {
      return res.status(400).json({ error: 'Please provide a clear rejection reason (minimum 5 characters).' });
    }
    if (decision === 'request_evidence' && (!requestEvidenceNote || requestEvidenceNote.trim().length < 5)) {
      return res.status(400).json({ error: 'Please specify what additional evidence is needed from the citizen.' });
    }

    const nowIso = new Date().toISOString();
    const updated = updateOperationalReport(req.params.id, (prev) => {
      const nextCategory = overrideCategory?.trim() || prev.category;
      const nextSeverity = overrideSeverity || prev.severity;
      const nextDept = overrideCategory?.trim()
        ? DEPARTMENT_BY_CATEGORY[nextCategory] || prev.department
        : prev.department;
      const nextSla =
        overrideCategory || overrideSeverity
          ? computeSlaDeadlines(nextSeverity, nextSeverity === 'Critical' || prev.isEmergency, prev.createdAt, nextCategory)
          : { slaDeadlineAt: prev.slaDeadlineAt, slaResponseDeadlineAt: prev.slaResponseDeadlineAt };

      if (decision === 'verify') {
        return {
          ...prev,
          category: nextCategory,
          severity: nextSeverity,
          department: nextDept,
          slaDeadlineAt: nextSla.slaDeadlineAt,
          slaResponseDeadlineAt: nextSla.slaResponseDeadlineAt,
          verificationStatus: 'Verified',
          fraudQueueStatus: 'cleared',
          status:
            prev.status === 'Submitted' || prev.status === 'AI Verification Pending' ? 'Verified' : prev.status,
          verificationNotes: notes?.trim() || prev.verificationNotes,
          verifiedBy: session.name,
          verifiedAt: nowIso,
          timeline: [
            ...prev.timeline,
            {
              step: 'verified',
              label: 'Verified by Authority',
              actorRole: `${session.department} (${session.name})`,
              note: notes?.trim() || 'Cleared for operational assignment',
              timestamp: nowIso,
            },
          ],
          updatedAt: nowIso,
        };
      }
      if (decision === 'flag') {
        return {
          ...prev,
          category: nextCategory,
          severity: nextSeverity,
          department: nextDept,
          verificationStatus: 'Flagged for Manual Review',
          fraudQueueStatus: 'investigation_queue',
          status: 'AI Verification Pending',
          verificationNotes: notes?.trim() || prev.verificationNotes,
          timeline: [
            ...prev.timeline,
            {
              step: 'flagged_manual_review',
              label: 'Flagged for Manual Verification',
              actorRole: `${session.department} (${session.name})`,
              note: notes?.trim() || 'Requires secondary verification before dispatch',
              timestamp: nowIso,
            },
          ],
          updatedAt: nowIso,
        };
      }
      if (decision === 'request_evidence') {
        return {
          ...prev,
          status: 'AI Verification Pending',
          additionalEvidenceRequested: true,
          additionalEvidenceRequestNote: requestEvidenceNote!.trim().slice(0, 500),
          verificationNotes: notes?.trim() || prev.verificationNotes,
          timeline: [
            ...prev.timeline,
            {
              step: 'awaiting_evidence',
              label: 'Additional Evidence Requested from Citizen',
              actorRole: `${session.department} (${session.name})`,
              note: requestEvidenceNote!.trim(),
              timestamp: nowIso,
            },
          ],
          updatedAt: nowIso,
        };
      }
      return {
        ...prev,
        verificationStatus: 'Rejected',
        fraudQueueStatus: 'rejected',
        status: 'Rejected with reason',
        verificationNotes: notes!.trim(),
        actionNotes: notes!.trim(),
        verifiedBy: session.name,
        verifiedAt: nowIso,
        timeline: [
          ...prev.timeline,
          {
            step: 'rejected_with_reason',
            label: 'Rejected with reason',
            actorRole: `${session.department} (${session.name})`,
            note: notes!.trim(),
            timestamp: nowIso,
          },
        ],
        updatedAt: nowIso,
      };
    });

    if (!updated) return res.status(404).json({ error: 'Verification update failed.' });

    addAuditLog({
      actorUid: session.uid,
      actorRole: session.role,
      department: session.department,
      action: `report_verify:${decision}`,
      targetId: updated.complaintId,
      detail: notes || requestEvidenceNote || `Verification action: ${decision}`,
    });

    pushNotification({
      targetType: 'citizen',
      targetUid: updated.reporterUid,
      type: `verification_${decision}`,
      priority: decision === 'request_evidence' || decision === 'reject' ? 'high' : 'normal',
      title:
        decision === 'verify'
          ? `Report ${updated.complaintId} Verified`
          : decision === 'request_evidence'
          ? `Action Required: Evidence Requested (${updated.complaintId})`
          : decision === 'reject'
          ? `Report ${updated.complaintId} Rejected with reason`
          : `Report ${updated.complaintId} Under Manual Verification`,
      message: notes || requestEvidenceNote || `Status is now ${updated.status}.`,
      relatedType: 'report',
      relatedId: updated.id,
    });

    broadcast(`citizen:${updated.reporterUid}`, 'report:updated', updated);
    broadcast('authority:all', 'report:updated', updated);
    await maybeDispatchComplaintSms(updated, 'complaint_status_updated', notes || requestEvidenceNote);

    return res.json({ report: updated });
  });

  app.patch('/api/authority/reports/:id/priority', (req, res) => {
    const session = getAuthoritySession(getBearerToken(req));
    if (!session) return res.status(401).json({ error: 'Authorized department session required.' });

    const { severity, reason } = req.body as {
      severity?: 'Low' | 'Medium' | 'High' | 'Critical';
      reason?: string;
    };
    if (!severity || !['Low', 'Medium', 'High', 'Critical'].includes(severity)) {
      return res.status(400).json({ error: 'Valid severity (Low, Medium, High, Critical) required.' });
    }

    const target = getOperationalReportById(req.params.id);
    if (!target) return res.status(404).json({ error: 'Report not found.' });
    if (!canSessionAccessReport(session, target)) {
      return res.status(403).json({ error: 'Access denied: Report belongs to another department or officer.' });
    }

    const nowIso = new Date().toISOString();
    const updated = updateOperationalReport(req.params.id, (prev) => {
      const nextSla = computeSlaDeadlines(severity, severity === 'Critical' || prev.isEmergency, prev.createdAt, prev.category);
      return {
        ...prev,
        severity,
        isEmergency: severity === 'Critical' ? true : prev.isEmergency,
        slaDeadlineAt: nextSla.slaDeadlineAt,
        slaResponseDeadlineAt: nextSla.slaResponseDeadlineAt,
        timeline: [
          ...prev.timeline,
          {
            step: 'priority_changed',
            label: `Priority updated to ${severity}`,
            actorRole: `${session.department} (${session.name})`,
            note: reason?.trim() || undefined,
            timestamp: nowIso,
          },
        ],
        updatedAt: nowIso,
      };
    });

    if (!updated) return res.status(404).json({ error: 'Priority update failed.' });

    addAuditLog({
      actorUid: session.uid,
      actorRole: session.role,
      department: session.department,
      action: 'report_priority_changed',
      targetId: updated.complaintId,
      detail: `Priority set to ${severity}${reason ? ` — ${reason}` : ''}.`,
    });
    broadcast('authority:all', 'report:updated', updated);
    broadcast(`citizen:${updated.reporterUid}`, 'report:updated', updated);
    return res.json({ report: updated });
  });

  app.post('/api/authority/reports/:id/assign', async (req, res) => {
    const session = getAuthoritySession(getBearerToken(req));
    if (!session) return res.status(401).json({ error: 'Authorized department session required.' });

    const { officerUid, officerName, department, reason } = req.body as {
      officerUid?: string;
      officerName?: string;
      department?: string;
      reason?: string;
    };

    const target = getOperationalReportById(req.params.id);
    if (!target) return res.status(404).json({ error: 'Report not found.' });
    if (!canSessionAccessReport(session, target)) {
      return res.status(403).json({ error: 'Access denied: Cannot assign a report outside your authorized scope.' });
    }
    if (
      session.role === 'authority' &&
      target.assignedOfficerUid &&
      target.assignedOfficerUid !== session.uid
    ) {
      return res.status(403).json({ error: 'Field officers cannot reassign reports already assigned to another officer.' });
    }

    const roster = getOfficers('All Departments');
    const matchedOfficer = officerUid
      ? roster.find((o) => o.uid === officerUid)
      : officerName
      ? roster.find((o) => o.name.toLowerCase() === officerName.trim().toLowerCase())
      : undefined;

    const finalOfficerName = matchedOfficer?.name || officerName?.trim() || session.name;
    const finalOfficerUid = matchedOfficer?.uid || officerUid || (finalOfficerName === session.name ? session.uid : undefined);
    const finalDept = department?.trim() || matchedOfficer?.department || target.department;
    if (
      target.assignedOfficer &&
      target.assignedOfficer.toLowerCase() === finalOfficerName.toLowerCase() &&
      target.department === finalDept
    ) {
      return res.status(409).json({
        error: `Duplicate Assignment Blocked: Report ${target.complaintId} is already assigned to ${finalOfficerName} (${finalDept}).`,
      });
    }
    const isReassignment = Boolean(target.assignedOfficer && target.assignedOfficer !== finalOfficerName);

    if (isReassignment && (!reason || reason.trim().length < 3)) {
      return res.status(400).json({ error: 'Please provide a reason when reassigning an officer or department.' });
    }

    const nowIso = new Date().toISOString();
    const updated = updateOperationalReport(req.params.id, (prev) => {
      const assignmentEntry = {
        id: `asgn_${Date.now()}`,
        fromOfficer: prev.assignedOfficer,
        toOfficer: finalOfficerName,
        toOfficerUid: finalOfficerUid,
        toDepartment: finalDept,
        assignedBy: session.name,
        assignedByRole: session.role,
        reason: reason?.trim() || undefined,
        assignedAt: nowIso,
      };
      const canTransitionToAssigned =
        prev.status === 'Submitted' ||
        prev.status === 'AI Verification Pending' ||
        prev.status === 'Verified' ||
        prev.status === 'Reopened' ||
        prev.status === 'Escalated';
      return {
        ...prev,
        department: finalDept,
        assignedOfficer: finalOfficerName,
        assignedOfficerUid: finalOfficerUid,
        status: canTransitionToAssigned ? 'Assigned' : prev.status,
        assignmentHistory: [...(prev.assignmentHistory || []), assignmentEntry],
        timeline: [
          ...prev.timeline,
          {
            step: isReassignment ? 'reassigned' : 'assigned',
            label: isReassignment ? `Reassigned to ${finalOfficerName} (${finalDept})` : `Assigned to ${finalOfficerName}`,
            actorRole: `${session.department} (${session.name})`,
            note: reason?.trim() || undefined,
            timestamp: nowIso,
          },
        ],
        updatedAt: nowIso,
      };
    });

    if (!updated) return res.status(404).json({ error: 'Assignment failed.' });

    addAuditLog({
      actorUid: session.uid,
      actorRole: session.role,
      department: session.department,
      action: isReassignment ? 'report_reassigned' : 'report_assigned',
      targetId: updated.complaintId,
      detail: `Assigned to ${finalOfficerName} (${finalDept})${reason ? ` — Reason: ${reason}` : ''}`,
    });

    if (finalOfficerUid) {
      pushNotification({
        targetType: 'officer',
        targetUid: finalOfficerUid,
        targetDepartment: finalDept,
        type: 'officer_assigned',
        priority: updated.isEmergency ? 'emergency' : 'high',
        title: `New Assignment: ${updated.complaintId}`,
        message: `${updated.title} (${updated.category}) assigned by ${session.name}.`,
        relatedType: 'report',
        relatedId: updated.id,
      });
    }

    pushNotification({
      targetType: 'citizen',
      targetUid: updated.reporterUid,
      type: 'report_assigned',
      priority: 'normal',
      title: `Officer Assigned (${updated.complaintId})`,
      message: `${updated.department} officer ${finalOfficerName} is now handling your report.`,
      relatedType: 'report',
      relatedId: updated.id,
    });

    broadcast(`citizen:${updated.reporterUid}`, 'report:updated', updated);
    broadcast('authority:all', 'report:updated', updated);
    await maybeDispatchComplaintSms(updated, 'complaint_status_updated', `Assigned to ${finalOfficerName}`);

    return res.json({ report: updated, officers: getOfficers('All Departments') });
  });

  app.post('/api/authority/reports/:id/manage', async (req, res) => {
    const session = getAuthoritySession(getBearerToken(req));
    if (!session) {
      return res.status(401).json({ error: 'Authorized department session required.' });
    }

    const {
      status,
      assignedOfficer,
      actionNotes,
      resolutionNotes,
      fraudDecision,
      beforePhotos,
      afterPhotos,
      extraPhotos,
      resolutionDescription,
      submitForApproval,
    } = req.body as {
      status?: OperationalReportStatus;
      assignedOfficer?: string;
      actionNotes?: string;
      resolutionNotes?: string;
      fraudDecision?: 'cleared' | 'rejected' | 'investigation_queue';
      beforePhotos?: UploadedFileRef[];
      afterPhotos?: UploadedFileRef[];
      extraPhotos?: UploadedFileRef[];
      resolutionDescription?: string;
      submitForApproval?: boolean;
    };

    const target = getOperationalReportById(req.params.id);
    if (!target) {
      return res.status(404).json({ error: 'Report not found in operational registry.' });
    }
    if (!canSessionAccessReport(session, target)) {
      return res.status(403).json({ error: 'Access denied: Report belongs to another department or officer.' });
    }

    const mergedBefore = beforePhotos || target.resolutionEvidence?.beforePhotos || [];
    const mergedAfter = afterPhotos || target.resolutionEvidence?.afterPhotos || [];
    const mergedExtra = extraPhotos || target.resolutionEvidence?.extraPhotos || [];
    const mergedNotes = (resolutionNotes || actionNotes || target.resolutionEvidence?.completionNotes || '').trim();
    const mergedDesc = (resolutionDescription || target.resolutionEvidence?.description || mergedNotes).trim();

    const isSubmittingResolution =
      status === 'Resolved – Awaiting Verification' || status === 'Verified Resolution' || submitForApproval;

    if (isSubmittingResolution) {
      if (mergedAfter.length === 0) {
        return res.status(400).json({
          error: 'Resolution Evidence Required: Upload at least 1 After-Work / Resolution proof photo before marking resolved.',
        });
      }
      if (mergedNotes.length < 5) {
        return res.status(400).json({
          error: 'Completion notes (minimum 5 characters) are required along with resolution photos.',
        });
      }
    }

    if (status === 'Rejected with reason' && mergedNotes.length < 5) {
      return res.status(400).json({ error: 'A rejection reason (minimum 5 characters) is required.' });
    }

    let effectiveStatus: OperationalReportStatus = status || target.status;
    if (submitForApproval || (effectiveStatus === 'Verified Resolution' && session.role === 'authority')) {
      effectiveStatus = 'Resolved – Awaiting Verification';
    }

    const nowIso = new Date().toISOString();
    const updated = updateOperationalReport(req.params.id, (prev) => {
      const nextFraud = fraudDecision || prev.fraudQueueStatus;
      const nextTimeline = [...prev.timeline];

      if (effectiveStatus !== prev.status) {
        nextTimeline.push({
          step: effectiveStatus.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
          label:
            effectiveStatus === 'Resolved – Awaiting Verification'
              ? 'Resolution Proof Uploaded (Resolved – Awaiting Verification)'
              : effectiveStatus,
          actorRole: `${session.department} (${session.name})`,
          note: mergedNotes || undefined,
          timestamp: nowIso,
        });
      }
      if (fraudDecision && fraudDecision !== prev.fraudQueueStatus) {
        nextTimeline.push({
          step: `fraud_${fraudDecision}`,
          label:
            fraudDecision === 'cleared'
              ? 'Seva Trust Review Cleared'
              : fraudDecision === 'rejected'
              ? 'Rejected with reason'
              : 'Flagged for Manual Verification',
          actorRole: `Verification (${session.name})`,
          note: actionNotes || undefined,
          timestamp: nowIso,
        });
      }

      const hasResEvidence = mergedBefore.length > 0 || mergedAfter.length > 0 || mergedExtra.length > 0;
      const nextResolutionEvidence = hasResEvidence
        ? {
            beforePhotos: mergedBefore,
            afterPhotos: mergedAfter,
            extraPhotos: mergedExtra,
            description: mergedDesc,
            completionNotes: mergedNotes,
            completedAt: nowIso,
            resolvingOfficer: session.name,
            resolvingOfficerUid: session.uid,
            approvalStatus:
              effectiveStatus === 'Verified Resolution'
                ? ('approved' as const)
                : ('pending_review' as const),
            ...(effectiveStatus === 'Verified Resolution'
              ? { approvedBy: session.name, approvedAt: nowIso }
              : {}),
          }
        : prev.resolutionEvidence;

      return {
        ...prev,
        status: fraudDecision === 'rejected' ? 'Rejected with reason' : effectiveStatus,
        assignedOfficer: assignedOfficer ?? prev.assignedOfficer ?? session.name,
        assignedOfficerUid: prev.assignedOfficerUid || session.uid,
        actionNotes: actionNotes ?? prev.actionNotes,
        resolutionNotes:
          effectiveStatus === 'Resolved – Awaiting Verification' || effectiveStatus === 'Verified Resolution'
            ? mergedNotes
            : prev.resolutionNotes,
        resolutionEvidence: nextResolutionEvidence,
        fraudQueueStatus: nextFraud,
        verificationStatus:
          fraudDecision === 'cleared'
            ? 'Verified'
            : fraudDecision === 'rejected'
            ? 'Rejected'
            : fraudDecision === 'investigation_queue'
            ? 'Flagged for Manual Review'
            : prev.verificationStatus,
        timeline: nextTimeline,
        updatedAt: nowIso,
      };
    });

    if (!updated) {
      return res.status(404).json({ error: 'Update failed.' });
    }

    addAuditLog({
      actorUid: session.uid,
      actorRole: session.role,
      department: session.department,
      action: fraudDecision ? `fraud_review:${fraudDecision}` : `report_status:${updated.status}`,
      targetId: updated.complaintId,
      detail: mergedNotes || `Updated ${updated.complaintId} to ${updated.status}.`,
    });

    pushNotification({
      targetType: 'citizen',
      targetUid: updated.reporterUid,
      type: `report_${updated.status.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
      priority:
        updated.status === 'Resolved – Awaiting Verification' || updated.status === 'Verified Resolution'
          ? 'high'
          : 'normal',
      title: `Update on ${updated.complaintId}: ${updated.status}`,
      message: mergedNotes || `Department ${updated.department} updated status to ${updated.status}.`,
      relatedType: 'report',
      relatedId: updated.id,
    });

    if (updated.status === 'Resolved – Awaiting Verification') {
      pushNotification({
        targetType: 'supervisor',
        targetDepartment: updated.department,
        type: 'resolution_review_needed',
        priority: 'high',
        title: `Resolution Verification Needed (${updated.complaintId})`,
        message: `${session.name} uploaded resolution proof photos awaiting Citizen/Supervisor verification.`,
        relatedType: 'report',
        relatedId: updated.id,
      });
    }

    broadcast(`citizen:${updated.reporterUid}`, 'report:updated', updated);
    broadcast('authority:all', 'report:updated', updated);

    if (updated.status === 'Resolved – Awaiting Verification' || updated.status === 'Verified Resolution') {
      await maybeDispatchComplaintSms(updated, 'resolution_completed', mergedNotes);
    } else {
      await maybeDispatchComplaintSms(updated, 'complaint_status_updated', mergedNotes);
    }

    return res.json({ report: updated });
  });

  app.post('/api/authority/reports/:id/approve-resolution', async (req, res) => {
    const session = getAuthoritySession(getBearerToken(req));
    if (!session) return res.status(401).json({ error: 'Authorized department session required.' });
    if (session.role !== 'supervisor' && session.role !== 'admin') {
      return res.status(403).json({
        error: 'Department Supervisor or Administrator authority required for final resolution approval.',
      });
    }

    const { decision, approvalNotes } = req.body as {
      decision?: 'approve' | 'request_rework';
      approvalNotes?: string;
    };

    const target = getOperationalReportById(req.params.id);
    if (!target) return res.status(404).json({ error: 'Report not found.' });
    if (!canSessionAccessReport(session, target)) {
      return res.status(403).json({ error: 'Access denied: Report belongs to another department.' });
    }
    if (!target.resolutionEvidence || target.resolutionEvidence.afterPhotos.length === 0) {
      return res.status(400).json({ error: 'Cannot approve resolution without resolution proof photos.' });
    }

    const nowIso = new Date().toISOString();
    const updated = updateOperationalReport(req.params.id, (prev) => {
      const approved = decision !== 'request_rework';
      return {
        ...prev,
        status: approved ? 'Verified Resolution' : 'In Progress',
        resolutionEvidence: {
          ...prev.resolutionEvidence!,
          approvalStatus: approved ? 'approved' : 'changes_requested',
          approvedBy: session.name,
          approvedAt: nowIso,
          approvalNotes: approvalNotes?.trim() || undefined,
        },
        timeline: [
          ...prev.timeline,
          {
            step: approved ? 'verified_resolution' : 'rework_requested',
            label: approved ? 'Verified Resolution Approved by Supervisor' : 'Supervisor Requested Rework',
            actorRole: `${session.role.toUpperCase()} (${session.name})`,
            note: approvalNotes?.trim() || undefined,
            timestamp: nowIso,
          },
        ],
        updatedAt: nowIso,
      };
    });

    if (!updated) return res.status(404).json({ error: 'Approval failed.' });

    addAuditLog({
      actorUid: session.uid,
      actorRole: session.role,
      department: session.department,
      action: decision === 'request_rework' ? 'resolution_rework_requested' : 'resolution_approved',
      targetId: updated.complaintId,
      detail:
        approvalNotes ||
        `Supervisor ${session.name} ${decision === 'request_rework' ? 'returned for rework' : 'approved Verified Resolution'}.`,
    });

    pushNotification({
      targetType: 'citizen',
      targetUid: updated.reporterUid,
      type: decision === 'request_rework' ? 'rework_requested' : 'report_resolved',
      priority: 'high',
      title:
        decision === 'request_rework'
          ? `Quality Check Rework Initiated (${updated.complaintId})`
          : `Verified Resolution (${updated.complaintId})`,
      message:
        decision === 'request_rework'
          ? 'Supervisor requested additional field rework to ensure quality.'
          : 'Resolution proof approved. Inspect photos and rate the resolution in My Reports.',
      relatedType: 'report',
      relatedId: updated.id,
    });

    broadcast(`citizen:${updated.reporterUid}`, 'report:updated', updated);
    broadcast('authority:all', 'report:updated', updated);
    await maybeDispatchComplaintSms(updated, decision === 'request_rework' ? 'complaint_status_updated' : 'resolution_completed', approvalNotes);

    return res.json({ report: updated });
  });

  app.post('/api/authority/reports/:id/escalate', (req, res) => {
    const session = getAuthoritySession(getBearerToken(req));
    if (!session) return res.status(401).json({ error: 'Authorized department session required.' });
    const target = getOperationalReportById(req.params.id);
    if (!target) return res.status(404).json({ error: 'Report not found.' });
    if (!canSessionAccessReport(session, target)) {
      return res.status(403).json({ error: 'Access denied: Report belongs to another department or officer.' });
    }
    const { level, reason } = req.body as { level?: 1 | 2 | 3; reason?: string };
    const escLevel: 1 | 2 | 3 = level === 3 ? 3 : level === 2 ? 2 : 1;
    if (!reason || reason.trim().length < 5) {
      return res.status(400).json({ error: 'Escalation reason (minimum 5 characters) is required.' });
    }
    const targetRole =
      escLevel === 3
        ? 'Platform Administrator / Senior Authority'
        : escLevel === 2
        ? 'Department Supervisor'
        : 'Assigned Officer / Duty Lead';

    const nowIso = new Date().toISOString();
    const updated = updateOperationalReport(req.params.id, (prev) => ({
      ...prev,
      status: 'Escalated',
      escalationLevel: Math.max(prev.escalationLevel || 0, escLevel) as 1 | 2 | 3,
      escalations: [
        ...(prev.escalations || []),
        {
          id: `esc_${Date.now()}`,
          level: escLevel,
          targetRole,
          reason: reason.trim().slice(0, 500),
          escalatedBy: session.name,
          status: 'open',
          createdAt: nowIso,
        },
      ],
      timeline: [
        ...prev.timeline,
        {
          step: `escalated_l${escLevel}`,
          label: `Escalated (Level ${escLevel}: ${targetRole})`,
          actorRole: `${session.department} (${session.name})`,
          note: reason.trim(),
          timestamp: nowIso,
        },
      ],
      updatedAt: nowIso,
    }));

    if (!updated) return res.status(404).json({ error: 'Report not found.' });

    addAuditLog({
      actorUid: session.uid,
      actorRole: session.role,
      department: session.department,
      action: `escalation_level_${escLevel}`,
      targetId: updated.complaintId,
      detail: `${targetRole}: ${reason.trim()}`,
    });

    pushNotification({
      targetType: 'supervisor',
      targetDepartment: updated.department,
      type: 'report_escalated',
      priority: 'emergency',
      title: `Level ${escLevel} Escalation: ${updated.complaintId}`,
      message: `Escalated to ${targetRole}: ${reason.trim()}`,
      relatedType: 'escalation',
      relatedId: updated.id,
    });

    broadcast('authority:all', 'report:updated', updated);
    broadcast(`citizen:${updated.reporterUid}`, 'report:updated', updated);
    return res.json({ report: updated });
  });

  // =========================================================================
  // 8. CAREGIVERS, DIRECT CALL LOGGING, SOS, MEDICAL ASSISTANCE & SMS GATEWAY
  // =========================================================================
  app.get('/api/caregivers/:uid', (req, res) => {
    if (rejectIfAuthorityToken(req, res)) return;
    return res.json({ caregivers: getCaregiversByUid(req.params.uid) });
  });

  app.post('/api/caregivers', async (req, res) => {
    if (rejectIfAuthorityToken(req, res)) return;
    const { uid, citizenName, name, phone, relation, consentGiven } = req.body as {
      uid?: string;
      citizenName?: string;
      name?: string;
      phone?: string;
      relation?: string;
      consentGiven?: boolean;
    };

    if (!uid || !name?.trim() || !phone?.trim()) {
      return res.status(400).json({ error: 'User ID, caregiver name, and phone number are required.' });
    }
    if (!consentGiven) {
      return res.status(400).json({ error: 'Caregiver SMS notification consent is required.' });
    }
    const normalizedPhone = normalizePhoneE164(phone.trim());
    if (!normalizedPhone) {
      return res.status(400).json({
        error: 'Invalid phone number. Enter a valid 10-digit Indian mobile or E.164 international number (e.g. +919876543210).',
      });
    }

    const existingList = getCaregiversByUid(uid);
    if (existingList.some((c) => c.phone === normalizedPhone)) {
      return res.status(409).json({
        error: `This phone number (${normalizedPhone}) is already saved as a caregiver contact.`,
      });
    }
    if (existingList.length >= 5) {
      return res.status(400).json({ error: 'Maximum 5 emergency caregiver contacts allowed.' });
    }

    const nowIso = new Date().toISOString();
    const record = {
      id: `cg_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      uid,
      name: name.trim().slice(0, 100),
      phone: normalizedPhone,
      relation: (relation || 'Family').trim().slice(0, 40),
      consentGiven: true,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    const { record: saved } = upsertCaregiver(record);

    const smsRes = await dispatchCaregiverSmsAlerts({
      emergencyId: saved.id,
      emergencyType: 'caregiver_added',
      citizenName: citizenName || 'SEVA Citizen',
      messageBody: `SEVA AI Caregiver Notice: ${citizenName || 'A SEVA AI user'} added you (${saved.name}) as a trusted emergency caregiver contact.`,
      recipients: [{ name: saved.name, phone: saved.phone }],
    });

    return res.json({
      caregiver: saved,
      caregivers: getCaregiversByUid(uid),
      smsDispatch: smsRes,
    });
  });

  app.delete('/api/caregivers/:uid/:id', (req, res) => {
    if (rejectIfAuthorityToken(req, res)) return;
    const removed = deleteCaregiver(req.params.uid, req.params.id);
    if (!removed) return res.status(404).json({ error: 'Caregiver contact not found.' });
    return res.json({ deleted: true, caregivers: getCaregiversByUid(req.params.uid) });
  });

  app.post('/api/calls/log', (req, res) => {
    if (rejectIfAuthorityToken(req, res)) return;
    const { uid, caregiverId, caregiverName, caregiverPhone, source } = req.body as {
      uid?: string;
      caregiverId?: string;
      caregiverName?: string;
      caregiverPhone?: string;
      source?: 'seva_shield' | 'medical_assistance' | 'emergency_helpline';
    };
    if (!uid || !caregiverPhone?.trim()) {
      return res.status(400).json({ error: 'User ID and phone number are required to log a call attempt.' });
    }
    const normalized = normalizePhoneE164(caregiverPhone.trim()) || (/^(100|102|108|112|1091|1098)$/.test(caregiverPhone.trim()) ? caregiverPhone.trim() : null);
    const entry = addCallLog({
      uid,
      caregiverId,
      caregiverName: (caregiverName || 'Caregiver').slice(0, 80),
      caregiverPhone: normalized || caregiverPhone.trim().slice(0, 20),
      source: source || 'seva_shield',
      status: normalized ? 'dialer_opened' : 'invalid_phone',
    });
    if (!normalized) {
      return res.status(400).json({
        error: 'Caregiver phone number is missing or invalid E.164 format. Update contact before calling.',
        callLog: entry,
      });
    }
    return res.json({ callLog: entry, telUri: `tel:${normalized}` });
  });

  app.get('/api/calls/:uid', (req, res) => {
    if (rejectIfAuthorityToken(req, res)) return;
    return res.json({ calls: getCallLogsByUid(req.params.uid).slice(0, 50) });
  });

  app.post('/api/authority/safety-alert', async (req, res) => {
    const session = getAuthoritySession(getBearerToken(req));
    if (!session) return res.status(401).json({ error: 'Authorized department session required.' });
    const { citizenUid, citizenName, alertMessage, relatedId } = req.body as {
      citizenUid?: string;
      citizenName?: string;
      alertMessage?: string;
      relatedId?: string;
    };
    if (!citizenUid || !alertMessage?.trim()) {
      return res.status(400).json({ error: 'Citizen UID and alert message are required.' });
    }
    const caregivers = getCaregiversByUid(citizenUid);
    const smsRes = await dispatchCaregiverSmsAlerts({
      emergencyId: relatedId || `alert_${Date.now()}`,
      emergencyType: 'safety_alert',
      citizenName: citizenName || 'SEVA Citizen',
      messageBody: `SEVA SAFETY ALERT (${session.department}): ${alertMessage.trim().slice(0, 280)}`,
      recipients: caregivers.map((c) => ({ name: c.name, phone: c.phone })),
    });
    addAuditLog({
      actorUid: session.uid,
      actorRole: session.role,
      department: session.department,
      action: 'safety_alert_sms',
      targetId: relatedId || citizenUid,
      detail: smsRes.summaryText,
    });
    return res.json({ smsDispatch: smsRes });
  });

  app.post('/api/sos/sync', async (req, res) => {
    if (rejectIfAuthorityToken(req, res)) return;
    const sos = req.body;
    if (!sos?.id || !sos?.uid) {
      return res.status(400).json({ error: 'Invalid SOS payload.' });
    }

    const recipientsFromReq: CaregiverRecipient[] = Array.isArray(sos.contacts) ? sos.contacts : [];
    const recipients =
      recipientsFromReq.length > 0
        ? recipientsFromReq
        : getCaregiversByUid(sos.uid).map((c) => ({ name: c.name, phone: c.phone }));

    let smsSummaryText = sos.smsSummary || '';
    let smsLogs = sos.smsLogs;

    if (sos.status === 'active' && recipients.length > 0 && !sos.skipSms) {
      const mapsUrl = `https://www.openstreetmap.org/?mlat=${sos.lat}&mlon=${sos.lng}#map=16/${sos.lat}/${sos.lng}`;
      const smsMsg = `SEVA SHIELD SOS ALERT: ${sos.displayName || 'Citizen'} triggered an emergency SOS at ${
        sos.address || `${sos.lat}, ${sos.lng}`
      }. Live Map: ${mapsUrl}`;
      const smsRes = await dispatchCaregiverSmsAlerts({
        emergencyId: sos.id,
        emergencyType: 'sos_activated',
        citizenName: sos.displayName || 'Citizen',
        messageBody: smsMsg,
        recipients,
      });
      smsSummaryText = smsRes.summaryText;
      smsLogs = smsRes.logs;
    }

    const saved = upsertOperationalSos({
      id: sos.id,
      uid: sos.uid,
      displayName: sos.displayName || 'Citizen',
      status: sos.status || 'active',
      lat: Number(sos.lat) || 0,
      lng: Number(sos.lng) || 0,
      accuracyMeters: sos.accuracyMeters,
      address: sos.address || '',
      triggerMethod: sos.triggerMethod || 'button_hold',
      notifiedContactsCount: sos.notifiedContactsCount ?? recipients.length,
      authorityNotified: true,
      deliverySummary: sos.deliverySummary || '',
      smsSummary: smsSummaryText,
      smsLogs,
      trackingShareToken: sos.trackingShareToken,
      createdAt: sos.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    if (saved.status === 'active') {
      pushNotification({
        targetType: 'authority',
        targetDepartment: 'Emergency Control Room',
        type: 'sos_alert',
        priority: 'emergency',
        title: `URGENT SOS ALERT: ${saved.displayName}`,
        message: `Live GPS: ${saved.address || `${saved.lat}, ${saved.lng}`}`,
        relatedType: 'sos',
        relatedId: saved.id,
      });
      pushNotification({
        targetType: 'citizen',
        targetUid: saved.uid,
        type: 'sos_active',
        priority: 'emergency',
        title: 'Seva Shield SOS Active',
        message: smsSummaryText || saved.deliverySummary,
        relatedType: 'sos',
        relatedId: saved.id,
      });
    }

    broadcast('authority:all', saved.status === 'active' ? 'sos:alert' : 'sos:updated', saved);
    broadcast(`citizen:${saved.uid}`, 'sos:updated', saved);
    return res.json({ synced: true, sos: saved });
  });

  app.post('/api/medical/create', async (req, res) => {
    if (rejectIfAuthorityToken(req, res)) return;
    const {
      uid,
      citizenName,
      citizenEmail,
      citizenPhone,
      condition,
      severity,
      lat,
      lng,
      accuracyMeters,
      address,
      nearestHospital,
      caregiverContacts,
    } = req.body as {
      uid?: string;
      citizenName?: string;
      citizenEmail?: string;
      citizenPhone?: string;
      condition?: string;
      severity?: 'Urgent' | 'Critical';
      lat?: number;
      lng?: number;
      accuracyMeters?: number;
      address?: string;
      nearestHospital?: string;
      caregiverContacts?: CaregiverRecipient[];
    };

    if (!uid || !condition || condition.trim().length < 3 || typeof lat !== 'number' || typeof lng !== 'number') {
      return res.status(400).json({ error: 'Valid user ID, patient condition, and coordinates are required.' });
    }

    const id = `med_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const trackingId = `MED-${Math.floor(100000 + Math.random() * 900000)}`;
    const nowIso = new Date().toISOString();
    const contactsFromReq = Array.isArray(caregiverContacts) ? caregiverContacts : [];
    const contactsList =
      contactsFromReq.length > 0
        ? contactsFromReq
        : getCaregiversByUid(uid).map((c) => ({ name: c.name, phone: c.phone }));

    const smsRes = await dispatchCaregiverSmsAlerts({
      emergencyId: id,
      emergencyType: 'medical_request',
      citizenName: citizenName || 'Citizen',
      messageBody: `SEVA MEDICAL ALERT (${trackingId}): ${citizenName || 'Citizen'} requested ${
        severity || 'Urgent'
      } medical help at ${address || `${lat}, ${lng}`}. Condition: ${condition.trim().slice(0, 140)}`,
      recipients: contactsList,
    });

    const record: MedicalRequestRecord = {
      id,
      trackingId,
      uid,
      citizenName: (citizenName || 'Citizen').slice(0, 80),
      citizenEmail: citizenEmail?.slice(0, 150),
      citizenPhone: citizenPhone?.slice(0, 20),
      condition: condition.trim().slice(0, 800),
      severity: severity === 'Critical' ? 'Critical' : 'Urgent',
      lat,
      lng,
      accuracyMeters,
      address: (address || `${lat.toFixed(5)}, ${lng.toFixed(5)}`).slice(0, 300),
      nearestHospital: nearestHospital?.slice(0, 200),
      caregiverContactsCount: contactsList.length,
      smsStatus: smsRes.summaryText,
      status: 'Authority Notified',
      timeline: [
        { label: 'Medical Assistance Request Received', actor: 'Citizen', timestamp: nowIso },
        {
          label: 'Medical Services Authority Notified',
          actor: 'SEVA Medical Dispatch',
          note: nearestHospital ? `Nearest hospital: ${nearestHospital}` : undefined,
          timestamp: nowIso,
        },
      ],
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    const saved = upsertMedicalRequest(record);

    pushNotification({
      targetType: 'authority',
      targetDepartment: 'Medical Services',
      type: 'medical_emergency',
      priority: 'emergency',
      title: `MEDICAL EMERGENCY (${trackingId})`,
      message: `${saved.severity} · ${saved.condition.slice(0, 120)} · ${saved.address}`,
      relatedType: 'medical',
      relatedId: saved.id,
    });
    pushNotification({
      targetType: 'citizen',
      targetUid: uid,
      type: 'medical_created',
      priority: 'high',
      title: `Medical Request ${trackingId} Sent`,
      message: `Medical Services notified. ${smsRes.summaryText}`,
      relatedType: 'medical',
      relatedId: saved.id,
    });

    broadcast('authority:all', 'medical:new', saved);
    broadcast(`citizen:${uid}`, 'medical:updated', saved);
    return res.json({ medicalRequest: saved, smsDispatch: smsRes });
  });

  app.get('/api/citizen/medical/:uid', (req, res) => {
    if (rejectIfAuthorityToken(req, res)) return;
    return res.json({ requests: getMedicalRequests(req.params.uid) });
  });

  app.post('/api/authority/emergencies/:kind/:id/manage', (req, res) => {
    const session = getAuthoritySession(getBearerToken(req));
    if (!session) return res.status(401).json({ error: 'Authorized department session required.' });

    const { kind, id } = req.params;
    const { status, assignedResponder, responseNotes } = req.body as {
      status?: string;
      assignedResponder?: string;
      responseNotes?: string;
    };
    const nowIso = new Date().toISOString();

    if (kind === 'sos') {
      const updated = updateOperationalSos(id, (prev) => ({
        ...prev,
        status: (status as any) || prev.status,
        assignedResponder: assignedResponder ?? prev.assignedResponder,
        responseNotes: responseNotes ?? prev.responseNotes,
        updatedAt: nowIso,
      }));
      if (!updated) return res.status(404).json({ error: 'SOS alert not found.' });
      addAuditLog({
        actorUid: session.uid,
        actorRole: session.role,
        department: session.department,
        action: `sos:${updated.status}`,
        targetId: updated.id,
        detail: responseNotes || `Updated SOS to ${updated.status}`,
      });
      pushNotification({
        targetType: 'citizen',
        targetUid: updated.uid,
        type: 'sos_response',
        priority: 'emergency',
        title: `SOS Update: ${updated.status.replace('_', ' ')}`,
        message: responseNotes || `Responder ${updated.assignedResponder || session.name} updated your SOS.`,
        relatedType: 'sos',
        relatedId: updated.id,
      });
      broadcast('authority:all', 'sos:updated', updated);
      broadcast(`citizen:${updated.uid}`, 'sos:updated', updated);
      return res.json({ item: updated });
    }

    if (kind === 'medical') {
      const updated = updateMedicalRequest(id, (prev) => ({
        ...prev,
        status: (status as EmergencyRequestStatus) || prev.status,
        assignedResponder: assignedResponder ?? prev.assignedResponder,
        responseNotes: responseNotes ?? prev.responseNotes,
        timeline: [
          ...prev.timeline,
          {
            label: status || 'Responder Update',
            actor: `${session.department} (${session.name})`,
            note: responseNotes || undefined,
            timestamp: nowIso,
          },
        ],
        updatedAt: nowIso,
      }));
      if (!updated) return res.status(404).json({ error: 'Medical request not found.' });
      addAuditLog({
        actorUid: session.uid,
        actorRole: session.role,
        department: session.department,
        action: `medical:${updated.status}`,
        targetId: updated.trackingId,
        detail: responseNotes || `Updated medical request to ${updated.status}`,
      });
      pushNotification({
        targetType: 'citizen',
        targetUid: updated.uid,
        type: 'medical_update',
        priority: 'emergency',
        title: `Medical Help ${updated.trackingId}: ${updated.status}`,
        message: responseNotes || `Assigned responder: ${updated.assignedResponder || session.name}`,
        relatedType: 'medical',
        relatedId: updated.id,
      });
      broadcast('authority:all', 'medical:updated', updated);
      broadcast(`citizen:${updated.uid}`, 'medical:updated', updated);
      return res.json({ item: updated });
    }

    return res.status(400).json({ error: 'Unknown emergency category.' });
  });

  // Twilio / SMS Gateway Delivery Status Webhook (authenticated via X-Twilio-Signature HMAC or X-SMS-Webhook-Token)
  app.post('/api/sms/twilio-webhook', (req, res) => {
    const twilioSig = req.header('X-Twilio-Signature');
    const customToken = req.header('X-SMS-Webhook-Token') || getBearerToken(req);
    const configuredWebhookToken = process.env.SMS_WEBHOOK_TOKEN?.trim();

    let authenticated = false;
    if (twilioSig && process.env.TWILIO_AUTH_TOKEN?.trim()) {
      const proto = req.protocol;
      const host = req.get('host') || '';
      const fullUrl = `${proto}://${host}${req.originalUrl}`;
      authenticated = verifyTwilioWebhookSignature({
        signatureHeader: twilioSig,
        fullUrl,
        bodyParams: (req.body || {}) as Record<string, string>,
      });
    } else if (configuredWebhookToken && customToken && customToken === configuredWebhookToken) {
      authenticated = true;
    }

    if (!authenticated) {
      return res.status(403).json({ error: 'Webhook authentication failed (invalid Twilio signature or token).' });
    }

    const messageSid = String(req.body?.MessageSid || req.body?.SmsSid || req.body?.messageId || '').trim();
    const rawStatus = String(req.body?.MessageStatus || req.body?.SmsStatus || req.body?.status || '').toLowerCase();
    const rawErrorCode = req.body?.ErrorCode ? String(req.body.ErrorCode).trim() : '';
    const rawErrorMessage = req.body?.ErrorMessage ? String(req.body.ErrorMessage).trim() : '';
    const errorDetail = rawErrorCode
      ? `Twilio Error ${rawErrorCode}${rawErrorMessage ? `: ${rawErrorMessage}` : ''}`
      : rawErrorMessage || undefined;

    if (!messageSid || !rawStatus) {
      return res.status(400).json({ error: 'MessageSid and MessageStatus are required.' });
    }

    const mappedStatus: 'queued' | 'sent' | 'delivered' | 'pending' | 'failed' =
      rawStatus === 'delivered'
        ? 'delivered'
        : rawStatus === 'sent'
        ? 'sent'
        : rawStatus === 'queued' || rawStatus === 'accepted' || rawStatus === 'sending'
        ? 'queued'
        : rawStatus === 'failed' || rawStatus === 'undelivered' || rawStatus === 'canceled'
        ? 'failed'
        : 'pending';

    const updatedLog = updateSmsLogByProviderId(messageSid, mappedStatus, errorDetail);
    if (updatedLog) {
      addAuditLog({
        actorUid: 'twilio_webhook',
        actorRole: 'system',
        department: 'Emergency Control Room',
        action: `sms_webhook:${mappedStatus}`,
        targetId: updatedLog.emergencyId,
        detail: `Provider SID ${messageSid} updated to ${rawStatus}${errorDetail ? ` (${errorDetail})` : ''}.`,
      });
      broadcast('authority:all', 'sms:updated', updatedLog);
    }

    return res.status(200).json({ received: true, status: mappedStatus, matched: Boolean(updatedLog) });
  });

  app.post('/api/authority/sms-logs/:id/refresh-status', async (req, res) => {
    const session = getAuthoritySession(getBearerToken(req));
    if (!session) return res.status(401).json({ error: 'Authorized department session required.' });

    const existing = getSmsLogById(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'SMS log entry not found.' });
    }
    if (!existing.providerMessageId || existing.provider !== 'twilio_rest_api') {
      return res.status(400).json({ error: 'SMS log entry does not have a Twilio Message SID to query.' });
    }

    const updated = await refreshTwilioSmsLogStatus(existing.id);
    return res.json({ log: updated || existing });
  });

  // =========================================================================
  // 9. CITIZEN COMPLAINT BOX (COMPLAINTS AGAINST AUTHORITY + ANTI-SELF-REVIEW)
  // =========================================================================
  app.post('/api/complaints', (req, res) => {
    if (rejectIfAuthorityToken(req, res)) return;
    const {
      citizenUid,
      citizenName,
      isAnonymous,
      subject,
      relatedReportId,
      targetDepartment,
      targetOfficerUid,
      targetOfficerName,
      category,
      description,
      evidenceFiles,
    } = req.body as {
      citizenUid?: string;
      citizenName?: string;
      isAnonymous?: boolean;
      subject?: string;
      relatedReportId?: string;
      targetDepartment?: string;
      targetOfficerUid?: string;
      targetOfficerName?: string;
      category?: string;
      description?: string;
      evidenceFiles?: UploadedFileRef[];
    };

    if (!citizenUid || !subject?.trim() || !targetDepartment?.trim() || !description?.trim() || description.trim().length < 10) {
      return res.status(400).json({ error: 'Subject, target department, and a clear description (min 10 chars) are required.' });
    }

    const id = `cmp_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const complaintRef = `CMP-${new Date().getFullYear()}-${Math.floor(100000 + Math.random() * 900000)}`;
    const nowIso = new Date().toISOString();

    const record: CitizenComplaintAgainstAuthority = {
      id,
      complaintRef,
      citizenUid,
      citizenName: isAnonymous ? 'Anonymous Citizen' : (citizenName || 'Citizen').slice(0, 80),
      isAnonymous: Boolean(isAnonymous),
      subject: subject.trim().slice(0, 160),
      relatedReportId: relatedReportId?.trim().slice(0, 60) || undefined,
      targetDepartment: targetDepartment.trim().slice(0, 80),
      targetOfficerUid: targetOfficerUid?.trim() || undefined,
      targetOfficerName: targetOfficerName?.trim().slice(0, 120) || undefined,
      category: (category || 'Delayed Action / Negligence').slice(0, 80),
      description: description.trim().slice(0, 3000),
      evidenceFiles: Array.isArray(evidenceFiles) ? evidenceFiles : [],
      status: 'Submitted',
      internalNotes: [],
      publicUpdates: [
        {
          id: `upd_${Date.now()}`,
          actor: 'System',
          message: 'Confidential accountability complaint filed and routed to Independent Oversight / Department Supervisor.',
          status: 'Submitted',
          createdAt: nowIso,
        },
      ],
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    createCitizenComplaint(record);

    addAuditLog({
      actorUid: citizenUid,
      actorRole: 'citizen',
      department: record.targetDepartment,
      action: 'complaint_against_authority_filed',
      targetId: record.complaintRef,
      detail: `Filed against ${record.targetDepartment}${record.targetOfficerName ? ` (${record.targetOfficerName})` : ''}.`,
    });

    pushNotification({
      targetType: 'supervisor',
      targetDepartment: record.targetDepartment,
      type: 'authority_complaint_filed',
      priority: 'high',
      title: `Oversight Complaint ${record.complaintRef}`,
      message: `Category: ${record.category} · Dept: ${record.targetDepartment} · Independent review required.`,
      relatedType: 'complaint',
      relatedId: record.id,
    });

    pushNotification({
      targetType: 'citizen',
      targetUid: citizenUid,
      type: 'complaint_submitted',
      priority: 'normal',
      title: `Complaint ${record.complaintRef} Logged`,
      message: `Confidentially routed to an independent supervisor/admin outside officer control.`,
      relatedType: 'complaint',
      relatedId: record.id,
    });

    broadcast('authority:all', 'complaint:new', { id: record.id, complaintRef: record.complaintRef });
    return res.json({ complaint: { ...record, internalNotes: undefined } });
  });

  app.get('/api/citizen/complaints/:uid', (req, res) => {
    if (rejectIfAuthorityToken(req, res)) return;
    // Confidentiality: strip internal investigation notes for citizen view
    const list = getCitizenComplaintsByUid(req.params.uid).map((c) => ({
      ...c,
      internalNotes: undefined,
    }));
    return res.json({ complaints: list });
  });

  app.get('/api/authority/complaints', (req, res) => {
    const session = getAuthoritySession(getBearerToken(req));
    if (!session) return res.status(401).json({ error: 'Authorized department session required.' });
    if (session.role !== 'supervisor' && session.role !== 'admin') {
      // Regular field officers can only view complaints explicitly assigned to them as independent reviewer (never target!)
      const assigned = getAuthorityComplaintsForSession(session);
      return res.json({ complaints: assigned });
    }
    return res.json({ complaints: getAuthorityComplaintsForSession(session) });
  });

  app.post('/api/authority/complaints/:id/manage', (req, res) => {
    const session = getAuthoritySession(getBearerToken(req));
    if (!session) return res.status(401).json({ error: 'Authorized department session required.' });

    const existing = getCitizenComplaintById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Complaint record not found.' });

    // STRICT CONFLICT OF INTEREST GUARD (NO SELF-REVIEW OR SELF-ASSIGNMENT)
    const isActorTarget =
      (existing.targetOfficerUid && existing.targetOfficerUid === session.uid) ||
      (existing.targetOfficerName &&
        existing.targetOfficerName.trim().toLowerCase() === session.name.trim().toLowerCase());
    if (isActorTarget) {
      return res.status(403).json({
        error: 'Conflict of Interest Blocked: An officer cannot inspect, assign, or resolve a citizen complaint filed against themselves.',
      });
    }

    const { status, reviewerUid, reviewerName, internalNote, publicUpdate, finalResolution } = req.body as {
      status?: ComplaintBoxStatus;
      reviewerUid?: string;
      reviewerName?: string;
      internalNote?: string;
      publicUpdate?: string;
      finalResolution?: string;
    };

    const isAssigningTargetAsReviewer =
      (reviewerUid && existing.targetOfficerUid && reviewerUid === existing.targetOfficerUid) ||
      (reviewerName &&
        existing.targetOfficerName &&
        reviewerName.trim().toLowerCase() === existing.targetOfficerName.trim().toLowerCase());
    if (isAssigningTargetAsReviewer) {
      return res.status(403).json({
        error: 'Conflict of Interest Blocked: Cannot assign an officer to investigate a complaint directed at them.',
      });
    }

    if (session.role !== 'supervisor' && session.role !== 'admin' && existing.reviewerUid !== session.uid) {
      return res.status(403).json({ error: 'Supervisor, Admin, or assigned Independent Reviewer access required.' });
    }

    const nowIso = new Date().toISOString();
    const updated = updateCitizenComplaint(req.params.id, (prev) => {
      const nextStatus = status || prev.status;
      const nextInternal = internalNote?.trim()
        ? [
            ...prev.internalNotes,
            { id: `in_${Date.now()}`, author: `${session.name} (${session.role})`, note: internalNote.trim(), createdAt: nowIso },
          ]
        : prev.internalNotes;
      const nextPublic = publicUpdate?.trim()
        ? [
            ...prev.publicUpdates,
            {
              id: `pub_${Date.now()}`,
              actor: `Independent Reviewer (${session.name})`,
              message: publicUpdate.trim(),
              status: nextStatus,
              createdAt: nowIso,
            },
          ]
        : prev.publicUpdates;

      return {
        ...prev,
        status: nextStatus,
        reviewerUid: reviewerUid || prev.reviewerUid || session.uid,
        reviewerName: reviewerName?.trim() || prev.reviewerName || session.name,
        internalNotes: nextInternal,
        publicUpdates: nextPublic,
        finalResolution: finalResolution?.trim() || prev.finalResolution,
        updatedAt: nowIso,
      };
    });

    if (!updated) return res.status(404).json({ error: 'Update failed.' });

    addAuditLog({
      actorUid: session.uid,
      actorRole: session.role,
      department: session.department,
      action: `complaint_oversight:${updated.status}`,
      targetId: updated.complaintRef,
      detail: publicUpdate || finalResolution || internalNote || `Status updated to ${updated.status}.`,
    });

    pushNotification({
      targetType: 'citizen',
      targetUid: updated.citizenUid,
      type: 'complaint_box_update',
      priority: 'high',
      title: `Oversight Update (${updated.complaintRef}): ${updated.status}`,
      message: finalResolution || publicUpdate || `Reviewed by ${updated.reviewerName}.`,
      relatedType: 'complaint',
      relatedId: updated.id,
    });

    broadcast('authority:all', 'complaint:updated', { id: updated.id, complaintRef: updated.complaintRef });
    broadcast(`citizen:${updated.citizenUid}`, 'complaint:updated', { ...updated, internalNotes: undefined });

    return res.json({ complaint: updated });
  });

  // =========================================================================
  // 10. AUTHORITY PERFORMANCE INDEX, LEADERBOARD & ANALYTICS
  // =========================================================================
  app.get('/api/authority/performance', (req, res) => {
    const session = getAuthoritySession(getBearerToken(req));
    if (!session) return res.status(401).json({ error: 'Authorized department session required.' });
    const rawPeriod = String(req.query.period || 'all');
    const period: '7d' | '30d' | '90d' | 'all' =
      rawPeriod === '7d' || rawPeriod === '30d' || rawPeriod === '90d' ? rawPeriod : 'all';
    const department = req.query.department ? String(req.query.department) : undefined;
    return res.json(computePerformanceAndAnalytics({ period, department }));
  });

  // =========================================================================
  // 11. REAL-TIME BIDIRECTIONAL NOTIFICATIONS (CITIZEN + AUTHORITY)
  // =========================================================================
  app.get('/api/notifications', (req, res) => {
    const session = getAuthoritySession(getBearerToken(req));
    if (session) {
      const items = getNotificationsForAuthority(session);
      return res.json({ notifications: items, unreadCount: items.filter((n) => !n.read).length });
    }
    const uid = String(req.query.uid || '').trim();
    if (!uid) return res.status(400).json({ error: 'Citizen uid or Authority Bearer token required.' });
    const items = getNotificationsForCitizen(uid);
    return res.json({ notifications: items, unreadCount: items.filter((n) => !n.read).length });
  });

  app.post('/api/notifications/:id/read', (req, res) => {
    const updated = markNotificationRead(req.params.id);
    if (!updated) return res.status(404).json({ error: 'Notification not found.' });
    return res.json({ notification: updated });
  });

  app.post('/api/notifications/read-all', (req, res) => {
    const session = getAuthoritySession(getBearerToken(req));
    if (session) {
      const authList = getNotificationsForAuthority(session);
      const idSet = new Set(authList.map((n) => n.id));
      const count = markAllNotificationsRead((n) => idSet.has(n.id));
      return res.json({ marked: count });
    }
    const uid = String(req.body?.uid || '').trim();
    if (!uid) return res.status(400).json({ error: 'uid or authority token required.' });
    const count = markAllNotificationsRead((n) => n.targetType === 'citizen' && n.targetUid === uid);
    return res.json({ marked: count });
  });

  app.get('/api/meta/categories', (_req, res) => {
    res.json({ categories: CIVIC_CATEGORIES, departmentByCategory: DEPARTMENT_BY_CATEGORY });
  });

  app.all('/api/*', (_req, res) => {
    res.status(404).json({ error: 'API endpoint not found.' });
  });

  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`SEVA AI server listening on port ${PORT} (${isProduction ? 'production' : 'development'})`);
  });
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
