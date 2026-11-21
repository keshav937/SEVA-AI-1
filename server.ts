import 'dotenv/config';
import crypto from 'crypto';
import express from 'express';
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
import { fetchNearbyPlaces, NearbyCategoryKey, reverseGeocode } from './server/places.ts';
import {
  addAuditLog,
  claimFirstRunAuthorityPasscode,
  createAuthoritySession,
  getAuditLogs,
  getAuthoritySession,
  getOperationalReportById,
  getOperationalReports,
  getOperationalSosEvents,
  getPublicHeatmapIncidents,
  getRecentReportsForContext,
  getTrackingSession,
  isAuthorityPasscodeConfigured,
  OperationalReportRecord,
  upsertOperationalReport,
  upsertOperationalSos,
  upsertTrackingSession,
  updateOperationalReport,
  verifyAuthorityPasscode,
} from './server/store.ts';

const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// Simple per-IP in-memory rate limiter for expensive voice/AI endpoints
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
function checkRateLimit(key: string, maxRequests = 40, windowMs = 60_000): boolean {
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

async function startServer() {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  // WebSocket Room Subscriptions
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

  app.set('trust proxy', 1);
  app.use(express.json({ limit: '4mb' }));

  // Health Check (Render + Diagnostics)
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'SEVA AI Civic Platform',
      timestamp: new Date().toISOString(),
      capabilities: {
        elevenlabsConfigured: isElevenLabsConfigured(),
        geminiConfigured: Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'),
        authorityPasscodeConfigured: isAuthorityPasscodeConfigured(),
      },
    });
  });

  // =========================================================================
  // 1. ELEVENLABS VOICE ENDPOINTS (SEVA SAATHI)
  // =========================================================================
  app.get('/api/voice/capabilities', async (_req, res) => {
    const voiceData = await listElevenLabsVoices();
    const geminiOk = isGeminiConfigured();
    const activeVoiceProvider = voiceData.configured
      ? 'elevenlabs'
      : geminiOk
      ? 'gemini'
      : 'browser';
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
    if (!checkRateLimit(`tts:${ip}`, 30, 60_000)) {
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
          const code = err?.code || 'ELEVENLABS_TTS_FAILED';
          return res.status(err?.status === 401 ? 502 : 502).json({
            error: err?.message || 'ElevenLabs TTS failed.',
            code,
            fallbackAvailable: true,
          });
        }
        // Fall through to Gemini Speech Engine when ElevenLabs rejects or quota-limits
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
    if (!checkRateLimit(`stt:${ip}`, 30, 60_000)) {
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
        // Fall through to Gemini Transcribe fallback
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
    if (!checkRateLimit(`saathi:${ip}`, 40, 60_000)) {
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
        myReportsSummary?: Array<{ complaintId: string; title: string; category: string; status: string; updatedAt: string }>;
        includeAuthorityStats?: boolean;
      };
    };

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'A message or transcribed utterance is required.' });
    }

    try {
      const authToken = getBearerToken(req);
      const authSession = getAuthoritySession(authToken);

      let authorityStatsSummary;
      if (userContext?.includeAuthorityStats && authSession) {
        const all = getOperationalReports({ fraudQueue: 'operational', includeSensitive: true });
        authorityStatsSummary = {
          total: all.length,
          pending: all.filter((r) => r.status !== 'Resolved' && r.status !== 'Rejected').length,
          resolved: all.filter((r) => r.status === 'Resolved').length,
          emergencies: all.filter((r) => r.isEmergency && r.status !== 'Resolved').length,
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
  // 2. AI CIVIC REPORT ANALYSIS & SEVA TRUST FRAUD SCORING
  // =========================================================================
  app.post('/api/ai/analyze-report', async (req, res) => {
    const ip = req.ip || 'unknown';
    if (!checkRateLimit(`analyze:${ip}`, 25, 60_000)) {
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
  // 3. NEARBY PLACES DISCOVERY & REVERSE GEOCODING (OPENSTREETMAP)
  // =========================================================================
  app.get('/api/places/nearby', async (req, res) => {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const radius = Number(req.query.radius || 2000);
    const categoriesParam = String(req.query.categories || 'healthcare,public_safety');

    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return res.status(400).json({ error: 'Valid GPS coordinates (lat, lng) are required.' });
    }

    const categories = categoriesParam
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean) as NearbyCategoryKey[];

    try {
      const data = await fetchNearbyPlaces({ lat, lng, radiusMeters: radius, categories });
      return res.json(data);
    } catch (err: any) {
      return res.status(502).json({
        error: err?.message || 'Unable to retrieve nearby places from OpenStreetMap Overpass API.',
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

  // =========================================================================
  // 4. REAL-TIME LIVE GPS TRACKING SESSIONS (SHAREABLE & REVOCABLE)
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
  // 5. AUTHORITY DIRECT ACCESS AUTH & OPERATIONAL PORTAL
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
    if (!checkRateLimit(`auth:${ip}`, 15, 60_000)) {
      return res.status(429).json({ error: 'Too many verification attempts. Please wait a minute.' });
    }

    const { uid, email, name, department, jurisdiction, passcode } = req.body as {
      uid?: string;
      email?: string;
      name?: string;
      department?: string;
      jurisdiction?: string;
      passcode?: string;
    };

    if (!uid || !email || !department || !passcode) {
      return res.status(400).json({ error: 'Signed-in account, department, and official access code are required.' });
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

    const isAdmin = email.toLowerCase() === 'guptakeshav2178@gmail.com' || department === 'Platform Administration';
    const session = createAuthoritySession({
      uid,
      email,
      name: name || 'Authority Officer',
      department,
      jurisdiction: jurisdiction || 'Citywide',
      isAdmin,
    });

    addAuditLog({
      actorUid: uid,
      actorRole: session.role,
      department: session.department,
      action: 'authority_login',
      targetId: uid,
      detail: `Direct authenticated access granted for ${department} (${jurisdiction || 'Citywide'}).`,
    });

    return res.json({
      token: session.token,
      role: session.role,
      department: session.department,
      jurisdiction: session.jurisdiction,
      expiresAt: session.expiresAt,
    });
  });

  // Operational report mirror (called right after citizen confirms report submission)
  app.post('/api/reports/sync', (req, res) => {
    const body = req.body as OperationalReportRecord;
    if (!body?.id || !body?.complaintId || !body?.reporterUid || !body?.title) {
      return res.status(400).json({ error: 'Invalid report payload.' });
    }

    const saved = upsertOperationalReport(body);

    // Notify Authorities in real time if cleared or emergency
    if (
      saved.isEmergency ||
      saved.fraudQueueStatus === 'cleared' ||
      saved.fraudQueueStatus === 'validation_needed'
    ) {
      broadcast('authority:all', 'report:new', {
        complaintId: saved.complaintId,
        category: saved.category,
        severity: saved.severity,
        department: saved.department,
        locality: saved.locality || saved.address,
        isEmergency: saved.isEmergency,
      });
    }

    return res.json({ synced: true, complaintId: saved.complaintId });
  });

  // Public privacy-preserving heatmap data
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

  // SOS operational sync
  app.post('/api/sos/sync', (req, res) => {
    const sos = req.body;
    if (!sos?.id || !sos?.uid) {
      return res.status(400).json({ error: 'Invalid SOS payload.' });
    }
    const saved = upsertOperationalSos(sos);
    broadcast('authority:all', saved.status === 'active' ? 'sos:alert' : 'sos:updated', {
      id: saved.id,
      status: saved.status,
      displayName: saved.displayName,
      address: saved.address,
      lat: saved.lat,
      lng: saved.lng,
      triggerMethod: saved.triggerMethod,
    });
    return res.json({ synced: true, sos: saved });
  });

  // Verified Authority Endpoints
  app.get('/api/authority/reports', (req, res) => {
    const session = getAuthoritySession(getBearerToken(req));
    if (!session) {
      return res.status(401).json({ error: 'Authorized department session required.' });
    }

    const fraudQueue = (req.query.fraudQueue as 'operational' | 'fraud_review' | 'all') || 'operational';
    const department = req.query.department
      ? String(req.query.department)
      : session.role === 'admin' || session.department === 'Emergency Control Room'
      ? 'All Departments'
      : session.department;

    const reports = getOperationalReports({
      department,
      category: req.query.category ? String(req.query.category) : undefined,
      status: req.query.status ? String(req.query.status) : undefined,
      severity: req.query.severity ? String(req.query.severity) : undefined,
      fraudQueue,
      includeSensitive: true,
    });

    const allOps = getOperationalReports({ fraudQueue: 'all', includeSensitive: true });

    return res.json({
      session: {
        department: session.department,
        jurisdiction: session.jurisdiction,
        role: session.role,
      },
      stats: {
        total: allOps.length,
        newReports: allOps.filter((r) => r.status === 'Submitted').length,
        pending: allOps.filter((r) => r.status !== 'Resolved' && r.status !== 'Rejected').length,
        assigned: allOps.filter((r) => r.status === 'Assigned' || r.status === 'In Progress').length,
        resolved: allOps.filter((r) => r.status === 'Resolved').length,
        rejected: allOps.filter((r) => r.status === 'Rejected').length,
        highPriority: allOps.filter((r) => r.severity === 'High' || r.severity === 'Critical').length,
        medicalEmergencies: allOps.filter((r) => r.category === 'Medical Assistance').length,
        accidents: allOps.filter((r) => r.category === 'Road Accident Reporting').length,
        womenSafety: allOps.filter((r) => r.category === 'Women and Child Safety').length,
        animalRescue: allOps.filter((r) => r.category === 'Animal Rescue and Welfare').length,
        underVerification: allOps.filter(
          (r) => r.fraudQueueStatus === 'restricted_queue' || r.fraudQueueStatus === 'investigation_queue'
        ).length,
      },
      reports,
      sosEvents: getOperationalSosEvents(),
      auditLogs: session.role === 'admin' ? getAuditLogs().slice(0, 60) : [],
    });
  });

  app.post('/api/authority/reports/:id/manage', (req, res) => {
    const session = getAuthoritySession(getBearerToken(req));
    if (!session) {
      return res.status(401).json({ error: 'Authorized department session required.' });
    }

    const { status, assignedOfficer, actionNotes, resolutionNotes, fraudDecision } = req.body as {
      status?: OperationalReportRecord['status'];
      assignedOfficer?: string;
      actionNotes?: string;
      resolutionNotes?: string;
      fraudDecision?: 'cleared' | 'rejected' | 'investigation_queue';
    };

    const target = getOperationalReportById(req.params.id);
    if (!target) {
      return res.status(404).json({ error: 'Report not found in operational registry.' });
    }

    const nowIso = new Date().toISOString();
    const updated = updateOperationalReport(req.params.id, (prev) => {
      const nextStatus = status || prev.status;
      const nextFraud = fraudDecision || prev.fraudQueueStatus;
      const nextTimeline = [...prev.timeline];

      if (status && status !== prev.status) {
        nextTimeline.push({
          step: status.toLowerCase().replace(/\s+/g, '_'),
          label: status,
          actorRole: `${session.department} (${session.name})`,
          note: actionNotes || resolutionNotes || undefined,
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
              ? 'Rejected After Fraud Review'
              : 'Escalated to Fraud Investigation',
          actorRole: `Fraud Review (${session.name})`,
          note: actionNotes || undefined,
          timestamp: nowIso,
        });
      }

      return {
        ...prev,
        status: nextStatus,
        assignedOfficer: assignedOfficer ?? prev.assignedOfficer,
        actionNotes: actionNotes ?? prev.actionNotes,
        resolutionNotes: resolutionNotes ?? prev.resolutionNotes,
        fraudQueueStatus: nextFraud,
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
      detail: actionNotes || resolutionNotes || `Updated ${updated.complaintId} to ${updated.status}.`,
    });

    broadcast(`citizen:${updated.reporterUid}`, 'report:updated', updated);
    broadcast('authority:all', 'report:updated', updated);

    return res.json({ report: updated });
  });

  app.get('/api/citizen/reports/:uid', (req, res) => {
    const reports = getOperationalReports({ fraudQueue: 'all', includeSensitive: true }).filter(
      (r) => r.reporterUid === req.params.uid
    );
    return res.json({ reports });
  });

  app.get('/api/meta/categories', (_req, res) => {
    res.json({ categories: CIVIC_CATEGORIES, departmentByCategory: DEPARTMENT_BY_CATEGORY });
  });

  app.all('/api/*', (_req, res) => {
    res.status(404).json({ error: 'API endpoint not found.' });
  });

  // Vite Dev Middleware vs Static Production Build
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
