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
  authorityPasscodeHash?: string;
  authorityPasscodeSalt?: string;
  reports: OperationalReportRecord[];
  sosEvents: OperationalSosRecord[];
  auditLogs: AuditLogEntry[];
}

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'seva-operational.json');
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

const activeTracking = new Map<string, LiveTrackingRecord>();
const authoritySessions = new Map<string, AuthoritySession>();

function loadState(): PersistedState {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const parsed = JSON.parse(raw) as PersistedState;
      return {
        authorityPasscodeHash: parsed.authorityPasscodeHash,
        authorityPasscodeSalt: parsed.authorityPasscodeSalt,
        reports: Array.isArray(parsed.reports) ? parsed.reports : [],
        sosEvents: Array.isArray(parsed.sosEvents) ? parsed.sosEvents : [],
        auditLogs: Array.isArray(parsed.auditLogs) ? parsed.auditLogs : [],
      };
    }
  } catch (err) {
    console.error('Failed to load operational store:', err);
  }
  return { reports: [], sosEvents: [], auditLogs: [] };
}

let state: PersistedState = loadState();

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
  const payload = `${params.uid}:${params.department}:${Date.now()}:${crypto.randomBytes(12).toString('hex')}`;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  const token = `${Buffer.from(payload).toString('base64url')}.${sig}`;
  const session: AuthoritySession = {
    token,
    uid: params.uid,
    email: params.email,
    name: params.name,
    department: params.department,
    jurisdiction: params.jurisdiction,
    role: params.isAdmin ? 'admin' : 'authority',
    expiresAt: Date.now() + 8 * 60 * 60 * 1000,
  };
  authoritySessions.set(token, session);
  return session;
}

export function getAuthoritySession(token: string | undefined): AuthoritySession | null {
  if (!token) return null;
  const session = authoritySessions.get(token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    authoritySessions.delete(token);
    return null;
  }
  return session;
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
