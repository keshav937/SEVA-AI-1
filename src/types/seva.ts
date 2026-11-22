export type AppTab =
  | 'home'
  | 'explore'
  | 'report'
  | 'shield'
  | 'medical'
  | 'complaints'
  | 'heatmap'
  | 'rewards'
  | 'reports'
  | 'profile'
  | 'authority';

export type SupportedLanguage = 'en' | 'hi' | 'bn' | 'as';

export type CivicCategory =
  | 'Roads and Potholes'
  | 'Waste Management'
  | 'Blocked Drains and Waterlogging'
  | 'Traffic and Road Obstructions'
  | 'Medical Assistance'
  | 'Women and Child Safety'
  | 'Animal Rescue and Welfare';

export type SeverityLevel = 'Low' | 'Medium' | 'High' | 'Critical';

export const REPORT_STATUS_FLOW = [
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

export type ReportStatus = (typeof REPORT_STATUS_FLOW)[number];

export type VerificationStatus =
  | 'Pending Verification'
  | 'Verified'
  | 'Flagged for Manual Review'
  | 'Rejected';

export type FraudRiskLevel = 'Low' | 'Moderate' | 'High' | 'Critical';
export type FraudQueueStatus =
  | 'cleared'
  | 'validation_needed'
  | 'restricted_queue'
  | 'investigation_queue'
  | 'rejected';

export type AuthorityRole = 'authority' | 'supervisor' | 'admin';

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
  bySeverity: Record<SeverityLevel, SlaRule>;
  byCategoryOverride: Record<string, Partial<Record<SeverityLevel, SlaRule>>>;
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

export interface UserProfile {
  uid: string;
  email: string;
  fullName: string;
  displayName: string;
  phone?: string;
  city?: string;
  ward?: string;
  role: 'citizen' | 'authority' | 'supervisor' | 'admin';
  department?: string;
  points: number;
  verifiedReportsCount: number;
  resolvedReportsCount: number;
  badgeTier: string;
  badges: string[];
  dpdpConsent: boolean;
  createdAt?: any;
  updatedAt?: any;
}

export interface LeaderboardEntry {
  uid: string;
  displayName: string;
  city: string;
  ward: string;
  points: number;
  verifiedReportsCount: number;
  resolvedReportsCount: number;
  badgeTier: string;
  badges: string[];
  updatedAt?: any;
}

export interface CivicReport {
  id: string;
  complaintId: string;
  referenceNumber?: string;
  idempotencyKey?: string;
  reporterUid: string;
  reporterDisplayName: string;
  reporterPhone?: string;
  smsUpdatesOptIn?: boolean;
  category: CivicCategory | string;
  title: string;
  description: string;
  severity: SeverityLevel;
  status: ReportStatus;
  department: string;
  ward?: string;
  locality?: string;
  address: string;
  lat: number;
  lng: number;
  accuracyMeters?: number;
  isEmergency: boolean;
  isSensitive: boolean;
  photoDataUrl?: string;
  photoUrls?: UploadedFileRef[];
  citizenEvidenceUploads?: UploadedFileRef[];
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
  fraudRiskLevel: FraudRiskLevel;
  fraudIndicators?: string[];
  fraudExplanation?: string;
  evidenceCompleteness?: 'Complete' | 'Partial' | 'Minimal';
  recommendedActionText?: string;
  fraudQueueStatus: FraudQueueStatus;
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
  timeline?: Array<{
    step: string;
    label: string;
    actorRole: string;
    note?: string;
    timestamp: string;
  }>;
  createdAt?: any;
  updatedAt?: any;
}

export interface ReportAnalysisResponse {
  suggestedCategory: string;
  aiDetectedCategory?: string;
  suggestedSeverity: SeverityLevel;
  recommendedDepartment: string;
  summary: string;
  confidence: number;
  imageMatchesDescription: boolean;
  detectedIssueFromImage: string;
  duplicateCheckResult?: string;
  isDuplicate?: boolean;
  missingInfoFlags?: string[];
  recommendedAction?: 'accept' | 'flag' | 'reject';
  fraudRiskScore: number;
  fraudProbability?: number;
  fraudRiskLevel: FraudRiskLevel;
  fraudIndicators: string[];
  fraudExplanation: string;
  evidenceCompleteness?: 'Complete' | 'Partial' | 'Minimal';
  recommendedActionText?: string;
  recommendedQueueAction:
    | 'normal_routing'
    | 'additional_validation'
    | 'restricted_verification_queue'
    | 'fraud_investigation_queue';
  qualityNotes: string;
  imageHash?: string;
}

export interface NearbyPlace {
  id: string;
  name: string;
  category: string;
  subcategory: string;
  address: string;
  lat: number;
  lng: number;
  distanceMeters: number;
  phone?: string;
  openingHours?: string;
  website?: string;
  directionsUrl: string;
}

export interface EmergencyContact {
  id: string;
  uid: string;
  name: string;
  phone: string;
  relation: string;
  consentGiven: boolean;
  createdAt?: any;
  updatedAt?: any;
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

export type SmsEventType =
  | 'caregiver_added'
  | 'sos_activated'
  | 'medical_request'
  | 'complaint_status_updated'
  | 'resolution_completed'
  | 'safety_alert'
  | 'sos'
  | 'medical';

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

export interface SosEvent {
  id: string;
  uid: string;
  displayName: string;
  status: 'active' | 'acknowledged' | 'responder_assigned' | 'safe_resolved' | 'completed' | 'cancelled';
  lat: number;
  lng: number;
  accuracyMeters?: number;
  address?: string;
  triggerMethod: 'button_hold' | 'voice_phrase';
  notifiedContactsCount: number;
  authorityNotified: boolean;
  deliverySummary?: string;
  smsSummary?: string;
  smsLogs?: SmsLogEntry[];
  assignedResponder?: string;
  responseNotes?: string;
  trackingSessionId?: string;
  createdAt?: any;
  updatedAt?: any;
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

export interface MedicalRequest {
  id: string;
  uid: string;
  trackingId: string;
  patientCondition: string;
  severity: 'Urgent' | 'Critical';
  lat: number;
  lng: number;
  address: string;
  nearestHospital?: string;
  status: 'Received' | 'Authority Notified' | 'Acknowledged' | 'Assigned' | 'On the Way' | 'Resolved';
  createdAt?: any;
  updatedAt?: any;
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
  internalNotes?: Array<{ id: string; author: string; note: string; createdAt: string }>;
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

export interface UserNotification {
  id: string;
  uid: string;
  type: string;
  priority?: 'normal' | 'high' | 'emergency';
  title: string;
  message: string;
  relatedId?: string;
  relatedType?: string;
  read: boolean;
  createdAt?: any;
}

export interface OfficerPerformanceMetric {
  uid: string;
  name: string;
  email: string;
  department: string;
  role: AuthorityRole;
  designation: string;
  availability: 'available' | 'busy' | 'off_duty';
  activeWorkload: number;
  totalHandled: number;
  resolvedCount: number;
  evidenceVerifiedCount: number;
  reopenedCount: number;
  overdueCount: number;
  avgResolutionHours: number;
  avgCitizenRating: number | null;
  performanceIndex: number;
  qualifiedForRanking?: boolean;
  badges: string[];
}

export interface DepartmentPerformanceMetric {
  department: string;
  totalReports: number;
  pendingCount: number;
  resolvedCount: number;
  reopenedCount: number;
  overdueCount: number;
  slaComplianceRate: number;
  avgResolutionHours: number;
  avgCitizenRating: number | null;
  departmentScore: number;
}

export interface AwardCandidate {
  id: string;
  uid: string;
  displayName: string;
  city: string;
  ward?: string;
  points: number;
  verifiedReportsCount: number;
  status: 'nominated' | 'verified' | 'shortlisted' | 'honoree' | 'disqualified';
  reviewerNote?: string;
  createdAt?: any;
  updatedAt?: any;
}

export interface AuthoritySessionInfo {
  token: string;
  uid: string;
  name: string;
  role: AuthorityRole;
  department: string;
  jurisdiction: string;
  designation?: string;
  expiresAt: number;
}

export interface VoiceDraftPayload {
  category?: string;
  title?: string;
  description?: string;
  severity?: SeverityLevel;
  locationMentioned?: string;
}
