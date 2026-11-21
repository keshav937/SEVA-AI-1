export type AppTab =
  | 'home'
  | 'explore'
  | 'report'
  | 'shield'
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
  | 'Road Accident Reporting'
  | 'Medical Assistance'
  | 'Women and Child Safety'
  | 'Animal Rescue and Welfare';

export type SeverityLevel = 'Low' | 'Medium' | 'High' | 'Critical';

export type ReportStatus =
  | 'Submitted'
  | 'Authority Acknowledged'
  | 'Assigned'
  | 'In Progress'
  | 'Resolved'
  | 'Rejected';

export type FraudRiskLevel = 'Low' | 'Moderate' | 'High' | 'Critical';
export type FraudQueueStatus =
  | 'cleared'
  | 'validation_needed'
  | 'restricted_queue'
  | 'investigation_queue'
  | 'rejected';

export interface UserProfile {
  uid: string;
  email: string;
  fullName: string;
  displayName: string;
  phone?: string;
  city?: string;
  ward?: string;
  role: 'citizen' | 'authority' | 'admin';
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
  reporterUid: string;
  reporterDisplayName: string;
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
  hasVideo?: boolean;
  videoName?: string;
  aiSummary?: string;
  aiSuggestedCategory?: string;
  aiSuggestedSeverity?: string;
  aiConfidence?: number;
  fraudRiskScore: number;
  fraudRiskLevel: FraudRiskLevel;
  fraudIndicators?: string[];
  fraudExplanation?: string;
  fraudQueueStatus: FraudQueueStatus;
  assignedOfficer?: string;
  actionNotes?: string;
  resolutionNotes?: string;
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
  suggestedSeverity: SeverityLevel;
  recommendedDepartment: string;
  summary: string;
  confidence: number;
  imageMatchesDescription: boolean;
  detectedIssueFromImage: string;
  fraudRiskScore: number;
  fraudRiskLevel: FraudRiskLevel;
  fraudIndicators: string[];
  fraudExplanation: string;
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

export interface SosEvent {
  id: string;
  uid: string;
  displayName: string;
  status: 'active' | 'safe_resolved' | 'cancelled';
  lat: number;
  lng: number;
  accuracyMeters?: number;
  address?: string;
  triggerMethod: 'button_hold' | 'voice_phrase';
  notifiedContactsCount: number;
  authorityNotified: boolean;
  deliverySummary?: string;
  trackingSessionId?: string;
  createdAt?: any;
  updatedAt?: any;
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

export interface UserNotification {
  id: string;
  uid: string;
  type: string;
  title: string;
  message: string;
  relatedId?: string;
  read: boolean;
  createdAt?: any;
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
  role: 'authority' | 'admin';
  department: string;
  jurisdiction: string;
  expiresAt: number;
}

export interface VoiceDraftPayload {
  category?: string;
  title?: string;
  description?: string;
  severity?: SeverityLevel;
  locationMentioned?: string;
}
