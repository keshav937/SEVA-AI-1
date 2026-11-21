import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export type AuthorityRole = 'authority' | 'supervisor' | 'admin';

export type OperationalReportStatus =
  | 'Submitted'
  | 'Under Verification'
  | 'Verified'
  | 'Authority Acknowledged'
  | 'Assigned'
  | 'In Progress'
  | 'Awaiting Evidence'
  | 'Awaiting Authority Review'
  | 'Resolved'
  | 'Rejected'
  | 'Reopened';

export type VerificationStatus =
  | 'Pending Verification'
  | 'Verified'
  | 'Flagged for Manual Review'
  | 'Rejected';

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
  status: 'open' | 'acknowledged' | 'resolved';
  createdAt: string;
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
  reporterUid: string;
  reporterDisplayName: string;
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
  aiSuggestedSeverity?: string;
  aiConfidence?: number;
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
  slaDeadlineAt?: string;
  slaResponseDeadlineAt?: string;
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
  emergencyType: 'sos' | 'medical' | 'accident';
  recipientName: string;
  recipientPhone: string;
  message: string;
  provider: string;
  status: 'sent' | 'pending' | 'failed' | 'not_configured';
  attempts: number;
  providerMessageId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
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

export interface AccidentRequestRecord {
  id: string;
  trackingId: string;
  uid: string;
  citizenName: string;
  citizenEmail?: string;
  description: string;
  severity: 'Moderate' | 'Severe' | 'Critical';
  peopleAffected: number;
  lat: number;
  lng: number;
  accuracyMeters?: number;
  address: string;
  photoUrls: UploadedFileRef[];
  nearestHospital?: string;
  nearestPolice?: string;
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
  relatedType?: 'report' | 'sos' | 'medical' | 'accident' | 'complaint' | 'escalation';
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
  reports: OperationalReportRecord[];
  sosEvents: OperationalSosRecord[];
  medicalRequests: MedicalRequestRecord[];
  accidentRequests: AccidentRequestRecord[];
  citizenComplaints: CitizenComplaintAgainstAuthority[];
  officers: OfficerProfile[];
  notifications: PlatformNotification[];
  smsLogs: SmsLogEntry[];
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
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
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
        medicalRequests: Array.isArray(parsed.medicalRequests) ? parsed.medicalRequests : [],
        accidentRequests: Array.isArray(parsed.accidentRequests) ? parsed.accidentRequests : [],
        citizenComplaints: Array.isArray(parsed.citizenComplaints) ? parsed.citizenComplaints : [],
        officers: Array.isArray(parsed.officers) ? parsed.officers : [],
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
    reports: [],
    sosEvents: [],
    medicalRequests: [],
    accidentRequests: [],
    citizenComplaints: [],
    officers: [],
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

export function computeSlaDeadlines(severity: string, isEmergency: boolean, createdIso: string) {
  const baseMs = new Date(createdIso).getTime() || Date.now();
  let responseHours = 24;
  let resolutionHours = 72;
  if (isEmergency || severity === 'Critical') {
    responseHours = 1;
    resolutionHours = 6;
  } else if (severity === 'High') {
    responseHours = 4;
    resolutionHours = 24;
  } else if (severity === 'Medium') {
    responseHours = 12;
    resolutionHours = 48;
  }
  return {
    slaResponseDeadlineAt: new Date(baseMs + responseHours * 3600_000).toISOString(),
    slaDeadlineAt: new Date(baseMs + resolutionHours * 3600_000).toISOString(),
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
        r.status !== 'Resolved' &&
        r.status !== 'Rejected'
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
      if (!n.targetDepartment || session.role === 'admin' || session.department === 'All Departments' || session.department === 'Emergency Control Room') {
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
  const nowIso = report.createdAt || new Date().toISOString();
  const sla = computeSlaDeadlines(report.severity, report.isEmergency, nowIso);
  const referenceNumber =
    report.referenceNumber ||
    `REF-${report.complaintId.replace(/^SEVA-/, '')}`;

  const defaultVerificationStatus: VerificationStatus =
    report.verificationStatus ||
    (report.fraudQueueStatus === 'rejected'
      ? 'Rejected'
      : report.fraudQueueStatus === 'restricted_queue' || report.fraudQueueStatus === 'investigation_queue'
      ? 'Flagged for Manual Review'
      : 'Pending Verification');

  const normalized: OperationalReportRecord = {
    ...report,
    referenceNumber,
    verificationStatus: defaultVerificationStatus,
    fraudProbability: report.fraudProbability ?? Number(((report.fraudRiskScore || 0) / 100).toFixed(2)),
    evidenceCompleteness: report.evidenceCompleteness || (report.photoDataUrl || report.photoUrls?.length ? 'Complete' : 'Partial'),
    assignmentHistory: report.assignmentHistory || [],
    disputeHistory: report.disputeHistory || [],
    escalations: report.escalations || [],
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
  recomputeOfficerWorkloads();
  persistState();
  return state.reports.find((r) => r.id === normalized.id || r.complaintId === normalized.complaintId)!;
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
  fraudQueue?: 'operational' | 'fraud_review' | 'all';
  includeSensitive?: boolean;
}): OperationalReportRecord[] {
  const q = filters?.search?.trim().toLowerCase() || '';
  const nowMs = Date.now();
  return state.reports.filter((r) => {
    if (!filters?.includeSensitive && r.isSensitive) return false;
    if (filters?.fraudQueue === 'operational') {
      if ((r.fraudQueueStatus === 'restricted_queue' || r.fraudQueueStatus === 'investigation_queue' || r.fraudQueueStatus === 'rejected') && !r.isEmergency) {
        return false;
      }
    } else if (filters?.fraudQueue === 'fraud_review') {
      if (r.fraudQueueStatus === 'cleared' && r.verificationStatus !== 'Flagged for Manual Review' && r.verificationStatus !== 'Rejected') {
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
    if (filters?.onlyReopened && r.status !== 'Reopened' && !(r.disputeHistory && r.disputeHistory.length > 0)) {
      return false;
    }
    if (filters?.onlyOverdue) {
      const isOpen = r.status !== 'Resolved' && r.status !== 'Rejected';
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

// Independent Road Accident Collection
export function upsertAccidentRequest(rec: AccidentRequestRecord): AccidentRequestRecord {
  const idx = state.accidentRequests.findIndex((a) => a.id === rec.id || a.trackingId === rec.trackingId);
  if (idx >= 0) state.accidentRequests[idx] = { ...state.accidentRequests[idx], ...rec };
  else state.accidentRequests.unshift(rec);
  persistState();
  return state.accidentRequests.find((a) => a.id === rec.id)!;
}

export function getAccidentRequests(uid?: string): AccidentRequestRecord[] {
  if (!uid) return state.accidentRequests;
  return state.accidentRequests.filter((a) => a.uid === uid);
}

export function updateAccidentRequest(
  id: string,
  updater: (existing: AccidentRequestRecord) => AccidentRequestRecord
): AccidentRequestRecord | null {
  const idx = state.accidentRequests.findIndex((a) => a.id === id || a.trackingId === id);
  if (idx < 0) return null;
  state.accidentRequests[idx] = updater(state.accidentRequests[idx]);
  persistState();
  return state.accidentRequests[idx];
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
  // Confidentiality & Conflict of Interest Isolation:
  // A target officer can NEVER read or review complaints filed against themselves!
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
export function computePerformanceAndAnalytics() {
  recomputeOfficerWorkloads();
  const nowMs = Date.now();
  const allReports = state.reports;

  // Build officer metrics strictly from real registered/authenticated officers
  const officerMetrics = state.officers.map((officer) => {
    const handled = allReports.filter(
      (r) =>
        r.assignedOfficerUid === officer.uid ||
        r.resolutionEvidence?.resolvingOfficerUid === officer.uid ||
        (r.assignedOfficer && r.assignedOfficer.toLowerCase() === officer.name.toLowerCase()) ||
        (r.resolutionEvidence?.resolvingOfficer &&
          r.resolutionEvidence.resolvingOfficer.toLowerCase() === officer.name.toLowerCase())
    );

    const resolved = handled.filter((r) => r.status === 'Resolved');
    const evidenceVerified = resolved.filter(
      (r) =>
        r.resolutionEvidence &&
        r.resolutionEvidence.beforePhotos.length > 0 &&
        r.resolutionEvidence.afterPhotos.length > 0 &&
        r.resolutionEvidence.approvalStatus === 'approved'
    );
    const reopenedCount = handled.filter(
      (r) => r.status === 'Reopened' || (r.disputeHistory && r.disputeHistory.length > 0)
    ).length;
    const overdueCount = handled.filter(
      (r) =>
        r.status !== 'Resolved' &&
        r.status !== 'Rejected' &&
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

    // Multi-factor Performance Index (0-100) — never rewards empty Resolve clicks!
    // Weighs: Verified Resolution Evidence Quality (35), Timeliness & SLA (25), Citizen Satisfaction (20), Verification Integrity (10), Minus Reopened/Overdue Penalties
    const totalCount = handled.length;
    const qualityRatio = resolved.length > 0 ? evidenceVerified.length / resolved.length : 0;
    const timelinessScore =
      totalCount === 0
        ? 50
        : Math.max(0, 25 - Math.min(25, overdueCount * 6) - (avgResolutionHours > 48 ? 6 : 0));
    const qualityScore = Math.round(qualityRatio * 35);
    const citizenScore = avgCitizenRating !== null ? Math.round((avgCitizenRating / 5) * 20) : resolved.length > 0 ? 12 : 10;
    const completionRatio = totalCount > 0 ? Math.min(1, resolved.length / totalCount) : 0;
    const resolutionVolumeScore = Math.round(completionRatio * 20);
    const reopenPenalty = Math.min(25, reopenedCount * 10);

    const rawIndex =
      totalCount === 0
        ? 50
        : Math.max(0, Math.min(100, qualityScore + timelinessScore + citizenScore + resolutionVolumeScore - reopenPenalty));

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
      badges,
    };
  });

  officerMetrics.sort((a, b) => b.performanceIndex - a.performanceIndex || b.evidenceVerifiedCount - a.evidenceVerifiedCount);

  // Department Rankings from real report records
  const deptNames = Array.from(
    new Set([
      ...allReports.map((r) => r.department),
      ...state.officers.map((o) => o.department),
    ])
  ).filter((d) => d && d !== 'All Departments');

  const departmentRankings = deptNames.map((dept) => {
    const deptReports = allReports.filter((r) => r.department === dept);
    const resolved = deptReports.filter((r) => r.status === 'Resolved');
    const pending = deptReports.filter((r) => r.status !== 'Resolved' && r.status !== 'Rejected');
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
        ? 60
        : Math.max(
            0,
            Math.min(
              100,
              Math.round(
                (slaComplianceRate * 0.4) +
                  ((resolved.length / deptReports.length) * 30) +
                  ((resolved.length > 0 ? evidenceBackedCount / resolved.length : 0.5) * 20) +
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

  departmentRankings.sort((a, b) => b.departmentScore - a.departmentScore);

  // Category & Status Breakdown + Daily/Weekly Trends
  const byCategory: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  for (const r of allReports) {
    byCategory[r.category] = (byCategory[r.category] || 0) + 1;
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  }

  const last7Days: Array<{ date: string; submitted: number; resolved: number }> = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(nowMs - i * 86400_000);
    const dayStr = d.toISOString().slice(0, 10);
    last7Days.push({
      date: dayStr,
      submitted: allReports.filter((r) => String(r.createdAt).startsWith(dayStr)).length,
      resolved: allReports.filter((r) => r.status === 'Resolved' && String(r.updatedAt).startsWith(dayStr)).length,
    });
  }

  return {
    officerLeaderboard: officerMetrics,
    departmentRankings,
    byCategory,
    byStatus,
    last7Days,
    totals: {
      reports: allReports.length,
      resolved: allReports.filter((r) => r.status === 'Resolved').length,
      reopened: allReports.filter((r) => r.status === 'Reopened').length,
      overdue: allReports.filter(
        (r) => r.status !== 'Resolved' && r.status !== 'Rejected' && r.slaDeadlineAt && new Date(r.slaDeadlineAt).getTime() < nowMs
      ).length,
      escalated: allReports.filter((r) => r.escalations && r.escalations.length > 0).length,
      medicalTotal: state.medicalRequests.length,
      accidentTotal: state.accidentRequests.length,
      sosTotal: state.sosEvents.length,
      complaintsAgainstAuthority: state.citizenComplaints.length,
    },
  };
}
