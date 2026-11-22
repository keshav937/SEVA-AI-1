import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export type AuthorityRole = 'authority' | 'supervisor' | 'admin';

export const OPERATIONAL_REPORT_STATUSES = [
  'Submitted',
  'AI Verification Pending',
  'Verified',
  'Rejected with reason',
  'Assigned',
  'In Progress',
  'Resolved – Awaiting Verification',
  'Verified Resolution',
  'Reopened',
  'Escalated',
] as const;

export type OperationalReportStatus = (typeof OPERATIONAL_REPORT_STATUSES)[number];

export const CLOSED_REPORT_STATUSES: ReadonlySet<string> = new Set([
  'Verified Resolution',
  'Rejected with reason',
]);

export const SLA_PAUSED_OR_CLOSED_STATUSES: ReadonlySet<string> = new Set([
  'Resolved – Awaiting Verification',
  'Verified Resolution',
  'Rejected with reason',
]);

export type VerificationStatus =
  | 'Pending Verification'
  | 'Verified'
  | 'Flagged for Manual Review'
  | 'Rejected';

export type SmsEventType =
  | 'caregiver_added'
  | 'sos_activated'
  | 'medical_request'
  | 'complaint_status_updated'
  | 'resolution_completed'
  | 'safety_alert'
  | 'sos'
  | 'medical';

export interface UploadedFileRef {
  id: string;
  filename: string;
  url: string;
  originalName: string;
  mimeType: string;
  size: number;
  caption?: string;
  uploadedAt: string;
}

export interface AssignmentRecord {
  id: string;
  fromOfficer?: string;
  toOfficer: string;
  toOfficerUid?: string;
  toDepartment: string;
  assignedBy: string;
  assignedByRole: string;
  reason?: string;
  assignedAt: string;
}

export interface ResolutionEvidence {
  beforePhotos: UploadedFileRef[];
  afterPhotos: UploadedFileRef[];
  extraPhotos: UploadedFileRef[];
  description: string;
  completionNotes: string;
  completedAt?: string;
  resolvingOfficer?: string;
  resolvingOfficerUid?: string;
  approvalStatus?: 'pending_review' | 'approved' | 'changes_requested';
  approvedBy?: string;
  approvedAt?: string;
  approvalNotes?: string;
}

export interface EscalationRecord {
  id: string;
  level: 1 | 2 | 3;
  targetRole: string;
  reason: string;
  escalatedBy: string;
  automated?: boolean;
  status: 'open' | 'acknowledged' | 'resolved';
  createdAt: string;
}

export interface SlaRule {
  responseMinutes: number;
  resolutionMinutes: number;
}

export interface SlaConfig {
  bySeverity: Record<'Low' | 'Medium' | 'High' | 'Critical', SlaRule>;
  byCategoryOverride: Record<string, Partial<Record<'Low' | 'Medium' | 'High' | 'Critical', SlaRule>>>;
}

export interface OfficerProfile {
  uid: string;
  name: string;
  email: string;
  department: string;
  role: AuthorityRole;
  designation: string;
  jurisdiction: string;
  phone?: string;
  availability: 'available' | 'busy' | 'off_duty';
  activeWorkload: number;
  lastActiveAt: string;
}

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
  referenceNumber?: string;
  idempotencyKey?: string;
  reporterUid: string;
  reporterDisplayName: string;
  reporterPhone?: string;
  smsUpdatesOptIn?: boolean;
  category: string;
  title: string;
  description: string;
  severity: 'Low' | 'Medium' | 'High' | 'Critical';
  status: OperationalReportStatus;
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
  photoUrls?: UploadedFileRef[];
  citizenEvidenceUploads?: UploadedFileRef[];
  imageHash?: string;
  hasVideo?: boolean;
  videoName?: string;
  aiSummary?: string;
  aiSuggestedCategory?: string;
  aiDetectedCategory?: string;
  aiSuggestedSeverity?: string;
  aiConfidence?: number;
  aiDuplicateCheck?: string;
  aiMissingInfoFlags?: string[];
  aiRecommendedAction?: 'accept' | 'flag' | 'reject';
  aiVerificationError?: string;
  aiVerifiedAt?: string;
  imageMatchesDescription?: boolean;
  detectedIssueFromImage?: string;
  fraudRiskScore: number;
  fraudProbability?: number;
  fraudRiskLevel: 'Low' | 'Moderate' | 'High' | 'Critical';
  fraudIndicators: string[];
  fraudExplanation?: string;
  evidenceCompleteness?: 'Complete' | 'Partial' | 'Minimal';
  recommendedActionText?: string;
  fraudQueueStatus: 'cleared' | 'validation_needed' | 'restricted_queue' | 'investigation_queue' | 'rejected';
  verificationStatus?: VerificationStatus;
  verificationNotes?: string;
  verifiedBy?: string;
  verifiedAt?: string;
  additionalEvidenceRequested?: boolean;
  additionalEvidenceRequestNote?: string;
  assignedOfficer?: string;
  assignedOfficerUid?: string;
  assignmentHistory?: AssignmentRecord[];
  actionNotes?: string;
  resolutionNotes?: string;
  resolutionEvidence?: ResolutionEvidence;
  citizenConfirmedResolution?: boolean;
  reopenReason?: string;
  disputeHistory?: Array<{
    id: string;
    reason: string;
    raisedBy: string;
    createdAt: string;
  }>;
  escalations?: EscalationRecord[];
  escalationLevel?: 0 | 1 | 2 | 3;
  slaDeadlineAt?: string;
  slaResponseDeadlineAt?: string;
  slaWarningSentAt?: string;
  slaBreachedAt?: string;
  feedbackRating?: number;
  feedbackComment?: string;
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

export interface SmsLogEntry {
  id: string;
  emergencyId: string;
  emergencyType: SmsEventType;
  recipientName: string;
  recipientPhone: string;
  message: string;
  provider: string;
  status: 'queued' | 'sent' | 'delivered' | 'pending' | 'failed' | 'not_configured';
  attempts: number;
  providerMessageId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CaregiverRecord {
  id: string;
  uid: string;
  name: string;
  phone: string;
  relation: string;
  consentGiven: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CallLogEntry {
  id: string;
  uid: string;
  caregiverId?: string;
  caregiverName: string;
  caregiverPhone: string;
  source: 'seva_shield' | 'medical_assistance' | 'emergency_helpline';
  status: 'dialer_opened' | 'invalid_phone';
  createdAt: string;
}

export interface OperationalSosRecord {
  id: string;
  uid: string;
  displayName: string;
  status: 'active' | 'acknowledged' | 'responder_assigned' | 'safe_resolved' | 'completed' | 'cancelled';
  lat: number;
  lng: number;
  accuracyMeters?: number;
  address: string;
  triggerMethod: 'button_hold' | 'voice_phrase';
  notifiedContactsCount: number;
  authorityNotified: boolean;
  deliverySummary: string;
  smsSummary?: string;
  smsLogs?: SmsLogEntry[];
  assignedResponder?: string;
  responseNotes?: string;
  trackingShareToken?: string;
  createdAt: string;
  updatedAt: string;
}

export type EmergencyRequestStatus =
  | 'Received'
  | 'Authority Notified'
  | 'Acknowledged'
  | 'Responder Assigned'
  | 'On the Way'
  | 'Completed';

export interface MedicalRequestRecord {
  id: string;
  trackingId: string;
  uid: string;
  citizenName: string;
  citizenEmail?: string;
  citizenPhone?: string;
  condition: string;
  severity: 'Urgent' | 'Critical';
  lat: number;
  lng: number;
  accuracyMeters?: number;
  address: string;
  nearestHospital?: string;
  caregiverContactsCount: number;
  smsStatus: string;
  status: EmergencyRequestStatus;
  assignedResponder?: string;
  responseNotes?: string;
  timeline: Array<{ label: string; actor: string; note?: string; timestamp: string }>;
  createdAt: string;
  updatedAt: string;
}

export type ComplaintBoxStatus =
  | 'Submitted'
  | 'Under Supervisor Review'
  | 'Investigating'
  | 'Action Taken'
  | 'Resolved'
  | 'Closed';

export interface CitizenComplaintAgainstAuthority {
  id: string;
  complaintRef: string;
  citizenUid: string;
  citizenName: string;
  isAnonymous: boolean;
  subject: string;
  relatedReportId?: string;
  targetDepartment: string;
  targetOfficerUid?: string;
  targetOfficerName?: string;
  category: string;
  description: string;
  evidenceFiles: UploadedFileRef[];
  status: ComplaintBoxStatus;
  reviewerUid?: string;
  reviewerName?: string;
  internalNotes: Array<{ id: string; author: string; note: string; createdAt: string }>;
  publicUpdates: Array<{ id: string; actor: string; message: string; status: ComplaintBoxStatus; createdAt: string }>;
  finalResolution?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlatformNotification {
  id: string;
  targetType: 'citizen' | 'authority' | 'officer' | 'supervisor';
  targetUid?: string;
  targetDepartment?: string;
  type: string;
  priority: 'normal' | 'high' | 'emergency';
  title: string;
  message: string;
  relatedType?: 'report' | 'sos' | 'medical' | 'complaint' | 'escalation';
  relatedId?: string;
  read: boolean;
  createdAt: string;
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
  designation: string;
  role: AuthorityRole;
  expiresAt: number;
}

interface PersistedState {
  sessionSecret?: string;
  authorityPasscodeHash?: string;
  authorityPasscodeSalt?: string;
  slaConfig?: SlaConfig;
  idempotencyKeys?: Record<string, string>;
  reports: OperationalReportRecord[];
  sosEvents: OperationalSosRecord[];
  medicalRequests: MedicalRequestRecord[];
  citizenComplaints: CitizenComplaintAgainstAuthority[];
  officers: OfficerProfile[];
  caregivers: CaregiverRecord[];
  callLogs: CallLogEntry[];
  notifications: PlatformNotification[];
  smsLogs: SmsLogEntry[];
  auditLogs: AuditLogEntry[];
  trackingSessions?: Record<string, LiveTrackingRecord>;
}

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'seva-operational.json');

const activeTracking = new Map<string, LiveTrackingRecord>();
const authoritySessions = new Map<string, AuthoritySession>();

export const DEFAULT_SLA_CONFIG: SlaConfig = {
  bySeverity: {
    Critical: { responseMinutes: 60, resolutionMinutes: 360 },
    High: { responseMinutes: 240, resolutionMinutes: 1440 },
    Medium: { responseMinutes: 720, resolutionMinutes: 2880 },
    Low: { responseMinutes: 1440, resolutionMinutes: 4320 },
  },
  byCategoryOverride: {},
};

function migrateLegacyStatus(raw: string): OperationalReportStatus {
  switch (raw) {
    case 'Submitted':
      return 'Submitted';
    case 'Under Verification':
    case 'Awaiting Evidence':
    case 'AI Verification Pending':
      return 'AI Verification Pending';
    case 'Verified':
    case 'Authority Acknowledged':
      return 'Verified';
    case 'Rejected':
    case 'Rejected with reason':
      return 'Rejected with reason';
    case 'Assigned':
      return 'Assigned';
    case 'In Progress':
      return 'In Progress';
    case 'Awaiting Authority Review':
    case 'Resolved – Awaiting Verification':
      return 'Resolved – Awaiting Verification';
    case 'Resolved':
    case 'Verified Resolution':
      return 'Verified Resolution';
    case 'Reopened':
      return 'Reopened';
    case 'Escalated':
      return 'Escalated';
    default:
      return 'Submitted';
  }
}

function loadState(): PersistedState {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      const loadedTracking =
        parsed.trackingSessions && typeof parsed.trackingSessions === 'object' ? parsed.trackingSessions : {};
      for (const [k, v] of Object.entries(loadedTracking)) {
        if (v && v.shareToken) activeTracking.set(k, v);
      }
      const reports = Array.isArray(parsed.reports)
        ? parsed.reports.map((r) => ({
            ...r,
            status: migrateLegacyStatus(String(r.status || 'Submitted')),
          }))
        : [];
      return {
        sessionSecret: parsed.sessionSecret,
        authorityPasscodeHash: parsed.authorityPasscodeHash,
        authorityPasscodeSalt: parsed.authorityPasscodeSalt,
        slaConfig: parsed.slaConfig || structuredClone(DEFAULT_SLA_CONFIG),
        idempotencyKeys:
          parsed.idempotencyKeys && typeof parsed.idempotencyKeys === 'object' ? parsed.idempotencyKeys : {},
        reports,
        sosEvents: Array.isArray(parsed.sosEvents) ? parsed.sosEvents : [],
        medicalRequests: Array.isArray(parsed.medicalRequests) ? parsed.medicalRequests : [],
        citizenComplaints: Array.isArray(parsed.citizenComplaints) ? parsed.citizenComplaints : [],
        officers: Array.isArray(parsed.officers) ? parsed.officers : [],
        caregivers: Array.isArray(parsed.caregivers) ? parsed.caregivers : [],
        callLogs: Array.isArray(parsed.callLogs) ? parsed.callLogs : [],
        notifications: Array.isArray(parsed.notifications) ? parsed.notifications : [],
        smsLogs: Array.isArray(parsed.smsLogs) ? parsed.smsLogs : [],
        auditLogs: Array.isArray(parsed.auditLogs) ? parsed.auditLogs : [],
        trackingSessions: loadedTracking,
      };
    }
  } catch (err) {
    console.error('Failed to load operational store:', err);
  }
  return {
    slaConfig: structuredClone(DEFAULT_SLA_CONFIG),
    idempotencyKeys: {},
    reports: [],
    sosEvents: [],
    medicalRequests: [],
    citizenComplaints: [],
    officers: [],
    caregivers: [],
    callLogs: [],
    notifications: [],
    smsLogs: [],
    auditLogs: [],
    trackingSessions: {},
  };
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

export function getSlaConfig(): SlaConfig {
  if (!state.slaConfig) {
    state.slaConfig = structuredClone(DEFAULT_SLA_CONFIG);
  }
  return state.slaConfig;
}

export function updateSlaConfig(nextConfig: SlaConfig): SlaConfig {
  state.slaConfig = {
    bySeverity: {
      ...DEFAULT_SLA_CONFIG.bySeverity,
      ...(nextConfig.bySeverity || {}),
    },
    byCategoryOverride: nextConfig.byCategoryOverride || state.slaConfig?.byCategoryOverride || {},
  };
  persistState();
  return state.slaConfig;
}

export function computeSlaDeadlines(
  severity: string,
  isEmergency: boolean,
  createdIso: string,
  category?: string
) {
  const baseMs = new Date(createdIso).getTime() || Date.now();
  const cfg = getSlaConfig();
  const sevKey: 'Low' | 'Medium' | 'High' | 'Critical' =
    isEmergency || severity === 'Critical'
      ? 'Critical'
      : severity === 'High'
      ? 'High'
      : severity === 'Medium'
      ? 'Medium'
      : 'Low';

  const catRule = category ? cfg.byCategoryOverride?.[category]?.[sevKey] : undefined;
  const sevRule = cfg.bySeverity[sevKey] || DEFAULT_SLA_CONFIG.bySeverity[sevKey];
  const responseMinutes = Math.max(0.02, catRule?.responseMinutes ?? sevRule.responseMinutes);
  const resolutionMinutes = Math.max(0.04, catRule?.resolutionMinutes ?? sevRule.resolutionMinutes);

  return {
    slaResponseDeadlineAt: new Date(baseMs + responseMinutes * 60_000).toISOString(),
    slaDeadlineAt: new Date(baseMs + resolutionMinutes * 60_000).toISOString(),
  };
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

export function recomputeOfficerWorkloads() {
  for (const officer of state.officers) {
    const activeCount = state.reports.filter(
      (r) =>
        (r.assignedOfficerUid === officer.uid ||
          (r.assignedOfficer && r.assignedOfficer.toLowerCase() === officer.name.toLowerCase())) &&
        !SLA_PAUSED_OR_CLOSED_STATUSES.has(r.status)
    ).length;
    officer.activeWorkload = activeCount;
  }
}

export function upsertOfficerProfile(profile: Omit<OfficerProfile, 'activeWorkload'>): OfficerProfile {
  const idx = state.officers.findIndex(
    (o) => o.uid === profile.uid || o.email.toLowerCase() === profile.email.toLowerCase()
  );
  if (idx >= 0) {
    const existing = state.officers[idx];
    state.officers[idx] = {
      ...existing,
      ...profile,
      uid: existing.uid,
      availability: profile.availability || existing.availability || 'available',
    };
  } else {
    state.officers.push({
      ...profile,
      activeWorkload: 0,
    });
  }
  recomputeOfficerWorkloads();
  persistState();
  return state.officers.find((o) => o.email.toLowerCase() === profile.email.toLowerCase() || o.uid === profile.uid)!;
}

export function getOfficers(department?: string): OfficerProfile[] {
  recomputeOfficerWorkloads();
  if (!department || department === 'All Departments') {
    return state.officers;
  }
  return state.officers.filter(
    (o) => o.department === department || o.department === 'Emergency Control Room' || o.role === 'admin'
  );
}

export function updateOfficerAvailability(uid: string, availability: OfficerProfile['availability']): OfficerProfile | null {
  const idx = state.officers.findIndex((o) => o.uid === uid);
  if (idx < 0) return null;
  state.officers[idx].availability = availability;
  state.officers[idx].lastActiveAt = new Date().toISOString();
  persistState();
  return state.officers[idx];
}

export function createAuthoritySession(params: {
  uid: string;
  email: string;
  name: string;
  department: string;
  jurisdiction: string;
  designation?: string;
  roleChoice?: AuthorityRole;
  phone?: string;
  isAdmin: boolean;
}): AuthoritySession {
  const expiresAt = Date.now() + 8 * 60 * 60 * 1000;
  const role: AuthorityRole = params.isAdmin
    ? 'admin'
    : params.roleChoice === 'supervisor'
    ? 'supervisor'
    : 'authority';
  const designation =
    params.designation?.trim() ||
    (role === 'admin' ? 'Platform Administrator' : role === 'supervisor' ? 'Department Supervisor' : 'Field Authority Officer');

  const claims = {
    uid: params.uid,
    email: params.email,
    name: params.name,
    department: params.department,
    jurisdiction: params.jurisdiction,
    designation,
    role,
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
    designation,
    role: claims.role,
    expiresAt,
  };
  authoritySessions.set(token, session);

  upsertOfficerProfile({
    uid: claims.uid,
    name: claims.name,
    email: claims.email,
    department: claims.department,
    role: claims.role,
    designation,
    jurisdiction: claims.jurisdiction,
    phone: params.phone,
    availability: 'available',
    lastActiveAt: new Date().toISOString(),
  });

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
    const role: AuthorityRole =
      parsed.role === 'admin' ? 'admin' : parsed.role === 'supervisor' ? 'supervisor' : 'authority';
    const session: AuthoritySession = {
      token,
      uid: parsed.uid,
      email: parsed.email || '',
      name: parsed.name || 'Authority Officer',
      department: parsed.department,
      jurisdiction: parsed.jurisdiction || 'Citywide',
      designation: parsed.designation || 'Authority Officer',
      role,
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
  if (state.auditLogs.length > 800) state.auditLogs.length = 800;
  persistState();
  return full;
}

export function getAuditLogs(): AuditLogEntry[] {
  return state.auditLogs;
}

export function addPlatformNotification(
  n: Omit<PlatformNotification, 'id' | 'read' | 'createdAt'>
): PlatformNotification {
  const full: PlatformNotification = {
    ...n,
    id: `NTF-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
    read: false,
    createdAt: new Date().toISOString(),
  };
  state.notifications.unshift(full);
  if (state.notifications.length > 1000) state.notifications.length = 1000;
  persistState();
  return full;
}

export function getNotificationsForCitizen(uid: string): PlatformNotification[] {
  return state.notifications.filter((n) => n.targetType === 'citizen' && n.targetUid === uid);
}

export function getNotificationsForAuthority(session: AuthoritySession): PlatformNotification[] {
  return state.notifications.filter((n) => {
    if (n.targetType === 'authority') {
      if (
        !n.targetDepartment ||
        session.role === 'admin' ||
        session.department === 'All Departments' ||
        session.department === 'Emergency Control Room'
      ) {
        return true;
      }
      return n.targetDepartment === session.department;
    }
    if (n.targetType === 'officer' && n.targetUid === session.uid) return true;
    if (n.targetType === 'supervisor' && (session.role === 'supervisor' || session.role === 'admin')) {
      if (!n.targetDepartment || session.role === 'admin') return true;
      return n.targetDepartment === session.department;
    }
    return false;
  });
}

export function markNotificationRead(id: string): PlatformNotification | null {
  const item = state.notifications.find((n) => n.id === id);
  if (!item) return null;
  item.read = true;
  persistState();
  return item;
}

export function markAllNotificationsRead(matcher: (n: PlatformNotification) => boolean) {
  let count = 0;
  for (const n of state.notifications) {
    if (!n.read && matcher(n)) {
      n.read = true;
      count += 1;
    }
  }
  if (count > 0) persistState();
  return count;
}

export function addSmsLog(entry: SmsLogEntry): SmsLogEntry {
  state.smsLogs.unshift(entry);
  if (state.smsLogs.length > 500) state.smsLogs.length = 500;
  persistState();
  return entry;
}

export function getSmsLogs(): SmsLogEntry[] {
  return state.smsLogs;
}

export function getSmsLogById(id: string): SmsLogEntry | null {
  return state.smsLogs.find((s) => s.id === id) || null;
}

export function updateSmsLogById(
  id: string,
  status: SmsLogEntry['status'],
  error?: string
): SmsLogEntry | null {
  const idx = state.smsLogs.findIndex((s) => s.id === id);
  if (idx < 0) return null;
  const next = { ...state.smsLogs[idx], status, updatedAt: new Date().toISOString() };
  if (error) next.error = error;
  else if (status === 'delivered' || status === 'sent') delete next.error;
  state.smsLogs[idx] = next;
  persistState();
  return state.smsLogs[idx];
}

export function updateSmsLogByProviderId(
  providerMessageId: string,
  status: SmsLogEntry['status'],
  error?: string
): SmsLogEntry | null {
  const idx = state.smsLogs.findIndex((s) => s.providerMessageId === providerMessageId);
  if (idx < 0) return null;
  const next = { ...state.smsLogs[idx], status, updatedAt: new Date().toISOString() };
  if (error) next.error = error;
  else if (status === 'delivered' || status === 'sent') delete next.error;
  state.smsLogs[idx] = next;
  persistState();
  return state.smsLogs[idx];
}

// Caregivers & Call Logging
export function getCaregiversByUid(uid: string): CaregiverRecord[] {
  return state.caregivers.filter((c) => c.uid === uid);
}

export function upsertCaregiver(rec: CaregiverRecord): { record: CaregiverRecord; created: boolean } {
  const existingIdx = state.caregivers.findIndex(
    (c) => (c.id === rec.id) || (c.uid === rec.uid && c.phone === rec.phone)
  );
  if (existingIdx >= 0) {
    state.caregivers[existingIdx] = {
      ...state.caregivers[existingIdx],
      ...rec,
      id: state.caregivers[existingIdx].id,
      createdAt: state.caregivers[existingIdx].createdAt,
      updatedAt: rec.updatedAt,
    };
    persistState();
    return { record: state.caregivers[existingIdx], created: false };
  }
  state.caregivers.unshift(rec);
  persistState();
  return { record: rec, created: true };
}

export function deleteCaregiver(uid: string, id: string): boolean {
  const before = state.caregivers.length;
  state.caregivers = state.caregivers.filter((c) => !(c.uid === uid && (c.id === id || c.phone === id)));
  if (state.caregivers.length !== before) {
    persistState();
    return true;
  }
  return false;
}

export function addCallLog(entry: Omit<CallLogEntry, 'id' | 'createdAt'>): CallLogEntry {
  const full: CallLogEntry = {
    ...entry,
    id: `call_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
    createdAt: new Date().toISOString(),
  };
  state.callLogs.unshift(full);
  if (state.callLogs.length > 500) state.callLogs.length = 500;
  persistState();
  return full;
}

export function getCallLogsByUid(uid: string): CallLogEntry[] {
  return state.callLogs.filter((c) => c.uid === uid);
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

export function findReportByIdempotencyKey(key: string): OperationalReportRecord | undefined {
  if (!key) return undefined;
  const reportId = state.idempotencyKeys?.[key];
  if (!reportId) return undefined;
  return getOperationalReportById(reportId);
}

export function registerIdempotencyKey(key: string, reportId: string) {
  if (!key || !reportId) return;
  if (!state.idempotencyKeys) state.idempotencyKeys = {};
  state.idempotencyKeys[key] = reportId;
  persistState();
}

export function upsertOperationalReport(report: OperationalReportRecord): OperationalReportRecord {
  const nowIso = report.createdAt || new Date().toISOString();
  const sla = computeSlaDeadlines(report.severity, report.isEmergency, nowIso, report.category);
  const referenceNumber =
    report.referenceNumber || `REF-${report.complaintId.replace(/^SEVA-/, '')}`;

  const defaultVerificationStatus: VerificationStatus =
    report.verificationStatus ||
    (report.fraudQueueStatus === 'rejected'
      ? 'Rejected'
      : report.fraudQueueStatus === 'restricted_queue' || report.fraudQueueStatus === 'investigation_queue'
      ? 'Flagged for Manual Review'
      : 'Pending Verification');

  const normalizedStatus = migrateLegacyStatus(String(report.status || 'Submitted'));

  const normalized: OperationalReportRecord = {
    ...report,
    status: normalizedStatus,
    referenceNumber,
    verificationStatus: defaultVerificationStatus,
    fraudProbability: report.fraudProbability ?? Number(((report.fraudRiskScore || 0) / 100).toFixed(2)),
    evidenceCompleteness:
      report.evidenceCompleteness || (report.photoDataUrl || report.photoUrls?.length ? 'Complete' : 'Partial'),
    assignmentHistory: report.assignmentHistory || [],
    disputeHistory: report.disputeHistory || [],
    escalations: report.escalations || [],
    escalationLevel: report.escalationLevel || 0,
    citizenEvidenceUploads: report.citizenEvidenceUploads || [],
    photoUrls: report.photoUrls || [],
    slaDeadlineAt: report.slaDeadlineAt || sla.slaDeadlineAt,
    slaResponseDeadlineAt: report.slaResponseDeadlineAt || sla.slaResponseDeadlineAt,
  };

  const idx = state.reports.findIndex((r) => r.id === normalized.id || r.complaintId === normalized.complaintId);
  if (idx >= 0) {
    state.reports[idx] = { ...state.reports[idx], ...normalized };
  } else {
    state.reports.unshift(normalized);
  }
  if (normalized.idempotencyKey) {
    if (!state.idempotencyKeys) state.idempotencyKeys = {};
    state.idempotencyKeys[normalized.idempotencyKey] = normalized.id;
  }
  recomputeOfficerWorkloads();
  persistState();
  return state.reports.find((r) => r.id === normalized.id || r.complaintId === normalized.complaintId)!;
}

export function getActiveReportsForSlaCheck(): OperationalReportRecord[] {
  return state.reports.filter((r) => !SLA_PAUSED_OR_CLOSED_STATUSES.has(r.status));
}

export function getOperationalReports(filters?: {
  department?: string;
  category?: string;
  status?: string;
  severity?: string;
  verificationStatus?: string;
  search?: string;
  onlyOverdue?: boolean;
  onlyReopened?: boolean;
  onlyEmergency?: boolean;
  onlyEscalated?: boolean;
  onlyUnassigned?: boolean;
  fraudQueue?: 'operational' | 'fraud_review' | 'all';
  includeSensitive?: boolean;
}): OperationalReportRecord[] {
  const q = filters?.search?.trim().toLowerCase() || '';
  const nowMs = Date.now();
  return state.reports.filter((r) => {
    if (!filters?.includeSensitive && r.isSensitive) return false;
    if (filters?.fraudQueue === 'operational') {
      if (
        (r.fraudQueueStatus === 'restricted_queue' ||
          r.fraudQueueStatus === 'investigation_queue' ||
          r.fraudQueueStatus === 'rejected') &&
        !r.isEmergency
      ) {
        return false;
      }
    } else if (filters?.fraudQueue === 'fraud_review') {
      if (
        r.fraudQueueStatus === 'cleared' &&
        r.verificationStatus !== 'Flagged for Manual Review' &&
        r.verificationStatus !== 'Rejected' &&
        r.status !== 'AI Verification Pending'
      ) {
        return false;
      }
    }
    if (filters?.department && filters.department !== 'All Departments' && r.department !== filters.department) {
      return false;
    }
    if (filters?.category && filters.category !== 'All' && r.category !== filters.category) return false;
    if (filters?.status && filters.status !== 'All' && r.status !== filters.status) return false;
    if (filters?.severity && filters.severity !== 'All' && r.severity !== filters.severity) return false;
    if (filters?.verificationStatus && filters.verificationStatus !== 'All' && r.verificationStatus !== filters.verificationStatus) {
      return false;
    }
    if (filters?.onlyEmergency && !r.isEmergency) return false;
    if (filters?.onlyUnassigned && (r.assignedOfficer || r.assignedOfficerUid)) return false;
    if (filters?.onlyEscalated && r.status !== 'Escalated' && !(r.escalations && r.escalations.length > 0)) {
      return false;
    }
    if (filters?.onlyReopened && r.status !== 'Reopened' && !(r.disputeHistory && r.disputeHistory.length > 0)) {
      return false;
    }
    if (filters?.onlyOverdue) {
      const isOpen = !SLA_PAUSED_OR_CLOSED_STATUSES.has(r.status);
      const breached = r.slaDeadlineAt ? new Date(r.slaDeadlineAt).getTime() < nowMs : false;
      if (!isOpen || !breached) return false;
    }
    if (q) {
      const hay = [
        r.complaintId,
        r.referenceNumber || '',
        r.title,
        r.category,
        r.department,
        r.address,
        r.locality,
        r.ward,
        r.reporterDisplayName,
        r.assignedOfficer || '',
      ]
        .join(' ')
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export function getOperationalReportById(id: string): OperationalReportRecord | undefined {
  return state.reports.find(
    (r) =>
      r.id === id ||
      r.complaintId.toLowerCase() === id.toLowerCase() ||
      (r.referenceNumber && r.referenceNumber.toLowerCase() === id.toLowerCase())
  );
}

export function updateOperationalReport(
  id: string,
  updater: (existing: OperationalReportRecord) => OperationalReportRecord
): OperationalReportRecord | null {
  const idx = state.reports.findIndex(
    (r) =>
      r.id === id ||
      r.complaintId.toLowerCase() === id.toLowerCase() ||
      (r.referenceNumber && r.referenceNumber.toLowerCase() === id.toLowerCase())
  );
  if (idx < 0) return null;
  state.reports[idx] = updater(state.reports[idx]);
  recomputeOfficerWorkloads();
  persistState();
  return state.reports[idx];
}

export function upsertOperationalSos(sos: OperationalSosRecord): OperationalSosRecord {
  const idx = state.sosEvents.findIndex((s) => s.id === sos.id);
  if (idx >= 0) state.sosEvents[idx] = { ...state.sosEvents[idx], ...sos };
  else state.sosEvents.unshift(sos);
  persistState();
  return state.sosEvents.find((s) => s.id === sos.id)!;
}

export function getOperationalSosEvents(): OperationalSosRecord[] {
  return state.sosEvents;
}

export function updateOperationalSos(
  id: string,
  updater: (existing: OperationalSosRecord) => OperationalSosRecord
): OperationalSosRecord | null {
  const idx = state.sosEvents.findIndex((s) => s.id === id);
  if (idx < 0) return null;
  state.sosEvents[idx] = updater(state.sosEvents[idx]);
  persistState();
  return state.sosEvents[idx];
}

// Independent Medical Assistance Collection
export function upsertMedicalRequest(rec: MedicalRequestRecord): MedicalRequestRecord {
  const idx = state.medicalRequests.findIndex((m) => m.id === rec.id || m.trackingId === rec.trackingId);
  if (idx >= 0) state.medicalRequests[idx] = { ...state.medicalRequests[idx], ...rec };
  else state.medicalRequests.unshift(rec);
  persistState();
  return state.medicalRequests.find((m) => m.id === rec.id)!;
}

export function getMedicalRequests(uid?: string): MedicalRequestRecord[] {
  if (!uid) return state.medicalRequests;
  return state.medicalRequests.filter((m) => m.uid === uid);
}

export function updateMedicalRequest(
  id: string,
  updater: (existing: MedicalRequestRecord) => MedicalRequestRecord
): MedicalRequestRecord | null {
  const idx = state.medicalRequests.findIndex((m) => m.id === id || m.trackingId === id);
  if (idx < 0) return null;
  state.medicalRequests[idx] = updater(state.medicalRequests[idx]);
  persistState();
  return state.medicalRequests[idx];
}

// Independent Citizen Complaint Box Against Authority
export function createCitizenComplaint(
  rec: CitizenComplaintAgainstAuthority
): CitizenComplaintAgainstAuthority {
  state.citizenComplaints.unshift(rec);
  persistState();
  return rec;
}

export function getCitizenComplaintsByUid(uid: string): CitizenComplaintAgainstAuthority[] {
  return state.citizenComplaints.filter((c) => c.citizenUid === uid);
}

export function getCitizenComplaintById(id: string): CitizenComplaintAgainstAuthority | undefined {
  return state.citizenComplaints.find((c) => c.id === id || c.complaintRef === id);
}

export function getAuthorityComplaintsForSession(session: AuthoritySession): CitizenComplaintAgainstAuthority[] {
  return state.citizenComplaints.filter((c) => {
    const isTarget =
      (c.targetOfficerUid && c.targetOfficerUid === session.uid) ||
      (c.targetOfficerName && c.targetOfficerName.trim().toLowerCase() === session.name.trim().toLowerCase());
    if (isTarget) return false;
    if (session.role === 'admin') return true;
    if (session.role === 'supervisor') {
      return (
        c.targetDepartment === session.department ||
        c.reviewerUid === session.uid ||
        session.department === 'All Departments' ||
        session.department === 'Platform Administration'
      );
    }
    return c.reviewerUid === session.uid;
  });
}

export function updateCitizenComplaint(
  id: string,
  updater: (existing: CitizenComplaintAgainstAuthority) => CitizenComplaintAgainstAuthority
): CitizenComplaintAgainstAuthority | null {
  const idx = state.citizenComplaints.findIndex((c) => c.id === id || c.complaintRef === id);
  if (idx < 0) return null;
  state.citizenComplaints[idx] = updater(state.citizenComplaints[idx]);
  persistState();
  return state.citizenComplaints[idx];
}

export function getPublicHeatmapIncidents() {
  const approved = state.reports.filter(
    (r) =>
      r.fraudQueueStatus !== 'rejected' &&
      r.fraudQueueStatus !== 'investigation_queue' &&
      r.status !== 'Rejected with reason'
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

// Authority Accountability, Performance Index, Leaderboard & Analytics Engine
export function computePerformanceAndAnalytics(filters?: {
  period?: '7d' | '30d' | '90d' | 'all';
  department?: string;
}) {
  recomputeOfficerWorkloads();
  const nowMs = Date.now();
  const periodDays =
    filters?.period === '7d' ? 7 : filters?.period === '30d' ? 30 : filters?.period === '90d' ? 90 : null;
  const cutoffMs = periodDays ? nowMs - periodDays * 86400_000 : 0;

  const allReports = state.reports.filter((r) => {
    if (cutoffMs && new Date(r.createdAt).getTime() < cutoffMs) return false;
    if (filters?.department && filters.department !== 'All Departments' && r.department !== filters.department) {
      return false;
    }
    return true;
  });

  const isResolvedStatus = (st: string) =>
    st === 'Verified Resolution' || st === 'Resolved – Awaiting Verification';

  const officerList =
    filters?.department && filters.department !== 'All Departments'
      ? state.officers.filter(
          (o) =>
            o.department === filters.department ||
            o.department === 'All Departments' ||
            o.role === 'admin'
        )
      : state.officers;

  const officerMetrics = officerList.map((officer) => {
    const handled = allReports.filter(
      (r) =>
        r.assignedOfficerUid === officer.uid ||
        r.resolutionEvidence?.resolvingOfficerUid === officer.uid ||
        (r.assignedOfficer && r.assignedOfficer.toLowerCase() === officer.name.toLowerCase()) ||
        (r.resolutionEvidence?.resolvingOfficer &&
          r.resolutionEvidence.resolvingOfficer.toLowerCase() === officer.name.toLowerCase())
    );

    const resolved = handled.filter((r) => isResolvedStatus(r.status));
    const evidenceVerified = resolved.filter(
      (r) =>
        r.resolutionEvidence &&
        r.resolutionEvidence.afterPhotos.length > 0 &&
        (r.status === 'Verified Resolution' || r.resolutionEvidence.approvalStatus === 'approved')
    );
    const reopenedCount = handled.filter(
      (r) => r.status === 'Reopened' || (r.disputeHistory && r.disputeHistory.length > 0)
    ).length;
    const overdueCount = handled.filter(
      (r) =>
        !SLA_PAUSED_OR_CLOSED_STATUSES.has(r.status) &&
        r.slaDeadlineAt &&
        new Date(r.slaDeadlineAt).getTime() < nowMs
    ).length;

    const resolutionHoursArr = resolved
      .map((r) => {
        const end = r.resolutionEvidence?.completedAt || r.updatedAt;
        const ms = new Date(end).getTime() - new Date(r.createdAt).getTime();
        return ms > 0 ? ms / 3600_000 : 0;
      })
      .filter((h) => h > 0);
    const avgResolutionHours = resolutionHoursArr.length
      ? Number((resolutionHoursArr.reduce((a, b) => a + b, 0) / resolutionHoursArr.length).toFixed(1))
      : 0;

    const ratings = handled.map((r) => r.feedbackRating).filter((x): x is number => typeof x === 'number');
    const avgCitizenRating = ratings.length
      ? Number((ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(2))
      : null;

    const totalCount = handled.length;
    const qualityRatio = resolved.length > 0 ? evidenceVerified.length / resolved.length : 0;
    const timelinessScore =
      totalCount === 0
        ? 0
        : Math.max(0, 25 - Math.min(25, overdueCount * 6) - (avgResolutionHours > 48 ? 6 : 0));
    const qualityScore = Math.round(qualityRatio * 35);
    const citizenScore =
      totalCount === 0
        ? 0
        : avgCitizenRating !== null
        ? Math.round((avgCitizenRating / 5) * 20)
        : resolved.length > 0
        ? 12
        : 8;
    const completionRatio = totalCount > 0 ? Math.min(1, resolved.length / totalCount) : 0;
    const resolutionVolumeScore = Math.round(completionRatio * 20);
    const reopenPenalty = Math.min(25, reopenedCount * 10);

    // Zero-case officers strictly receive 0 (never an inflated default 50!)
    const rawIndex =
      totalCount === 0
        ? 0
        : Math.max(
            0,
            Math.min(100, qualityScore + timelinessScore + citizenScore + resolutionVolumeScore - reopenPenalty)
          );

    const qualifiedForRanking = totalCount >= 2;
    const badges: string[] = [];
    if (evidenceVerified.length >= 2 && reopenedCount === 0 && rawIndex >= 80) badges.push('Civic Champion');
    if (resolved.length >= 1 && avgResolutionHours > 0 && avgResolutionHours <= 12) badges.push('Quick Responder');
    if (evidenceVerified.length >= 1) badges.push('Resolution Expert');
    if (rawIndex >= 85 && overdueCount === 0 && handled.length >= 2) badges.push('Public Service Excellence');
    if (avgCitizenRating !== null && avgCitizenRating >= 4.2 && reopenedCount === 0) badges.push('Citizen Trust Builder');

    return {
      uid: officer.uid,
      name: officer.name,
      email: officer.email,
      department: officer.department,
      role: officer.role,
      designation: officer.designation,
      availability: officer.availability,
      activeWorkload: officer.activeWorkload,
      totalHandled: totalCount,
      resolvedCount: resolved.length,
      evidenceVerifiedCount: evidenceVerified.length,
      reopenedCount,
      overdueCount,
      avgResolutionHours,
      avgCitizenRating,
      performanceIndex: rawIndex,
      qualifiedForRanking,
      badges,
    };
  });

  // Fair leaderboard sort: qualified officers with real resolved/handled cases rank ahead of 0-case officers
  officerMetrics.sort(
    (a, b) =>
      Number(Boolean(b.qualifiedForRanking)) - Number(Boolean(a.qualifiedForRanking)) ||
      (b.totalHandled > 0 ? 1 : 0) - (a.totalHandled > 0 ? 1 : 0) ||
      b.performanceIndex - a.performanceIndex ||
      b.evidenceVerifiedCount - a.evidenceVerifiedCount ||
      b.resolvedCount - a.resolvedCount
  );

  const deptNames = Array.from(
    new Set([...allReports.map((r) => r.department), ...state.officers.map((o) => o.department)])
  ).filter((d) => {
    if (!d || d === 'All Departments') return false;
    if (filters?.department && filters.department !== 'All Departments') return d === filters.department;
    return true;
  });

  const departmentRankings = deptNames.map((dept) => {
    const deptReports = allReports.filter((r) => r.department === dept);
    const resolved = deptReports.filter((r) => isResolvedStatus(r.status));
    const pending = deptReports.filter((r) => !SLA_PAUSED_OR_CLOSED_STATUSES.has(r.status));
    const reopenedCount = deptReports.filter(
      (r) => r.status === 'Reopened' || (r.disputeHistory && r.disputeHistory.length > 0)
    ).length;
    const overdueCount = pending.filter((r) => r.slaDeadlineAt && new Date(r.slaDeadlineAt).getTime() < nowMs).length;
    const withinSlaResolved = resolved.filter(
      (r) => !r.slaDeadlineAt || new Date(r.updatedAt).getTime() <= new Date(r.slaDeadlineAt).getTime()
    ).length;
    const slaComplianceRate =
      deptReports.length === 0
        ? 100
        : Math.round(((deptReports.length - overdueCount) / deptReports.length) * 100);
    const avgResolutionHours = resolved.length
      ? Number(
          (
            resolved.reduce(
              (acc, r) => acc + Math.max(0, (new Date(r.updatedAt).getTime() - new Date(r.createdAt).getTime()) / 3600_000),
              0
            ) / resolved.length
          ).toFixed(1)
        )
      : 0;
    const ratings = deptReports.map((r) => r.feedbackRating).filter((x): x is number => typeof x === 'number');
    const avgCitizenRating = ratings.length
      ? Number((ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(2))
      : null;

    const evidenceBackedCount = resolved.filter(
      (r) => r.resolutionEvidence && r.resolutionEvidence.afterPhotos.length > 0
    ).length;
    const baseScore =
      deptReports.length === 0
        ? 0
        : Math.max(
            0,
            Math.min(
              100,
              Math.round(
                slaComplianceRate * 0.4 +
                  (resolved.length / deptReports.length) * 30 +
                  (resolved.length > 0 ? evidenceBackedCount / resolved.length : 0.3) * 20 +
                  (withinSlaResolved > 0 ? 10 : 5) -
                  reopenedCount * 8
              )
            )
          );

    return {
      department: dept,
      totalReports: deptReports.length,
      pendingCount: pending.length,
      resolvedCount: resolved.length,
      reopenedCount,
      overdueCount,
      slaComplianceRate,
      avgResolutionHours,
      avgCitizenRating,
      departmentScore: baseScore,
    };
  });

  departmentRankings.sort((a, b) => b.departmentScore - a.departmentScore || b.totalReports - a.totalReports);

  const byCategory: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  for (const r of allReports) {
    byCategory[r.category] = (byCategory[r.category] || 0) + 1;
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  }

  const last7Days: Array<{ date: string; label: string; total: number; submitted: number; resolved: number }> = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(nowMs - i * 86400_000);
    const dayStr = d.toISOString().slice(0, 10);
    const subCount = allReports.filter((r) => String(r.createdAt).startsWith(dayStr)).length;
    const resCount = allReports.filter((r) => isResolvedStatus(r.status) && String(r.updatedAt).startsWith(dayStr)).length;
    last7Days.push({
      date: dayStr,
      label: dayStr.slice(5),
      total: subCount,
      submitted: subCount,
      resolved: resCount,
    });
  }

  const last30Days: Array<{ date: string; label: string; total: number; submitted: number; resolved: number }> = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(nowMs - i * 86400_000);
    const dayStr = d.toISOString().slice(0, 10);
    const subCount = allReports.filter((r) => String(r.createdAt).startsWith(dayStr)).length;
    const resCount = allReports.filter((r) => isResolvedStatus(r.status) && String(r.updatedAt).startsWith(dayStr)).length;
    last30Days.push({
      date: dayStr,
      label: dayStr.slice(5),
      total: subCount,
      submitted: subCount,
      resolved: resCount,
    });
  }

  const resolvedReportsAll = allReports.filter((r) => isResolvedStatus(r.status));
  const resolutionRate =
    allReports.length > 0 ? Math.round((resolvedReportsAll.length / allReports.length) * 100) : 0;
  const overallAvgResolutionHours = resolvedReportsAll.length
    ? Number(
        (
          resolvedReportsAll.reduce((acc, r) => {
            const end = r.resolutionEvidence?.completedAt || r.updatedAt;
            return acc + Math.max(0, (new Date(end).getTime() - new Date(r.createdAt).getTime()) / 3600_000);
          }, 0) / resolvedReportsAll.length
        ).toFixed(1)
      )
    : 0;

  return {
    officerLeaderboard: officerMetrics,
    departmentRankings,
    byCategory,
    byStatus,
    last7Days,
    last30Days,
    analytics: {
      totalReports: allReports.length,
      resolvedCount: resolvedReportsAll.length,
      resolutionRate,
      avgResolutionHours: overallAvgResolutionHours,
      byCategory,
      byStatus,
      last7Days,
      last30Days,
    },
    totals: {
      reports: allReports.length,
      resolved: resolvedReportsAll.length,
      verifiedResolution: allReports.filter((r) => r.status === 'Verified Resolution').length,
      reopened: allReports.filter((r) => r.status === 'Reopened').length,
      overdue: allReports.filter(
        (r) => !SLA_PAUSED_OR_CLOSED_STATUSES.has(r.status) && r.slaDeadlineAt && new Date(r.slaDeadlineAt).getTime() < nowMs
      ).length,
      escalated: allReports.filter((r) => r.status === 'Escalated' || (r.escalations && r.escalations.length > 0)).length,
      medicalTotal: state.medicalRequests.length,
      sosTotal: state.sosEvents.length,
      complaintsAgainstAuthority: state.citizenComplaints.length,
    },
  };
}
