import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export interface TrackingPoint {
  lat: number;
  lng: number;
  accuracyMeters: number;
  address: string;
  timestamp: string;
}

export interface LiveTrackingRecord {
  shareToken: string;
  ownerUid: string;
  ownerDisplayName: string;
  status: 'active' | 'paused' | 'stopped' | 'revoked';
  lat: number;
  lng: number;
  accuracyMeters: number;
  address: string;
  expiresAt: string;
  updatedAt: string;
  history: TrackingPoint[];
}

export interface OperationalReportRecord {
  id: string;
  complaintId: string;
  reporterUid: string;
  reporterDisplayName: string;
  category: string;
  title: string;
  description: string;
  severity: 'Low' | 'Medium' | 'High' | 'Critical';
  status: 'Submitted' | 'Authority Acknowledged' | 'Assigned' | 'In Progress' | 'Resolved' | 'Rejected';
  department: string;
  ward: string;
  locality: string;
  address: string;
  lat: number;
  lng: number;
  accuracyMeters?: number;
  isEmergency: boolean;
  isSensitive: boolean;
  photoDataUrl?: string;
  imageHash?: string;
  hasVideo?: boolean;
  videoName?: string;
  aiSummary?: string;
  aiSuggestedCategory?: string;
  aiSuggestedSeverity?: string;
  aiConfidence?: number;
  fraudRiskScore: number;
  fraudRiskLevel: 'Low' | 'Moderate' | 'High' | 'Critical';
  fraudIndicators: string[];
  fraudExplanation?: string;
  fraudQueueStatus: 'cleared' | 'validation_needed' | 'restricted_queue' | 'investigation_queue' | 'rejected';
  assignedOfficer?: string;
  actionNotes?: string;
  resolutionNotes?: string;
  timeline: Array<{
    step: string;
    label: string;
    actorRole: string;
    note?: string;
    timestamp: string;
  }>;
  createdAt: string;
  updatedAt: string;
}

export interface OperationalSosRecord {
  id: string;
  uid: string;
  displayName: string;
  status: 'active' | 'safe_resolved' | 'cancelled';
  lat: number;
  lng: number;
  accuracyMeters?: number;
  address: string;
  triggerMethod: 'button_hold' | 'voice_phrase';
  notifiedContactsCount: number;
  authorityNotified: boolean;
  deliverySummary: string;
  trackingShareToken?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuditLogEntry {
  id: string;
  actorUid: string;
  actorRole: string;
  department?: string;
  action: string;
  targetId: string;
  detail: string;
  timestamp: string;
}

export interface AuthoritySession {
  token: string;
  uid: string;
  email: string;
  name: string;
  department: string;
  jurisdiction: string;
  role: 'authority' | 'admin';
  expiresAt: number;
}

interface PersistedState {
  sessionSecret?: string;
  authorityPasscodeHash?: string;
  authorityPasscodeSalt?: string;
  reports: OperationalReportRecord[];
  sosEvents: OperationalSosRecord[];
  auditLogs: AuditLogEntry[];
  trackingSessions?: Record<string, LiveTrackingRecord>;
}

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'seva-operational.json');

const activeTracking = new Map<string, LiveTrackingRecord>();
const authoritySessions = new Map<string, AuthoritySession>();

function loadState(): PersistedState {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const parsed = JSON.parse(raw) as PersistedState;
      const loadedTracking = parsed.trackingSessions && typeof parsed.trackingSessions === 'object' ? parsed.trackingSessions : {};
      for (const [k, v] of Object.entries(loadedTracking)) {
        if (v && v.shareToken) activeTracking.set(k, v);
      }
      return {
        sessionSecret: parsed.sessionSecret,
        authorityPasscodeHash: parsed.authorityPasscodeHash,
        authorityPasscodeSalt: parsed.authorityPasscodeSalt,
        reports: Array.isArray(parsed.reports) ? parsed.reports : [],
        sosEvents: Array.isArray(parsed.sosEvents) ? parsed.sosEvents : [],
        auditLogs: Array.isArray(parsed.auditLogs) ? parsed.auditLogs : [],
        trackingSessions: loadedTracking,
      };
    }
  } catch (err) {
    console.error('Failed to load operational store:', err);
  }
  return { reports: [], sosEvents: [], auditLogs: [], trackingSessions: {} };
}

let state: PersistedState = loadState();

function getSessionSecret(): string {
  const envSecret = process.env.SESSION_SECRET?.trim();
  if (envSecret && envSecret.length >= 16) return envSecret;
  if (!state.sessionSecret) {
    state.sessionSecret = crypto.randomBytes(32).toString('hex');
    persistState();
  }
  return state.sessionSecret;
}

function persistState() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const tmp = `${DATA_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, DATA_FILE);
  } catch (err) {
    console.error('Failed to persist operational store:', err);
  }
}

export function hashPasscode(passcode: string, salt?: string): { hash: string; salt: string } {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(passcode, s, 64).toString('hex');
  return { hash: derived, salt: s };
}

export function isAuthorityPasscodeConfigured(): boolean {
  const envCode = process.env.AUTHORITY_ACCESS_CODE?.trim();
  return Boolean((envCode && envCode.length >= 6) || (state.authorityPasscodeHash && state.authorityPasscodeSalt));
}

export function claimFirstRunAuthorityPasscode(passcode: string): boolean {
  if (isAuthorityPasscodeConfigured()) return false;
  if (!passcode || passcode.trim().length < 6) return false;
  const { hash, salt } = hashPasscode(passcode.trim());
  state.authorityPasscodeHash = hash;
  state.authorityPasscodeSalt = salt;
  persistState();
  return true;
}

export function verifyAuthorityPasscode(passcode: string): boolean {
  const candidate = passcode.trim();
  if (!candidate) return false;

  const envCode = process.env.AUTHORITY_ACCESS_CODE?.trim();
  if (envCode && envCode.length >= 6) {
    const a = Buffer.from(candidate);
    const b = Buffer.from(envCode);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  if (state.authorityPasscodeHash && state.authorityPasscodeSalt) {
    const { hash } = hashPasscode(candidate, state.authorityPasscodeSalt);
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(state.authorityPasscodeHash, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  return false;
}

export function createAuthoritySession(params: {
  uid: string;
  email: string;
  name: string;
  department: string;
  jurisdiction: string;
  isAdmin: boolean;
}): AuthoritySession {
  const expiresAt = Date.now() + 8 * 60 * 60 * 1000;
  const claims = {
    uid: params.uid,
    email: params.email,
    name: params.name,
    department: params.department,
    jurisdiction: params.jurisdiction,
    role: (params.isAdmin ? 'admin' : 'authority') as 'admin' | 'authority',
    expiresAt,
    nonce: crypto.randomBytes(8).toString('hex'),
  };
  const body = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', getSessionSecret()).update(body).digest('hex');
  const token = `${body}.${sig}`;
  const session: AuthoritySession = {
    token,
    uid: claims.uid,
    email: claims.email,
    name: claims.name,
    department: claims.department,
    jurisdiction: claims.jurisdiction,
    role: claims.role,
    expiresAt,
  };
  authoritySessions.set(token, session);
  return session;
}

export function getAuthoritySession(token: string | undefined): AuthoritySession | null {
  if (!token) return null;
  const cached = authoritySessions.get(token);
  if (cached) {
    if (cached.expiresAt < Date.now()) {
      authoritySessions.delete(token);
      return null;
    }
    return cached;
  }

  // Stateless HMAC verification fallback so sessions survive server restarts & Render sleep/wake
  const dotIdx = token.indexOf('.');
  if (dotIdx <= 0) return null;
  const body = token.slice(0, dotIdx);
  const sig = token.slice(dotIdx + 1);
  if (!body || !sig || sig.length !== 64) return null;

  try {
    const expectedSig = crypto.createHmac('sha256', getSessionSecret()).update(body).digest('hex');
    const sigBuf = Buffer.from(sig, 'hex');
    const expBuf = Buffer.from(expectedSig, 'hex');
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return null;
    }
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as AuthoritySession;
    if (!parsed || !parsed.uid || !parsed.department || !parsed.expiresAt || parsed.expiresAt < Date.now()) {
      return null;
    }
    const session: AuthoritySession = {
      token,
      uid: parsed.uid,
      email: parsed.email || '',
      name: parsed.name || 'Authority Officer',
      department: parsed.department,
      jurisdiction: parsed.jurisdiction || 'Citywide',
      role: parsed.role === 'admin' ? 'admin' : 'authority',
      expiresAt: parsed.expiresAt,
    };
    authoritySessions.set(token, session);
    return session;
  } catch {
    return null;
  }
}

export function addAuditLog(entry: Omit<AuditLogEntry, 'id' | 'timestamp'>) {
  const full: AuditLogEntry = {
    ...entry,
    id: `AUD-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
    timestamp: new Date().toISOString(),
  };
  state.auditLogs.unshift(full);
  if (state.auditLogs.length > 500) state.auditLogs.length = 500;
  persistState();
  return full;
}

export function getAuditLogs(): AuditLogEntry[] {
  return state.auditLogs;
}

export function getRecentReportsForContext() {
  return state.reports.slice(0, 30).map((r) => ({
    id: r.complaintId,
    title: r.title,
    category: r.category,
    lat: r.lat,
    lng: r.lng,
    description: r.description,
    imageHash: r.imageHash,
  }));
}

export function upsertOperationalReport(report: OperationalReportRecord): OperationalReportRecord {
  const idx = state.reports.findIndex((r) => r.id === report.id || r.complaintId === report.complaintId);
  if (idx >= 0) {
    state.reports[idx] = report;
  } else {
    state.reports.unshift(report);
  }
  persistState();
  return report;
}

export function getOperationalReports(filters?: {
  department?: string;
  category?: string;
  status?: string;
  severity?: string;
  fraudQueue?: 'operational' | 'fraud_review' | 'all';
  includeSensitive?: boolean;
}): OperationalReportRecord[] {
  return state.reports.filter((r) => {
    if (!filters?.includeSensitive && r.isSensitive) return false;
    if (filters?.fraudQueue === 'operational') {
      if ((r.fraudQueueStatus === 'restricted_queue' || r.fraudQueueStatus === 'investigation_queue' || r.fraudQueueStatus === 'rejected') && !r.isEmergency) {
        return false;
      }
    } else if (filters?.fraudQueue === 'fraud_review') {
      if (r.fraudQueueStatus === 'cleared') return false;
    }
    if (filters?.department && filters.department !== 'All Departments' && r.department !== filters.department) {
      return false;
    }
    if (filters?.category && filters.category !== 'All' && r.category !== filters.category) return false;
    if (filters?.status && filters.status !== 'All' && r.status !== filters.status) return false;
    if (filters?.severity && filters.severity !== 'All' && r.severity !== filters.severity) return false;
    return true;
  });
}

export function getOperationalReportById(id: string): OperationalReportRecord | undefined {
  return state.reports.find((r) => r.id === id || r.complaintId === id);
}

export function updateOperationalReport(
  id: string,
  updater: (existing: OperationalReportRecord) => OperationalReportRecord
): OperationalReportRecord | null {
  const idx = state.reports.findIndex((r) => r.id === id || r.complaintId === id);
  if (idx < 0) return null;
  state.reports[idx] = updater(state.reports[idx]);
  persistState();
  return state.reports[idx];
}

export function upsertOperationalSos(sos: OperationalSosRecord): OperationalSosRecord {
  const idx = state.sosEvents.findIndex((s) => s.id === sos.id);
  if (idx >= 0) state.sosEvents[idx] = sos;
  else state.sosEvents.unshift(sos);
  persistState();
  return sos;
}

export function getOperationalSosEvents(): OperationalSosRecord[] {
  return state.sosEvents;
}

export function getPublicHeatmapIncidents() {
  // Privacy-preserving aggregation: strip reporter identities & fuzz sensitive coordinates to ~300m grid
  const approved = state.reports.filter(
    (r) => r.fraudQueueStatus !== 'rejected' && r.fraudQueueStatus !== 'investigation_queue'
  );
  return approved.map((r) => ({
    id: r.complaintId,
    category: r.category,
    severity: r.severity,
    ward: r.ward || 'City Ward',
    locality: r.locality || '',
    lat: r.isSensitive ? Number(r.lat.toFixed(3)) : Number(r.lat.toFixed(4)),
    lng: r.isSensitive ? Number(r.lng.toFixed(3)) : Number(r.lng.toFixed(4)),
    isSensitiveArea: r.isSensitive,
    status: r.status,
    createdAt: r.createdAt,
  }));
}

export function upsertTrackingSession(record: LiveTrackingRecord) {
  activeTracking.set(record.shareToken, record);
  if (!state.trackingSessions) state.trackingSessions = {};
  state.trackingSessions[record.shareToken] = record;
  // Prune expired tracking sessions to keep file compact
  const now = Date.now();
  for (const [key, val] of Object.entries(state.trackingSessions)) {
    if (val && new Date(val.expiresAt).getTime() < now - 3600_000) {
      delete state.trackingSessions[key];
      activeTracking.delete(key);
    }
  }
  persistState();
}

export function getTrackingSession(shareToken: string): LiveTrackingRecord | null {
  const rec = activeTracking.get(shareToken);
  if (!rec) return null;
  if (new Date(rec.expiresAt).getTime() < Date.now()) {
    rec.status = 'revoked';
    return rec;
  }
  return rec;
}
