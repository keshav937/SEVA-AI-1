import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Award,
  BarChart3,
  Bell,
  Building2,
  Camera,
  Car,
  CheckCircle2,
  Clock,
  FileText,
  FileWarning,
  HeartPulse,
  KeyRound,
  Layers,
  Lock,
  MapPin,
  PawPrint,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  TrendingUp,
  UserCheck,
  UserPlus,
  Users,
  Volume2,
} from 'lucide-react';
import { doc, getDoc, increment, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { useAuth } from '../contexts/AuthContext';
import { db } from '../lib/firebase';
import {
  AccidentRequestRecord,
  AuthorityRole,
  CitizenComplaintAgainstAuthority,
  CivicReport,
  DepartmentPerformanceMetric,
  MedicalRequestRecord,
  OfficerPerformanceMetric,
  OfficerProfile,
  PlatformNotification,
  ReportStatus,
  SmsLogEntry,
  SosEvent,
  UploadedFileRef,
} from '../types/seva';
import { LeafletMap } from './LeafletMap';

type AuthorityModule =
  | 'overview'
  | 'reports'
  | 'verification'
  | 'sos'
  | 'medical'
  | 'accident'
  | 'animal_rescue'
  | 'assignments'
  | 'progress'
  | 'evidence'
  | 'complaints'
  | 'departments'
  | 'leaderboard'
  | 'escalations'
  | 'notifications'
  | 'analytics'
  | 'logs';

const DEPARTMENTS = [
  'All Departments',
  'Municipal Corporation',
  'Public Works Department',
  'Traffic Police',
  'Police Department',
  'Emergency Control Room',
  'Medical Services',
  'Animal Welfare & Rescue',
  'Platform Administration',
];

const DEPT_RECOMMENDATIONS: Record<string, string> = {
  'Roads and Potholes': 'Public Works Department',
  'Waste Management': 'Municipal Corporation',
  'Blocked Drains and Waterlogging': 'Municipal Corporation',
  'Traffic and Road Obstructions': 'Traffic Police',
  'Road Accident Reporting': 'Emergency Control Room',
  'Medical Assistance': 'Medical Services',
  'Women and Child Safety': 'Police Department',
  'Animal Rescue and Welfare': 'Animal Welfare & Rescue',
};

function mapOperationalToFirestoreStatus(
  status: ReportStatus
): 'Submitted' | 'Authority Acknowledged' | 'Assigned' | 'In Progress' | 'Resolved' | 'Rejected' {
  if (status === 'Under Verification' || status === 'Verified') return 'Authority Acknowledged';
  if (status === 'Awaiting Evidence' || status === 'Awaiting Authority Review' || status === 'Reopened') {
    return 'In Progress';
  }
  return status as any;
}

function computeTierFromCount(verifiedCount: number): string {
  if (verifiedCount >= 50) return 'Platinum Guardian';
  if (verifiedCount >= 25) return 'Gold Citizen';
  if (verifiedCount >= 10) return 'Silver Citizen';
  if (verifiedCount >= 1) return 'Bronze Citizen';
  return 'New Citizen';
}

function categoryBadgeFor(category: string): string | null {
  switch (category) {
    case 'Waste Management':
    case 'Blocked Drains and Waterlogging':
      return 'Clean City Champion';
    case 'Roads and Potholes':
    case 'Traffic and Road Obstructions':
      return 'Road Safety Guardian';
    case 'Medical Assistance':
      return 'Public Health Protector';
    case 'Animal Rescue and Welfare':
      return 'Animal Welfare Champion';
    case 'Women and Child Safety':
      return 'Safety Hero';
    case 'Road Accident Reporting':
      return 'Emergency Response Contributor';
    default:
      return null;
  }
}

interface AuthorityDashboardViewProps {
  onSpeakText: (text: string) => void;
  externalModuleRequest?: { module: AuthorityModule; id: number } | null;
}

export const AuthorityDashboardView: React.FC<AuthorityDashboardViewProps> = ({
  onSpeakText,
  externalModuleRequest,
}) => {
  const {
    firebaseUser,
    profile,
    authoritySession,
    verifyAuthorityAccess,
    clearAuthoritySession,
    signInWithGoogle,
    logout,
    signingIn,
    authError,
  } = useAuth();

  // Auth Gate Form State
  const [passcodeConfigured, setPasscodeConfigured] = useState<boolean | null>(null);
  const [setupPasscode, setSetupPasscode] = useState('');
  const [department, setDepartment] = useState('Municipal Corporation');
  const [jurisdiction, setJurisdiction] = useState('Central & Citywide');
  const [roleChoice, setRoleChoice] = useState<AuthorityRole>('supervisor');
  const [designation, setDesignation] = useState('Municipal Supervisor');
  const [officerPhone, setOfficerPhone] = useState('');
  const [officerEmail, setOfficerEmail] = useState('');
  const [officerNameInput, setOfficerNameInput] = useState('');
  const [passcodeInput, setPasscodeInput] = useState('');
  const [authMsg, setAuthMsg] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

  // Module Navigation & Filters
  const [activeModule, setActiveModule] = useState<AuthorityModule>('overview');
  const [statusFilter, setStatusFilter] = useState('All');
  const [severityFilter, setSeverityFilter] = useState('All');
  const [categoryFilter, setCategoryFilter] = useState('All');
  const [searchQuery, setSearchQuery] = useState('');
  const [quickFilter, setQuickFilter] = useState<'none' | 'overdue' | 'reopened' | 'emergency'>('none');

  // Core Operational Data
  const [reports, setReports] = useState<CivicReport[]>([]);
  const [stats, setStats] = useState<Record<string, number>>({});
  const [sosEvents, setSosEvents] = useState<SosEvent[]>([]);
  const [medicalRequests, setMedicalRequests] = useState<MedicalRequestRecord[]>([]);
  const [accidentRequests, setAccidentRequests] = useState<AccidentRequestRecord[]>([]);
  const [officers, setOfficers] = useState<OfficerProfile[]>([]);
  const [smsLogs, setSmsLogs] = useState<SmsLogEntry[]>([]);
  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [complaintsBox, setComplaintsBox] = useState<CitizenComplaintAgainstAuthority[]>([]);
  const [authNotifications, setAuthNotifications] = useState<PlatformNotification[]>([]);
  const [perfData, setPerfData] = useState<{
    officerLeaderboard: OfficerPerformanceMetric[];
    departmentRankings: DepartmentPerformanceMetric[];
    analytics: {
      totalReports: number;
      resolvedCount: number;
      resolutionRate: number;
      avgResolutionHours: number;
      animalRescueTotal?: number;
      byCategory: Record<string, number>;
      byStatus: Record<string, number>;
      last7Days: Array<{ date: string; label: string; total: number; resolved: number }>;
      last30Days?: Array<{ date: string; label: string; total: number; resolved: number }>;
    };
  } | null>(null);

  // Selected Items & Action States
  const [selectedReport, setSelectedReport] = useState<CivicReport | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Verification Controls
  const [verifyNote, setVerifyNote] = useState('');
  const [evidenceRequestNote, setEvidenceRequestNote] = useState('');

  // Assignment Controls
  const [assignOfficerUid, setAssignOfficerUid] = useState('');
  const [assignDept, setAssignDept] = useState('');
  const [assignReason, setAssignReason] = useState('');
  const [newOfficerName, setNewOfficerName] = useState('');
  const [newOfficerEmail, setNewOfficerEmail] = useState('');
  const [newOfficerDept, setNewOfficerDept] = useState('Public Works Department');
  const [newOfficerDesignation, setNewOfficerDesignation] = useState('Junior Engineer');
  const [newOfficerRole, setNewOfficerRole] = useState<AuthorityRole>('authority');

  // Work Progress & Resolution Evidence Gate
  const [nextStatus, setNextStatus] = useState<ReportStatus>('Authority Acknowledged');
  const [workNote, setWorkNote] = useState('');
  const [beforePhotos, setBeforePhotos] = useState<UploadedFileRef[]>([]);
  const [afterPhotos, setAfterPhotos] = useState<UploadedFileRef[]>([]);
  const [extraResPhotos, setExtraResPhotos] = useState<UploadedFileRef[]>([]);
  const [resolutionDesc, setResolutionDesc] = useState('');
  const [approvalNotes, setApprovalNotes] = useState('');

  // Escalation Controls
  const [escLevel, setEscLevel] = useState<1 | 2 | 3>(2);
  const [escReason, setEscReason] = useState('');

  // Emergency Dispatch Controls
  const [responderName, setResponderName] = useState('');
  const [responderNotes, setResponderNotes] = useState('');

  // Complaint Box Oversight Controls
  const [selectedComplaint, setSelectedComplaint] = useState<CitizenComplaintAgainstAuthority | null>(null);
  const [cmpReviewerUid, setCmpReviewerUid] = useState('');
  const [cmpStatus, setCmpStatus] = useState('Investigating');
  const [cmpInternalNote, setCmpInternalNote] = useState('');
  const [cmpPublicUpdate, setCmpPublicUpdate] = useState('');
  const [cmpResolution, setCmpResolution] = useState('');

  // Analytics Window Toggle
  const [trendWindow, setTrendWindow] = useState<'7d' | '30d'>('7d');

  useEffect(() => {
    if (externalModuleRequest?.module) {
      setActiveModule(externalModuleRequest.module);
    }
  }, [externalModuleRequest]);

  useEffect(() => {
    fetch('/api/auth/authority-config')
      .then((r) => r.json())
      .then((d) => setPasscodeConfigured(Boolean(d.passcodeConfigured)))
      .catch(() => setPasscodeConfigured(true));
  }, []);

  const authHeaders = useMemo(
    () =>
      authoritySession
        ? {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authoritySession.token}`,
          }
        : undefined,
    [authoritySession]
  );

  const fetchAllAuthorityData = useCallback(async () => {
    if (!authoritySession) return;
    const headers = { Authorization: `Bearer ${authoritySession.token}` };
    const qs = new URLSearchParams({
      fraudQueue: activeModule === 'verification' ? 'fraud_review' : 'all',
      status: statusFilter,
      severity: severityFilter,
      category: categoryFilter,
      search: searchQuery.trim(),
      onlyOverdue: quickFilter === 'overdue' ? 'true' : 'false',
      onlyReopened: quickFilter === 'reopened' ? 'true' : 'false',
      onlyEmergency: quickFilter === 'emergency' ? 'true' : 'false',
    });

    try {
      const [repRes, perfRes, cmpRes, notifRes] = await Promise.all([
        fetch(`/api/authority/reports?${qs.toString()}`, { headers }),
        fetch('/api/authority/performance', { headers }),
        fetch('/api/authority/complaints', { headers }),
        fetch('/api/notifications', { headers }),
      ]);

      if (repRes.status === 401) {
        clearAuthoritySession();
        setAuthMsg('Authority session expired. Please authenticate again.');
        return;
      }

      if (repRes.ok) {
        const repData = await repRes.json();
        const nextReports: CivicReport[] = repData.reports || [];
        setReports(nextReports);
        setStats(repData.stats || {});
        setSosEvents(repData.sosEvents || []);
        setMedicalRequests(repData.medicalRequests || []);
        setAccidentRequests(repData.accidentRequests || []);
        setOfficers(repData.officers || []);
        setSmsLogs(repData.smsLogs || []);
        setAuditLogs(repData.auditLogs || []);
        if (selectedReport) {
          const updatedSel = nextReports.find((r) => r.id === selectedReport.id);
          if (updatedSel) setSelectedReport(updatedSel);
        }
      }

      if (perfRes.ok) {
        setPerfData(await perfRes.json());
      }
      if (cmpRes.ok) {
        const cmpData = await cmpRes.json();
        setComplaintsBox(cmpData.complaints || []);
        if (selectedComplaint) {
          const updatedCmp = (cmpData.complaints || []).find(
            (c: CitizenComplaintAgainstAuthority) => c.id === selectedComplaint.id
          );
          if (updatedCmp) setSelectedComplaint(updatedCmp);
        }
      }
      if (notifRes.ok) {
        const nData = await notifRes.json();
        setAuthNotifications(nData.notifications || []);
      }
    } catch {
      // ignore transient polling error
    }
  }, [
    activeModule,
    authoritySession,
    categoryFilter,
    clearAuthoritySession,
    quickFilter,
    searchQuery,
    selectedComplaint,
    selectedReport,
    severityFilter,
    statusFilter,
  ]);

  useEffect(() => {
    fetchAllAuthorityData();
  }, [fetchAllAuthorityData]);

  // Real-time WebSocket updates for Authority Operations
  useEffect(() => {
    if (!authoritySession) return;
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}/ws`);
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'subscribe', topic: 'authority:all' }));
      ws.send(JSON.stringify({ type: 'subscribe', topic: `officer:${authoritySession.uid}` }));
    };
    ws.onmessage = () => {
      fetchAllAuthorityData();
    };
    return () => ws.close();
  }, [authoritySession, fetchAllAuthorityData]);

  const syncFirestoreSafe = async (updated: CivicReport, stepLabel: string, note: string, rewardResolve: boolean) => {
    try {
      await updateDoc(doc(db, 'reports', updated.id), {
        status: mapOperationalToFirestoreStatus(updated.status),
        fraudQueueStatus: updated.fraudQueueStatus,
        assignedOfficer: updated.assignedOfficer || '',
        actionNotes: updated.actionNotes || '',
        resolutionNotes: updated.resolutionNotes || '',
        updatedAt: serverTimestamp(),
      });
      const histId = `hist_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      await setDoc(doc(db, 'reportStatusHistory', histId), {
        reportId: updated.id,
        reporterUid: updated.reporterUid,
        step: stepLabel.toLowerCase().replace(/\s+/g, '_').slice(0, 60),
        label: stepLabel.slice(0, 120),
        actorRole: (authoritySession?.department || 'Authority').slice(0, 40),
        note: note.slice(0, 500),
        createdAt: serverTimestamp(),
      });

      if (rewardResolve && updated.status === 'Resolved' && updated.fraudQueueStatus !== 'rejected') {
        const userSnap = await getDoc(doc(db, 'users', updated.reporterUid));
        const userData = userSnap.exists() ? userSnap.data() : null;
        const nextVerified = Number(userData?.verifiedReportsCount || 0) + 1;
        const nextTier = computeTierFromCount(nextVerified);
        const existingBadges: string[] = Array.isArray(userData?.badges) ? userData.badges : [];
        const nextBadges = Array.from(
          new Set(
            [
              ...existingBadges,
              'First Report',
              categoryBadgeFor(updated.category),
              nextVerified >= 5 ? 'Consistent Citizen' : null,
            ].filter(Boolean) as string[]
          )
        ).slice(0, 20);
        await updateDoc(doc(db, 'users', updated.reporterUid), {
          points: increment(50),
          verifiedReportsCount: increment(1),
          resolvedReportsCount: increment(1),
          badgeTier: nextTier,
          badges: nextBadges,
          updatedAt: serverTimestamp(),
        });
        await updateDoc(doc(db, 'leaderboard', updated.reporterUid), {
          points: increment(50),
          verifiedReportsCount: increment(1),
          resolvedReportsCount: increment(1),
          badgeTier: nextTier,
          badges: nextBadges,
          updatedAt: serverTimestamp(),
        });
      }
    } catch {
      // Non-bootstrapped department accounts sync via backend operational ledger + WebSocket
    }
  };

  // Auth Gate Handlers
  const handleClaimFirstPasscode = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthMsg(null);
    const res = await fetch('/api/auth/claim-authority-passcode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: setupPasscode }),
    });
    const data = await res.json();
    if (!res.ok) {
      setAuthMsg(data.error || 'Unable to set department passcode.');
      return;
    }
    setPasscodeConfigured(true);
    setPasscodeInput(setupPasscode);
    setAuthMsg('Official department access code configured. You may now sign in below.');
  };

  const handleVerifySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthMsg(null);
    if (!firebaseUser && !officerEmail.trim()) {
      setAuthMsg('Please sign in with Google or enter your official department email address.');
      return;
    }
    setVerifying(true);
    try {
      await verifyAuthorityAccess({
        department,
        jurisdiction,
        designation,
        roleChoice,
        phone: officerPhone.trim() || undefined,
        passcode: passcodeInput,
        officerEmail: officerEmail.trim() || undefined,
        officerName: officerNameInput.trim() || undefined,
      });
    } catch (err: any) {
      setAuthMsg(err?.message || 'Verification failed.');
    } finally {
      setVerifying(false);
    }
  };

  // Upload Evidence Helper
  const uploadEvidenceFiles = async (
    files: FileList | null,
    setter: React.Dispatch<React.SetStateAction<UploadedFileRef[]>>,
    caption: string
  ) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    setActionErr(null);
    try {
      const form = new FormData();
      Array.from(files)
        .slice(0, 6)
        .forEach((f) => form.append('files', f));
      form.append('caption', caption);
      const res = await fetch('/api/uploads', { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed.');
      setter((prev) => [...prev, ...(data.files || [])]);
    } catch (err: any) {
      setActionErr(err?.message || 'File upload failed.');
    } finally {
      setBusy(false);
    }
  };

  // Report Action Handlers
  const handleVerifyDecision = async (
    report: CivicReport,
    decision: 'verify' | 'flag' | 'reject' | 'request_evidence'
  ) => {
    if (!authHeaders) return;
    setBusy(true);
    setActionMsg(null);
    setActionErr(null);
    try {
      const res = await fetch(`/api/authority/reports/${encodeURIComponent(report.id)}/verify`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          decision,
          notes: verifyNote.trim() || undefined,
          requestEvidenceNote: decision === 'request_evidence' ? evidenceRequestNote.trim() : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.report) throw new Error(data.error || 'Verification update failed.');
      setSelectedReport(data.report);
      setVerifyNote('');
      setEvidenceRequestNote('');
      setActionMsg(`Verification decision "${decision}" applied to ${data.report.complaintId}.`);
      await syncFirestoreSafe(data.report, `Verification: ${decision}`, verifyNote || evidenceRequestNote, false);
      await fetchAllAuthorityData();
    } catch (err: any) {
      setActionErr(err?.message || 'Verification request failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleAssignOfficer = async (report: CivicReport) => {
    if (!authHeaders) return;
    setBusy(true);
    setActionMsg(null);
    setActionErr(null);
    try {
      const chosenOfficer = officers.find((o) => o.uid === assignOfficerUid);
      const res = await fetch(`/api/authority/reports/${encodeURIComponent(report.id)}/assign`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          officerUid: chosenOfficer?.uid || undefined,
          officerName: chosenOfficer?.name || undefined,
          department: assignDept || DEPT_RECOMMENDATIONS[report.category] || report.department,
          reason: assignReason.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.report) throw new Error(data.error || 'Assignment failed.');
      setSelectedReport(data.report);
      setAssignReason('');
      setActionMsg(`Assigned ${data.report.complaintId} to ${data.report.assignedOfficer} (${data.report.department}).`);
      await syncFirestoreSafe(data.report, `Assigned to ${data.report.assignedOfficer}`, assignReason || 'Dispatched', false);
      await fetchAllAuthorityData();
    } catch (err: any) {
      setActionErr(err?.message || 'Unable to assign officer.');
    } finally {
      setBusy(false);
    }
  };

  const handleRegisterOfficer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!authHeaders) return;
    setBusy(true);
    setActionErr(null);
    setActionMsg(null);
    try {
      const res = await fetch('/api/authority/officers', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          name: newOfficerName,
          email: newOfficerEmail,
          department: newOfficerDept,
          designation: newOfficerDesignation,
          role: newOfficerRole,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not add officer.');
      setNewOfficerName('');
      setNewOfficerEmail('');
      setActionMsg(`Registered ${data.officer.name} (${data.officer.department}).`);
      await fetchAllAuthorityData();
    } catch (err: any) {
      setActionErr(err?.message || 'Officer registration failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleToggleAvailability = async (uid: string, availability: 'available' | 'busy' | 'off_duty') => {
    if (!authHeaders) return;
    try {
      const res = await fetch('/api/authority/officers/availability', {
        method: 'PATCH',
        headers: authHeaders,
        body: JSON.stringify({ uid, availability }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update availability.');
      await fetchAllAuthorityData();
    } catch (err: any) {
      setActionErr(err?.message || 'Availability update failed.');
    }
  };

  const handleManageProgressOrEvidence = async (report: CivicReport, submitForApproval = false) => {
    if (!authHeaders) return;
    setBusy(true);
    setActionMsg(null);
    setActionErr(null);
    try {
      const res = await fetch(`/api/authority/reports/${encodeURIComponent(report.id)}/manage`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          status: submitForApproval ? 'Awaiting Authority Review' : nextStatus,
          actionNotes: workNote.trim() || undefined,
          resolutionNotes:
            submitForApproval || nextStatus === 'Resolved' || nextStatus === 'Awaiting Authority Review'
              ? workNote.trim() || resolutionDesc.trim()
              : undefined,
          beforePhotos: beforePhotos.length > 0 ? beforePhotos : undefined,
          afterPhotos: afterPhotos.length > 0 ? afterPhotos : undefined,
          extraPhotos: extraResPhotos.length > 0 ? extraResPhotos : undefined,
          resolutionDescription: resolutionDesc.trim() || undefined,
          submitForApproval,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.report) throw new Error(data.error || 'Unable to save update.');
      setSelectedReport(data.report);
      setWorkNote('');
      setResolutionDesc('');
      setBeforePhotos([]);
      setAfterPhotos([]);
      setExtraResPhotos([]);
      setActionMsg(`Saved ${data.report.complaintId} -> ${data.report.status}.`);
      await syncFirestoreSafe(
        data.report,
        data.report.status,
        data.report.resolutionNotes || data.report.actionNotes || 'Status updated',
        data.report.status === 'Resolved'
      );
      await fetchAllAuthorityData();
    } catch (err: any) {
      setActionErr(err?.message || 'Update failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleApproveResolution = async (report: CivicReport, decision: 'approve' | 'request_rework') => {
    if (!authHeaders) return;
    setBusy(true);
    setActionMsg(null);
    setActionErr(null);
    try {
      const res = await fetch(`/api/authority/reports/${encodeURIComponent(report.id)}/approve-resolution`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ decision, approvalNotes: approvalNotes.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok || !data.report) throw new Error(data.error || 'Approval failed.');
      setSelectedReport(data.report);
      setApprovalNotes('');
      setActionMsg(
        decision === 'approve'
          ? `Approved final resolution for ${data.report.complaintId}.`
          : `Returned ${data.report.complaintId} to field team for rework.`
      );
      await syncFirestoreSafe(data.report, data.report.status, approvalNotes || decision, decision === 'approve');
      await fetchAllAuthorityData();
    } catch (err: any) {
      setActionErr(err?.message || 'Approval request failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleEscalateReport = async (report: CivicReport) => {
    if (!authHeaders) return;
    setBusy(true);
    setActionMsg(null);
    setActionErr(null);
    try {
      const res = await fetch(`/api/authority/reports/${encodeURIComponent(report.id)}/escalate`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ level: escLevel, reason: escReason.trim() }),
      });
      const data = await res.json();
      if (!res.ok || !data.report) throw new Error(data.error || 'Escalation failed.');
      setSelectedReport(data.report);
      setEscReason('');
      setActionMsg(`Escalated ${data.report.complaintId} to Level ${escLevel}.`);
      await fetchAllAuthorityData();
    } catch (err: any) {
      setActionErr(err?.message || 'Unable to escalate.');
    } finally {
      setBusy(false);
    }
  };

  const handleManageEmergency = async (kind: 'sos' | 'medical' | 'accident', id: string, status: string) => {
    if (!authHeaders) return;
    setBusy(true);
    setActionMsg(null);
    setActionErr(null);
    try {
      const res = await fetch(`/api/authority/emergencies/${kind}/${encodeURIComponent(id)}/manage`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          status,
          assignedResponder: responderName.trim() || authoritySession?.name,
          responseNotes: responderNotes.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Emergency update failed.');
      setResponderNotes('');
      setActionMsg(`Updated ${kind.toUpperCase()} status to "${status}".`);
      await fetchAllAuthorityData();
    } catch (err: any) {
      setActionErr(err?.message || 'Unable to update emergency.');
    } finally {
      setBusy(false);
    }
  };

  const handleManageComplaintBox = async (cmp: CitizenComplaintAgainstAuthority) => {
    if (!authHeaders) return;
    setBusy(true);
    setActionMsg(null);
    setActionErr(null);
    try {
      const chosenRev = officers.find((o) => o.uid === cmpReviewerUid);
      const res = await fetch(`/api/authority/complaints/${encodeURIComponent(cmp.id)}/manage`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          status: cmpStatus,
          reviewerUid: chosenRev?.uid || undefined,
          reviewerName: chosenRev?.name || undefined,
          internalNote: cmpInternalNote.trim() || undefined,
          publicUpdate: cmpPublicUpdate.trim() || undefined,
          finalResolution: cmpResolution.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.complaint) throw new Error(data.error || 'Unable to update oversight complaint.');
      setSelectedComplaint(data.complaint);
      setCmpInternalNote('');
      setCmpPublicUpdate('');
      setCmpResolution('');
      setActionMsg(`Updated Oversight Complaint ${data.complaint.complaintRef}.`);
      await fetchAllAuthorityData();
    } catch (err: any) {
      setActionErr(err?.message || 'Oversight update rejected.');
    } finally {
      setBusy(false);
    }
  };

  const handleMarkAuthNotifRead = async (id: string) => {
    if (!authHeaders) return;
    await fetch(`/api/notifications/${encodeURIComponent(id)}/read`, { method: 'POST', headers: authHeaders });
    await fetchAllAuthorityData();
  };

  const handleMarkAllAuthNotifsRead = async () => {
    if (!authHeaders) return;
    await fetch('/api/notifications/read-all', { method: 'POST', headers: authHeaders, body: '{}' });
    await fetchAllAuthorityData();
  };

  const speakDashboardBriefing = () => {
    const summary = `Authority Operations Briefing for ${authoritySession?.department}. Total reports: ${
      stats.total ?? 0
    }. Pending: ${stats.pending ?? 0}. Overdue SLA: ${stats.overdue ?? 0}. Active SOS: ${
      stats.activeSos ?? 0
    }, Medical: ${stats.activeMedical ?? 0}, Road Accidents: ${
      stats.activeAccidents ?? 0
    }. Pending verification: ${stats.underVerification ?? 0}.`;
    onSpeakText(summary);
  };

  // =========================================================================
  // ROLE-ISOLATED LOGIN GATE
  // =========================================================================
  const isLoggedCitizenOnly =
    Boolean(firebaseUser) &&
    profile?.role === 'citizen' &&
    firebaseUser?.email?.toLowerCase() !== 'guptakeshav2178@gmail.com';

  if (!authoritySession) {
    if (isLoggedCitizenOnly) {
      return (
        <div className="max-w-xl mx-auto border border-red-200 bg-red-50 rounded-2xl p-6 space-y-4">
          <div className="flex items-center gap-2.5 text-red-900 font-display text-lg font-bold">
            <Lock className="w-5 h-5" />
            Role Separation Active: Citizen Account Signed In
          </div>
          <p className="text-sm text-red-900 leading-relaxed">
            You are currently signed in with a <strong>Citizen</strong> session ({firebaseUser?.email}). Citizen sessions cannot open the Authority Operations Portal directly. Sign out of Citizen mode first to authenticate with official department credentials.
          </p>
          <button
            type="button"
            onClick={() => logout()}
            className="px-4 py-2.5 bg-red-700 text-white text-xs font-semibold rounded-lg hover:bg-red-800"
          >
            Sign Out of Citizen Session
          </button>
        </div>
      );
    }

    return (
      <div className="max-w-xl mx-auto space-y-6">
        <div>
          <h1 className="font-display text-2xl font-bold text-slate-900">
            Authority &amp; Department Command Portal
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Dedicated credential-verified access for municipal officers, supervisors, emergency dispatchers, and platform administrators.
          </p>
        </div>

        {!firebaseUser ? (
          <div className="border border-amber-200 bg-amber-50 rounded-xl p-4 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-xs text-amber-950">
                Sign in with your official Google account or enter your official department email + access code below.
              </span>
              <button
                type="button"
                disabled={signingIn}
                onClick={() => signInWithGoogle()}
                className="px-4 py-2 bg-green-900 text-white text-xs font-medium rounded-lg disabled:opacity-50"
              >
                {signingIn ? 'Signing in...' : 'Sign In with Google'}
              </button>
            </div>
            {authError && <p className="text-xs text-red-800 font-medium">{authError}</p>}
          </div>
        ) : (
          <div className="border border-emerald-200 bg-emerald-50 rounded-xl px-4 py-3 text-xs text-emerald-950 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
            <span>
              Official Google identity verified: <strong>{firebaseUser.email}</strong>
            </span>
          </div>
        )}

        {passcodeConfigured === false && (
          <form
            onSubmit={handleClaimFirstPasscode}
            className="border border-slate-200 rounded-xl bg-slate-50 p-5 space-y-3"
          >
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <KeyRound className="w-4 h-4 text-green-900" />
              First-Run Department Passcode Setup
            </div>
            <p className="text-xs text-slate-600">
              Create your server-hashed official department access code below (minimum 6 characters).
            </p>
            <div className="flex gap-2">
              <input
                type="password"
                value={setupPasscode}
                onChange={(e) => setSetupPasscode(e.target.value)}
                minLength={6}
                placeholder="Set official department passcode"
                className="flex-1 text-sm border border-slate-200 rounded-lg px-3 py-2 bg-white"
                required
              />
              <button type="submit" className="px-4 py-2 bg-slate-900 text-white text-xs font-medium rounded-lg">
                Save Passcode
              </button>
            </div>
          </form>
        )}

        <form onSubmit={handleVerifySubmit} className="border border-slate-200 rounded-xl bg-white p-6 space-y-4">
          {!firebaseUser && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Officer Name</label>
                <input
                  type="text"
                  value={officerNameInput}
                  onChange={(e) => setOfficerNameInput(e.target.value)}
                  placeholder="Officer full name"
                  className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2.5"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Official Department Email</label>
                <input
                  type="email"
                  value={officerEmail}
                  onChange={(e) => setOfficerEmail(e.target.value)}
                  placeholder="officer@municipality.gov.in"
                  className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2.5"
                  required={!firebaseUser}
                />
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Assigned Department</label>
              <select
                value={department}
                onChange={(e) => setDepartment(e.target.value)}
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2.5 bg-white"
              >
                {DEPARTMENTS.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Operational Role</label>
              <select
                value={roleChoice}
                onChange={(e) => setRoleChoice(e.target.value as AuthorityRole)}
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2.5 bg-white"
              >
                <option value="authority">Field Officer / Inspector</option>
                <option value="supervisor">Department Supervisor (Approvals &amp; Oversight)</option>
                <option value="admin">Platform Administrator</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Designation</label>
              <input
                type="text"
                value={designation}
                onChange={(e) => setDesignation(e.target.value)}
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2.5"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Jurisdiction / Ward</label>
              <input
                type="text"
                value={jurisdiction}
                onChange={(e) => setJurisdiction(e.target.value)}
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2.5"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Duty Phone (Optional)</label>
              <input
                type="tel"
                value={officerPhone}
                onChange={(e) => setOfficerPhone(e.target.value)}
                placeholder="+91..."
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2.5"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Department-Issued Access Code</label>
            <input
              type="password"
              value={passcodeInput}
              onChange={(e) => setPasscodeInput(e.target.value)}
              placeholder="Enter official department access code"
              className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2.5"
              required
            />
          </div>

          {authMsg && (
            <div className="text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded-lg p-3">{authMsg}</div>
          )}

          <button
            type="submit"
            disabled={verifying || (!firebaseUser && !officerEmail.trim())}
            className="w-full py-2.5 bg-green-900 text-white text-sm font-medium rounded-lg hover:bg-green-800 disabled:opacity-50 inline-flex items-center justify-center gap-2"
          >
            <Lock className="w-4 h-4" />
            {verifying ? 'Verifying Credentials...' : 'Enter Dedicated Authority Dashboard'}
          </button>
        </form>
      </div>
    );
  }

  // Filter Animal Rescue reports cleanly
  const animalRescueReports = reports.filter((r) => r.category === 'Animal Rescue and Welfare');
  const awaitingApprovalReports = reports.filter((r) => r.status === 'Awaiting Authority Review');
  const overdueReports = reports.filter(
    (r) => r.status !== 'Resolved' && r.status !== 'Rejected' && r.slaDeadlineAt && new Date(r.slaDeadlineAt).getTime() < Date.now()
  );
  const unreadNotifs = authNotifications.filter((n) => !n.read).length;

  const MODULES: Array<{ id: AuthorityModule; label: string; badge?: number; icon: React.ReactNode }> = [
    { id: 'overview', label: 'Overview', icon: <Layers className="w-4 h-4" /> },
    { id: 'reports', label: 'All Civic Reports', badge: stats.total, icon: <FileText className="w-4 h-4" /> },
    { id: 'verification', label: 'AI Verification', badge: stats.underVerification, icon: <ShieldCheck className="w-4 h-4" /> },
    { id: 'sos', label: 'SOS Alerts', badge: stats.activeSos, icon: <ShieldAlert className="w-4 h-4 text-red-600" /> },
    { id: 'medical', label: 'Medical Help', badge: stats.activeMedical, icon: <HeartPulse className="w-4 h-4 text-red-600" /> },
    { id: 'accident', label: 'Road Accidents', badge: stats.activeAccidents, icon: <Car className="w-4 h-4 text-amber-700" /> },
    { id: 'animal_rescue', label: 'Animal Rescue Hub', badge: animalRescueReports.length, icon: <PawPrint className="w-4 h-4 text-emerald-800" /> },
    { id: 'assignments', label: 'Officer Assignment', icon: <UserCheck className="w-4 h-4" /> },
    { id: 'progress', label: 'Action Center & SLA', badge: stats.overdue, icon: <Clock className="w-4 h-4" /> },
    { id: 'evidence', label: 'Resolution & Proof', badge: stats.awaitingReview, icon: <Camera className="w-4 h-4" /> },
    { id: 'complaints', label: 'Citizen Complaints', badge: complaintsBox.filter((c) => c.status !== 'Closed' && c.status !== 'Resolved').length, icon: <FileWarning className="w-4 h-4" /> },
    { id: 'departments', label: 'Dept Performance', icon: <Building2 className="w-4 h-4" /> },
    { id: 'leaderboard', label: 'Officer Leaderboard', icon: <Award className="w-4 h-4" /> },
    { id: 'escalations', label: 'SLA Escalations', icon: <AlertTriangle className="w-4 h-4" /> },
    { id: 'notifications', label: 'Notifications', badge: unreadNotifs, icon: <Bell className="w-4 h-4" /> },
    { id: 'analytics', label: 'Analytics & Charts', icon: <BarChart3 className="w-4 h-4" /> },
    { id: 'logs', label: 'Security, Audit & SMS', icon: <Lock className="w-4 h-4" /> },
  ];

  const selectAndManageReport = (r: CivicReport, jumpTo?: AuthorityModule) => {
    setSelectedReport(r);
    setNextStatus(r.status);
    setAssignDept(DEPT_RECOMMENDATIONS[r.category] || r.department);
    if (jumpTo) setActiveModule(jumpTo);
  };

  return (
    <div className="space-y-6">
      {/* Authority Top Summary Strip */}
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 pb-4">
        <div>
          <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900">
            Authority Operations Command · {authoritySession.department}
          </h1>
          <p className="text-xs sm:text-sm text-slate-600 mt-0.5">
            {authoritySession.name} ({authoritySession.designation || authoritySession.role.toUpperCase()}) · Jurisdiction:{' '}
            {authoritySession.jurisdiction}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={speakDashboardBriefing}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-green-900 text-white text-xs font-medium rounded-lg hover:bg-green-800"
          >
            <Volume2 className="w-4 h-4" />
            Voice Briefing
          </button>
          <button
            type="button"
            onClick={fetchAllAuthorityData}
            className="inline-flex items-center gap-1.5 px-3 py-2 border border-slate-200 text-slate-700 text-xs font-medium rounded-lg hover:bg-slate-50"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </button>
          <button
            type="button"
            onClick={clearAuthoritySession}
            className="px-3 py-2 border border-red-200 text-red-800 bg-red-50 text-xs font-medium rounded-lg hover:bg-red-100"
          >
            Lock Portal
          </button>
        </div>
      </div>

      {actionMsg && (
        <div className="text-xs text-emerald-950 bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-2.5 font-medium">
          {actionMsg}
        </div>
      )}
      {actionErr && (
        <div className="text-xs text-red-900 bg-red-50 border border-red-200 rounded-lg px-4 py-2.5 font-medium">
          {actionErr}
        </div>
      )}

      {/* Authority 17-Module Sidebar + Workspace */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Navigation Sidebar */}
        <aside className="lg:col-span-3 border border-slate-200 rounded-xl bg-white p-2.5 space-y-1">
          {MODULES.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setActiveModule(m.id)}
              className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
                activeModule === m.id
                  ? 'bg-green-900 text-white'
                  : 'text-slate-700 hover:bg-slate-100'
              }`}
            >
              <span className="flex items-center gap-2 truncate">
                {m.icon}
                <span className="truncate">{m.label}</span>
              </span>
              {typeof m.badge === 'number' && m.badge > 0 && (
                <span
                  className={`font-mono text-[11px] px-1.5 py-0.5 rounded ${
                    activeModule === m.id ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-700'
                  }`}
                >
                  {m.badge}
                </span>
              )}
            </button>
          ))}
        </aside>

        {/* Active Module Workspace */}
        <section className="lg:col-span-9 space-y-6">
          {/* MODULE 1: OVERVIEW */}
          {activeModule === 'overview' && (
            <div className="space-y-5">
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                {[
                  { label: 'Total Reports', val: stats.total ?? 0, mod: 'reports' as AuthorityModule },
                  { label: 'New Complaints', val: stats.newReports ?? 0, mod: 'reports' as AuthorityModule },
                  { label: 'Pending / Active', val: stats.pending ?? 0, mod: 'progress' as AuthorityModule },
                  { label: 'Overdue SLA', val: stats.overdue ?? 0, mod: 'escalations' as AuthorityModule },
                  { label: 'Resolved', val: stats.resolved ?? 0, mod: 'evidence' as AuthorityModule },
                  { label: 'Active SOS', val: stats.activeSos ?? 0, mod: 'sos' as AuthorityModule },
                  { label: 'Medical Requests', val: stats.activeMedical ?? 0, mod: 'medical' as AuthorityModule },
                  { label: 'Road Accidents', val: stats.activeAccidents ?? 0, mod: 'accident' as AuthorityModule },
                  { label: 'Animal Rescue', val: animalRescueReports.length, mod: 'animal_rescue' as AuthorityModule },
                  { label: 'AI Verification', val: stats.underVerification ?? 0, mod: 'verification' as AuthorityModule },
                  { label: 'Awaiting Approval', val: stats.awaitingReview ?? 0, mod: 'evidence' as AuthorityModule },
                  { label: 'Reopened Issues', val: stats.reopened ?? 0, mod: 'reports' as AuthorityModule },
                ].map((k) => (
                  <button
                    key={k.label}
                    type="button"
                    onClick={() => setActiveModule(k.mod)}
                    className="text-left border border-slate-200 rounded-xl bg-white p-3.5 hover:border-green-900 transition-colors"
                  >
                    <div className="text-xs text-slate-500">{k.label}</div>
                    <div className="font-mono text-2xl font-bold text-slate-900 mt-1 tabular-nums">{k.val}</div>
                  </button>
                ))}
              </div>

              {(stats.activeSos > 0 || stats.activeMedical > 0 || stats.activeAccidents > 0) && (
                <div className="border border-red-300 bg-red-50 rounded-xl p-4 space-y-2">
                  <div className="font-display text-sm font-bold text-red-900 flex items-center gap-2">
                    <ShieldAlert className="w-4 h-4" />
                    Live Emergency Dispatch Required
                  </div>
                  <div className="flex flex-wrap gap-2 text-xs">
                    {stats.activeSos > 0 && (
                      <button
                        type="button"
                        onClick={() => setActiveModule('sos')}
                        className="px-3 py-1.5 bg-red-700 text-white rounded-md font-medium"
                      >
                        Manage {stats.activeSos} Active SOS Alert(s)
                      </button>
                    )}
                    {stats.activeMedical > 0 && (
                      <button
                        type="button"
                        onClick={() => setActiveModule('medical')}
                        className="px-3 py-1.5 bg-slate-900 text-white rounded-md font-medium"
                      >
                        Dispatch {stats.activeMedical} Medical Request(s)
                      </button>
                    )}
                    {stats.activeAccidents > 0 && (
                      <button
                        type="button"
                        onClick={() => setActiveModule('accident')}
                        className="px-3 py-1.5 bg-amber-700 text-white rounded-md font-medium"
                      >
                        Respond to {stats.activeAccidents} Accident(s)
                      </button>
                    )}
                  </div>
                </div>
              )}

              {perfData && (
                <div className="border border-slate-200 rounded-xl bg-white p-5 space-y-3">
                  <div className="flex items-center justify-between">
                    <h2 className="font-display text-base font-bold text-slate-900">
                      Department SLA &amp; Resolution Snapshot
                    </h2>
                    <button
                      type="button"
                      onClick={() => setActiveModule('departments')}
                      className="text-xs font-semibold text-green-900 hover:underline"
                    >
                      Full Rankings →
                    </button>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {perfData.departmentRankings.slice(0, 4).map((d) => (
                      <div key={d.department} className="border border-slate-200 rounded-lg p-3 text-xs space-y-1">
                        <div className="flex justify-between font-semibold text-slate-900">
                          <span>{d.department}</span>
                          <span className="font-mono text-green-900">{d.departmentScore}/100</span>
                        </div>
                        <div className="text-slate-600">
                          SLA {d.slaComplianceRate}% · Resolved {d.resolvedCount}/{d.totalReports} · Pending {d.pendingCount}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* MODULE 2: CENTRAL COMPLAINT MANAGEMENT (+ MAP GPS VIEWER) */}
          {activeModule === 'reports' && (
            <div className="space-y-4">
              <div className="border border-slate-200 rounded-xl bg-white p-4 space-y-3">
                <div className="flex flex-wrap gap-2">
                  <div className="flex-1 min-w-[200px] relative">
                    <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-2.5" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search ID, Ref, title, location, citizen..."
                      className="w-full text-xs border border-slate-200 rounded-lg pl-8 pr-3 py-2"
                    />
                  </div>
                  <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                    className="text-xs border border-slate-200 rounded-lg px-2.5 py-2 bg-white"
                  >
                    <option value="All">Status: All</option>
                    <option value="Submitted">New (Submitted)</option>
                    <option value="Under Verification">Under Verification</option>
                    <option value="Verified">Verified</option>
                    <option value="Assigned">Assigned</option>
                    <option value="In Progress">In Progress</option>
                    <option value="Awaiting Evidence">Awaiting Evidence</option>
                    <option value="Awaiting Authority Review">Awaiting Approval</option>
                    <option value="Resolved">Resolved</option>
                    <option value="Reopened">Reopened</option>
                    <option value="Rejected">Rejected</option>
                  </select>
                  <select
                    value={severityFilter}
                    onChange={(e) => setSeverityFilter(e.target.value)}
                    className="text-xs border border-slate-200 rounded-lg px-2.5 py-2 bg-white"
                  >
                    <option value="All">Priority: All</option>
                    <option value="Critical">Critical</option>
                    <option value="High">High</option>
                    <option value="Medium">Medium</option>
                    <option value="Low">Low</option>
                  </select>
                  <select
                    value={categoryFilter}
                    onChange={(e) => setCategoryFilter(e.target.value)}
                    className="text-xs border border-slate-200 rounded-lg px-2.5 py-2 bg-white"
                  >
                    <option value="All">Category: All</option>
                    {Object.keys(DEPT_RECOMMENDATIONS).map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex flex-wrap gap-1.5 text-xs">
                  {(
                    [
                      { id: 'none', label: 'All Reports' },
                      { id: 'emergency', label: 'Emergency Alerts' },
                      { id: 'overdue', label: 'Overdue SLA' },
                      { id: 'reopened', label: 'Reopened Disputes' },
                    ] as const
                  ).map((chip) => (
                    <button
                      key={chip.id}
                      type="button"
                      onClick={() => setQuickFilter(chip.id)}
                      className={`px-2.5 py-1 rounded-md border ${
                        quickFilter === chip.id
                          ? 'bg-green-900 text-white border-green-900'
                          : 'bg-slate-50 border-slate-200 text-slate-700'
                      }`}
                    >
                      {chip.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 items-start">
                <div className="xl:col-span-6 border border-slate-200 rounded-xl bg-white divide-y divide-slate-200 max-h-[620px] overflow-y-auto">
                  {reports.length === 0 ? (
                    <div className="p-8 text-center text-xs text-slate-500">No complaints match your filters.</div>
                  ) : (
                    reports.map((r) => (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => selectAndManageReport(r)}
                        className={`w-full text-left p-3.5 transition-colors ${
                          selectedReport?.id === r.id ? 'bg-emerald-50/50' : 'hover:bg-slate-50'
                        }`}
                      >
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-mono font-semibold text-slate-800">
                            {r.complaintId} {r.referenceNumber ? `(${r.referenceNumber})` : ''}
                          </span>
                          <span className="font-semibold text-green-900">{r.status}</span>
                        </div>
                        <div className="font-medium text-sm text-slate-900 mt-0.5">{r.title}</div>
                        <div className="text-xs text-slate-500 mt-0.5">
                          {r.category} · {r.severity} · {r.department}
                        </div>
                      </button>
                    ))
                  )}
                </div>

                {/* Complaint Detail & GPS Map Viewer */}
                <div className="xl:col-span-6 border border-slate-200 rounded-xl bg-white p-5 space-y-4">
                  {!selectedReport ? (
                    <div className="py-12 text-center text-xs text-slate-500">
                      Select any complaint to inspect submitted photographs, exact GPS pin on map, verification signals, and routing actions.
                    </div>
                  ) : (
                    <>
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="font-mono text-xs text-slate-500">
                            {selectedReport.complaintId} · {selectedReport.referenceNumber}
                          </div>
                          <h3 className="font-display text-lg font-bold text-slate-900">{selectedReport.title}</h3>
                          <div className="text-xs text-slate-600 mt-0.5">
                            Citizen: {selectedReport.reporterDisplayName} · Dept: {selectedReport.department}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            onSpeakText(
                              `Complaint ${selectedReport.complaintId}. ${selectedReport.category}. Severity ${selectedReport.severity}. Location ${selectedReport.address}. Status ${selectedReport.status}. ${selectedReport.description}`
                            )
                          }
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-slate-100 text-xs font-medium rounded-md"
                        >
                          <Volume2 className="w-3.5 h-3.5" />
                          Read
                        </button>
                      </div>

                      <p className="text-xs text-slate-700 whitespace-pre-line">{selectedReport.description}</p>

                      {selectedReport.photoDataUrl && (
                        <img
                          src={selectedReport.photoDataUrl}
                          alt="Submitted evidence"
                          className="w-full h-44 object-cover rounded-lg border border-slate-200"
                        />
                      )}

                      <div className="space-y-1.5">
                        <div className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
                          <MapPin className="w-3.5 h-3.5 text-green-900" />
                          Complaint GPS Pin: {selectedReport.address} ({selectedReport.lat.toFixed(5)},{' '}
                          {selectedReport.lng.toFixed(5)})
                        </div>
                        <LeafletMap
                          centerLat={selectedReport.lat}
                          centerLng={selectedReport.lng}
                          zoom={15}
                          userLat={selectedReport.lat}
                          userLng={selectedReport.lng}
                          heightClass="h-[190px]"
                        />
                      </div>

                      <div className="flex flex-wrap gap-2 pt-2 border-t border-slate-200">
                        <button
                          type="button"
                          onClick={() => setActiveModule('verification')}
                          className="px-3 py-1.5 bg-slate-900 text-white text-xs font-medium rounded-md"
                        >
                          AI Verify / Reject
                        </button>
                        <button
                          type="button"
                          onClick={() => setActiveModule('assignments')}
                          className="px-3 py-1.5 bg-green-900 text-white text-xs font-medium rounded-md"
                        >
                          Assign Officer
                        </button>
                        <button
                          type="button"
                          onClick={() => setActiveModule('evidence')}
                          className="px-3 py-1.5 border border-slate-300 text-slate-800 text-xs font-medium rounded-md"
                        >
                          Upload Proof / Resolve
                        </button>
                        <button
                          type="button"
                          onClick={() => setActiveModule('escalations')}
                          className="px-3 py-1.5 border border-amber-300 text-amber-900 bg-amber-50 text-xs font-medium rounded-md"
                        >
                          Escalate SLA
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* MODULE 3: AI VERIFICATION & NON-ACCUSATORY FRAUD QUEUE */}
          {activeModule === 'verification' && (
            <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 items-start">
              <div className="xl:col-span-5 border border-slate-200 rounded-xl bg-white divide-y divide-slate-200">
                <div className="p-3.5 text-xs font-semibold text-slate-700 bg-slate-50 rounded-t-xl">
                  Seva Trust Verification Queue ({reports.length})
                </div>
                {reports.length === 0 ? (
                  <div className="p-8 text-center text-xs text-slate-500">No items currently flagged for review.</div>
                ) : (
                  reports.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => setSelectedReport(r)}
                      className={`w-full text-left p-3.5 ${
                        selectedReport?.id === r.id ? 'bg-emerald-50/50' : 'hover:bg-slate-50'
                      }`}
                    >
                      <div className="flex justify-between text-xs">
                        <span className="font-mono font-semibold">{r.complaintId}</span>
                        <span className="font-mono text-amber-800">
                          Risk {r.fraudRiskScore}/100 ({r.fraudRiskLevel})
                        </span>
                      </div>
                      <div className="text-sm font-medium text-slate-900 mt-0.5">{r.title}</div>
                      <div className="text-xs text-slate-500 mt-0.5">
                        {r.verificationStatus || 'Pending Verification'} · {r.evidenceCompleteness || 'Partial'} Evidence
                      </div>
                    </button>
                  ))
                )}
              </div>

              <div className="xl:col-span-7 border border-slate-200 rounded-xl bg-white p-5 space-y-4">
                {!selectedReport ? (
                  <div className="py-10 text-center text-xs text-slate-500">
                    Select a report to inspect AI Verification probability, non-accusatory indicators, and confirm/flag/request evidence/reject.
                  </div>
                ) : (
                  <>
                    <div>
                      <div className="font-mono text-xs text-slate-500">{selectedReport.complaintId}</div>
                      <h3 className="font-display text-lg font-bold text-slate-900">{selectedReport.title}</h3>
                    </div>

                    <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-2 text-xs">
                      <div className="flex flex-wrap justify-between gap-2 font-semibold text-slate-900">
                        <span>
                          Verification Risk Score: {selectedReport.fraudRiskScore}/100 ({selectedReport.fraudRiskLevel})
                        </span>
                        <span>
                          Probability: {selectedReport.fraudProbability ?? selectedReport.fraudRiskScore}% · Evidence:{' '}
                          {selectedReport.evidenceCompleteness || 'Partial'}
                        </span>
                      </div>
                      <p className="text-slate-700">{selectedReport.fraudExplanation}</p>
                      {selectedReport.recommendedActionText && (
                        <p className="text-green-900 font-medium">
                          Recommendation: {selectedReport.recommendedActionText}
                        </p>
                      )}
                      {selectedReport.fraudIndicators && selectedReport.fraudIndicators.length > 0 && (
                        <ul className="list-disc pl-4 text-amber-900 space-y-0.5">
                          {selectedReport.fraudIndicators.map((ind, i) => (
                            <li key={i}>{ind}</li>
                          ))}
                        </ul>
                      )}
                    </div>

                    <div className="space-y-3">
                      <input
                        type="text"
                        value={verifyNote}
                        onChange={(e) => setVerifyNote(e.target.value)}
                        placeholder="Verification review note or mandatory rejection reason (min 5 chars to reject)..."
                        className="w-full text-xs border border-slate-200 rounded-lg px-3 py-2.5"
                      />
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => handleVerifyDecision(selectedReport, 'verify')}
                          className="py-2 bg-green-900 text-white text-xs font-semibold rounded-lg"
                        >
                          Verify Report
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => handleVerifyDecision(selectedReport, 'flag')}
                          className="py-2 bg-amber-600 text-white text-xs font-semibold rounded-lg"
                        >
                          Flag for Review
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => handleVerifyDecision(selectedReport, 'reject')}
                          className="py-2 bg-red-600 text-white text-xs font-semibold rounded-lg"
                        >
                          Reject Report
                        </button>
                      </div>

                      <div className="pt-2 border-t border-slate-200 flex gap-2">
                        <input
                          type="text"
                          value={evidenceRequestNote}
                          onChange={(e) => setEvidenceRequestNote(e.target.value)}
                          placeholder="Specify additional evidence needed from citizen..."
                          className="flex-1 text-xs border border-slate-200 rounded-lg px-3 py-2"
                        />
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => handleVerifyDecision(selectedReport, 'request_evidence')}
                          className="px-3.5 py-2 bg-slate-900 text-white text-xs font-medium rounded-lg"
                        >
                          Request Citizen Evidence
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {/* MODULE 4: SOS ALERTS */}
          {activeModule === 'sos' && (
            <div className="border border-slate-200 rounded-xl bg-white p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-display text-lg font-bold text-slate-900">
                  Emergency Response Center · Seva Shield SOS ({sosEvents.length})
                </h2>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={responderName}
                    onChange={(e) => setResponderName(e.target.value)}
                    placeholder="Responder unit / officer name..."
                    className="text-xs border border-slate-200 rounded-lg px-2.5 py-1.5"
                  />
                  <input
                    type="text"
                    value={responderNotes}
                    onChange={(e) => setResponderNotes(e.target.value)}
                    placeholder="Dispatch notes..."
                    className="text-xs border border-slate-200 rounded-lg px-2.5 py-1.5"
                  />
                </div>
              </div>

              {sosEvents.length === 0 ? (
                <p className="text-xs text-slate-500 py-6 text-center">No SOS alerts triggered yet.</p>
              ) : (
                <div className="space-y-3">
                  {sosEvents.map((s) => (
                    <div key={s.id} className="border border-slate-200 rounded-xl p-4 space-y-2 text-xs">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="font-semibold text-sm text-slate-900">
                          {s.displayName} · <span className="uppercase text-red-700">{s.status}</span>
                        </div>
                        <span className="font-mono text-slate-500">
                          {s.lat.toFixed(5)}, {s.lng.toFixed(5)}
                        </span>
                      </div>
                      <div className="text-slate-700">{s.address || 'GPS location attached'}</div>
                      {s.smsSummary && <div className="text-slate-600">Caregiver SMS: {s.smsSummary}</div>}
                      <div className="flex flex-wrap gap-2 pt-1">
                        {(['acknowledged', 'responder_assigned', 'safe_resolved', 'completed'] as const).map((st) => (
                          <button
                            key={st}
                            type="button"
                            disabled={busy}
                            onClick={() => handleManageEmergency('sos', s.id, st)}
                            className="px-2.5 py-1.5 bg-slate-900 text-white rounded-md capitalize"
                          >
                            {st.replace('_', ' ')}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* MODULE 5: MEDICAL ASSISTANCE */}
          {activeModule === 'medical' && (
            <div className="border border-slate-200 rounded-xl bg-white p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-display text-lg font-bold text-slate-900">
                  Medical Assistance Dispatch ({medicalRequests.length})
                </h2>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={responderName}
                    onChange={(e) => setResponderName(e.target.value)}
                    placeholder="Ambulance / Medical team..."
                    className="text-xs border border-slate-200 rounded-lg px-2.5 py-1.5"
                  />
                  <input
                    type="text"
                    value={responderNotes}
                    onChange={(e) => setResponderNotes(e.target.value)}
                    placeholder="Medical dispatch notes..."
                    className="text-xs border border-slate-200 rounded-lg px-2.5 py-1.5"
                  />
                </div>
              </div>

              {medicalRequests.length === 0 ? (
                <p className="text-xs text-slate-500 py-6 text-center">No medical assistance requests logged.</p>
              ) : (
                <div className="space-y-3">
                  {medicalRequests.map((m) => (
                    <div key={m.id} className="border border-slate-200 rounded-xl p-4 space-y-2 text-xs">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-mono font-bold text-slate-900">
                          {m.trackingId} · {m.citizenName} ({m.severity})
                        </span>
                        <span className="font-semibold text-green-900">{m.status}</span>
                      </div>
                      <p className="text-slate-700">{m.condition}</p>
                      <div className="text-slate-600">
                        {m.address} · Nearest Hospital: {m.nearestHospital || 'Not specified'} · SMS: {m.smsStatus}
                      </div>
                      <div className="flex flex-wrap gap-2 pt-1">
                        {(['Acknowledged', 'Responder Assigned', 'On the Way', 'Completed'] as const).map((st) => (
                          <button
                            key={st}
                            type="button"
                            disabled={busy}
                            onClick={() => handleManageEmergency('medical', m.id, st)}
                            className="px-2.5 py-1.5 bg-green-900 text-white rounded-md"
                          >
                            {st}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* MODULE 6: ROAD ACCIDENT ASSISTANCE */}
          {activeModule === 'accident' && (
            <div className="border border-slate-200 rounded-xl bg-white p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-display text-lg font-bold text-slate-900">
                  Road Accident Response Queue ({accidentRequests.length})
                </h2>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={responderName}
                    onChange={(e) => setResponderName(e.target.value)}
                    placeholder="Traffic / Trauma response unit..."
                    className="text-xs border border-slate-200 rounded-lg px-2.5 py-1.5"
                  />
                  <input
                    type="text"
                    value={responderNotes}
                    onChange={(e) => setResponderNotes(e.target.value)}
                    placeholder="Scene response notes..."
                    className="text-xs border border-slate-200 rounded-lg px-2.5 py-1.5"
                  />
                </div>
              </div>

              {accidentRequests.length === 0 ? (
                <p className="text-xs text-slate-500 py-6 text-center">No road accident reports logged.</p>
              ) : (
                <div className="space-y-3">
                  {accidentRequests.map((a) => (
                    <div key={a.id} className="border border-slate-200 rounded-xl p-4 space-y-2 text-xs">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-mono font-bold text-slate-900">
                          {a.trackingId} · {a.severity} ({a.peopleAffected} affected)
                        </span>
                        <span className="font-semibold text-amber-800">{a.status}</span>
                      </div>
                      <p className="text-slate-700">{a.description}</p>
                      <div className="text-slate-600">
                        {a.address} · SMS: {a.smsStatus}
                      </div>
                      {a.photoUrls && a.photoUrls.length > 0 && (
                        <div className="flex gap-2 overflow-x-auto py-1">
                          {a.photoUrls.map((p) => (
                            <img
                              key={p.id}
                              src={p.url}
                              alt="Accident scene"
                              className="w-24 h-20 object-cover rounded border border-slate-200"
                            />
                          ))}
                        </div>
                      )}
                      <div className="flex flex-wrap gap-2 pt-1">
                        {(['Acknowledged', 'Responder Assigned', 'On the Way', 'Completed'] as const).map((st) => (
                          <button
                            key={st}
                            type="button"
                            disabled={busy}
                            onClick={() => handleManageEmergency('accident', a.id, st)}
                            className="px-2.5 py-1.5 bg-slate-900 text-white rounded-md"
                          >
                            {st}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* MODULE 7: ANIMAL RESCUE HUB */}
          {activeModule === 'animal_rescue' && (
            <div className="border border-slate-200 rounded-xl bg-white p-5 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="font-display text-lg font-bold text-slate-900">
                    Animal Welfare &amp; Rescue Hub ({animalRescueReports.length})
                  </h2>
                  <p className="text-xs text-slate-600">
                    Dedicated queue for injured strays, wildlife distress, and Animal Rescue &amp; Welfare team dispatch.
                  </p>
                </div>
              </div>

              {animalRescueReports.length === 0 ? (
                <p className="text-xs text-slate-500 py-8 text-center">
                  No Animal Rescue &amp; Welfare reports are currently active.
                </p>
              ) : (
                <div className="space-y-3">
                  {animalRescueReports.map((r) => (
                    <div key={r.id} className="border border-slate-200 rounded-xl p-4 space-y-2 text-xs">
                      <div className="flex flex-wrap justify-between gap-2">
                        <span className="font-mono font-semibold text-slate-900">
                          {r.complaintId} · {r.severity}
                        </span>
                        <span className="font-semibold text-emerald-800">{r.status}</span>
                      </div>
                      <div className="text-sm font-semibold text-slate-900">{r.title}</div>
                      <p className="text-slate-700">{r.description}</p>
                      <div className="text-slate-500">
                        {r.address} · Assigned Team: {r.assignedOfficer || 'Unassigned'}
                      </div>
                      <div className="flex flex-wrap gap-2 pt-1">
                        <button
                          type="button"
                          onClick={() => selectAndManageReport(r, 'assignments')}
                          className="px-3 py-1.5 bg-green-900 text-white rounded-md font-medium"
                        >
                          Assign Rescue Team
                        </button>
                        <button
                          type="button"
                          onClick={() => selectAndManageReport(r, 'progress')}
                          className="px-3 py-1.5 bg-slate-900 text-white rounded-md font-medium"
                        >
                          Update Rescue Progress
                        </button>
                        <button
                          type="button"
                          onClick={() => selectAndManageReport(r, 'evidence')}
                          className="px-3 py-1.5 border border-slate-300 text-slate-800 rounded-md font-medium"
                        >
                          Submit Rescue Before/After Photos
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* MODULE 8: OFFICER ASSIGNMENT & ROSTER */}
          {activeModule === 'assignments' && (
            <div className="space-y-5">
              <div className="border border-slate-200 rounded-xl bg-white p-5 space-y-4">
                <h2 className="font-display text-lg font-bold text-slate-900">
                  Smart Department Assignment &amp; Reassignment
                </h2>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                  <div>
                    <label className="font-semibold text-slate-700 block mb-1">Select Complaint</label>
                    <select
                      value={selectedReport?.id || ''}
                      onChange={(e) => {
                        const found = reports.find((r) => r.id === e.target.value) || null;
                        if (found) selectAndManageReport(found);
                      }}
                      className="w-full border border-slate-200 rounded-lg px-2.5 py-2 bg-white"
                    >
                      <option value="">-- Choose complaint --</option>
                      {reports.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.complaintId} · {r.title.slice(0, 42)} ({r.assignedOfficer || 'Unassigned'})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="font-semibold text-slate-700 block mb-1">
                      Target Department{' '}
                      {selectedReport &&
                        `(Auto-recommended: ${DEPT_RECOMMENDATIONS[selectedReport.category] || selectedReport.department})`}
                    </label>
                    <select
                      value={assignDept}
                      onChange={(e) => setAssignDept(e.target.value)}
                      className="w-full border border-slate-200 rounded-lg px-2.5 py-2 bg-white"
                    >
                      {DEPARTMENTS.filter((d) => d !== 'All Departments').map((d) => (
                        <option key={d} value={d}>
                          {d}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="font-semibold text-slate-700 block mb-1">Assign to Officer</label>
                    <select
                      value={assignOfficerUid}
                      onChange={(e) => setAssignOfficerUid(e.target.value)}
                      className="w-full border border-slate-200 rounded-lg px-2.5 py-2 bg-white"
                    >
                      <option value="">Self-Assign ({authoritySession.name})</option>
                      {officers.map((o) => (
                        <option key={o.uid} value={o.uid}>
                          {o.name} · {o.department} · Workload {o.activeWorkload} ({o.availability})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="font-semibold text-slate-700 block mb-1">
                      Assignment / Mandatory Reassignment Reason
                    </label>
                    <input
                      type="text"
                      value={assignReason}
                      onChange={(e) => setAssignReason(e.target.value)}
                      placeholder="Required when reassigning from existing officer..."
                      className="w-full border border-slate-200 rounded-lg px-3 py-2"
                    />
                  </div>
                </div>

                <button
                  type="button"
                  disabled={!selectedReport || busy}
                  onClick={() => selectedReport && handleAssignOfficer(selectedReport)}
                  className="px-4 py-2 bg-green-900 text-white text-xs font-semibold rounded-lg disabled:opacity-50"
                >
                  Confirm Officer Assignment
                </button>

                {selectedReport?.assignmentHistory && selectedReport.assignmentHistory.length > 0 && (
                  <div className="pt-3 border-t border-slate-200 space-y-1.5 text-xs">
                    <div className="font-semibold text-slate-800">Assignment Audit History</div>
                    {selectedReport.assignmentHistory.map((h) => (
                      <div key={h.id} className="text-slate-600">
                        {h.fromOfficer ? `${h.fromOfficer} → ` : ''}
                        <strong>{h.toOfficer}</strong> ({h.toDepartment}) by {h.assignedBy}
                        {h.reason ? ` — Reason: ${h.reason}` : ''}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Officer Roster + Availability */}
              <div className="border border-slate-200 rounded-xl bg-white p-5 space-y-4">
                <div className="flex items-center gap-2 font-display text-base font-bold text-slate-900">
                  <Users className="w-4 h-4 text-green-900" />
                  Live Officer Roster &amp; Workload ({officers.length})
                </div>

                <div className="divide-y divide-slate-200 text-xs">
                  {officers.map((o) => (
                    <div key={o.uid} className="py-2.5 flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="font-semibold text-slate-900">
                          {o.name} · <span className="text-slate-600 font-normal">{o.designation}</span>
                        </div>
                        <div className="text-slate-500">
                          {o.department} · Role: {o.role} · Active Cases: {o.activeWorkload}
                        </div>
                      </div>
                      <select
                        value={o.availability}
                        onChange={(e) => handleToggleAvailability(o.uid, e.target.value as any)}
                        className="text-xs border border-slate-200 rounded-md px-2 py-1 bg-white"
                      >
                        <option value="available">Available</option>
                        <option value="busy">Busy</option>
                        <option value="off_duty">Off Duty</option>
                      </select>
                    </div>
                  ))}
                </div>

                {(authoritySession.role === 'supervisor' || authoritySession.role === 'admin') && (
                  <form onSubmit={handleRegisterOfficer} className="pt-3 border-t border-slate-200 space-y-3">
                    <div className="text-xs font-semibold text-slate-800 flex items-center gap-1.5">
                      <UserPlus className="w-3.5 h-3.5 text-green-900" />
                      Register Field Officer / Supervisor
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-5 gap-2 text-xs">
                      <input
                        type="text"
                        value={newOfficerName}
                        onChange={(e) => setNewOfficerName(e.target.value)}
                        placeholder="Full name"
                        className="border border-slate-200 rounded-lg px-2.5 py-2"
                        required
                      />
                      <input
                        type="email"
                        value={newOfficerEmail}
                        onChange={(e) => setNewOfficerEmail(e.target.value)}
                        placeholder="Email"
                        className="border border-slate-200 rounded-lg px-2.5 py-2"
                        required
                      />
                      <select
                        value={newOfficerDept}
                        onChange={(e) => setNewOfficerDept(e.target.value)}
                        className="border border-slate-200 rounded-lg px-2 py-2 bg-white"
                      >
                        {DEPARTMENTS.filter((d) => d !== 'All Departments').map((d) => (
                          <option key={d} value={d}>
                            {d}
                          </option>
                        ))}
                      </select>
                      <input
                        type="text"
                        value={newOfficerDesignation}
                        onChange={(e) => setNewOfficerDesignation(e.target.value)}
                        placeholder="Designation"
                        className="border border-slate-200 rounded-lg px-2.5 py-2"
                      />
                      <select
                        value={newOfficerRole}
                        onChange={(e) => setNewOfficerRole(e.target.value as AuthorityRole)}
                        className="border border-slate-200 rounded-lg px-2 py-2 bg-white"
                      >
                        <option value="authority">Officer</option>
                        <option value="supervisor">Supervisor</option>
                      </select>
                    </div>
                    <button type="submit" disabled={busy} className="px-4 py-2 bg-slate-900 text-white text-xs font-medium rounded-lg">
                      Add Officer to Roster
                    </button>
                  </form>
                )}
              </div>
            </div>
          )}

          {/* MODULE 9: WORK PROGRESS & ACTION CENTER */}
          {activeModule === 'progress' && (
            <div className="space-y-5">
              {overdueReports.length > 0 && (
                <div className="border border-amber-300 bg-amber-50 rounded-xl p-4 space-y-2 text-xs">
                  <div className="font-semibold text-amber-950">
                    Overdue SLA Action Required ({overdueReports.length})
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {overdueReports.slice(0, 6).map((r) => (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => selectAndManageReport(r)}
                        className="px-2.5 py-1 bg-white border border-amber-300 rounded-md font-mono text-amber-950"
                      >
                        {r.complaintId} ({r.status})
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="border border-slate-200 rounded-xl bg-white p-5 space-y-4">
                <h2 className="font-display text-lg font-bold text-slate-900">
                  10-Stage Operational Work Progress
                </h2>
                <select
                  value={selectedReport?.id || ''}
                  onChange={(e) => {
                    const found = reports.find((r) => r.id === e.target.value) || null;
                    if (found) selectAndManageReport(found);
                  }}
                  className="w-full text-xs border border-slate-200 rounded-lg px-3 py-2 bg-white"
                >
                  <option value="">-- Select a complaint to progress --</option>
                  {reports.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.complaintId} · {r.title} [{r.status}]
                    </option>
                  ))}
                </select>

                {selectedReport && (
                  <div className="space-y-3 text-xs">
                    <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
                      Current Status: <strong>{selectedReport.status}</strong> · SLA Target:{' '}
                      {selectedReport.slaDeadlineAt ? new Date(selectedReport.slaDeadlineAt).toLocaleString() : 'Standard'}
                    </div>
                    <select
                      value={nextStatus}
                      onChange={(e) => setNextStatus(e.target.value as ReportStatus)}
                      className="w-full border border-slate-200 rounded-lg px-3 py-2 bg-white"
                    >
                      <option value="Submitted">Submitted</option>
                      <option value="Under Verification">Under Verification</option>
                      <option value="Verified">Verified</option>
                      <option value="Authority Acknowledged">Authority Acknowledged</option>
                      <option value="Assigned">Assigned</option>
                      <option value="In Progress">In Progress</option>
                      <option value="Awaiting Evidence">Awaiting Evidence</option>
                      <option value="Awaiting Authority Review">Awaiting Authority Review</option>
                      <option value="Resolved">Resolved (Requires Before/After Photos)</option>
                      <option value="Reopened">Reopened</option>
                      <option value="Rejected">Rejected</option>
                    </select>
                    <textarea
                      rows={2}
                      value={workNote}
                      onChange={(e) => setWorkNote(e.target.value)}
                      placeholder="Field action update or inspection remarks..."
                      className="w-full border border-slate-200 rounded-lg px-3 py-2"
                    />
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => handleManageProgressOrEvidence(selectedReport, false)}
                      className="px-4 py-2 bg-green-900 text-white text-xs font-semibold rounded-lg"
                    >
                      Save Progress &amp; Notify Citizen
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* MODULE 10: RESOLUTION EVIDENCE & FINAL APPROVAL GATE */}
          {activeModule === 'evidence' && (
            <div className="space-y-5">
              <div className="border border-slate-200 rounded-xl bg-white p-5 space-y-4">
                <h2 className="font-display text-lg font-bold text-slate-900">
                  Mandatory Before / After Resolution Evidence Gate
                </h2>
                <p className="text-xs text-slate-600">
                  Every resolution requires at least 1 Before-Work photo, 1 After-Work photo, and completion notes. Field officer submissions enter Supervisor/Admin Final Approval.
                </p>

                <select
                  value={selectedReport?.id || ''}
                  onChange={(e) => {
                    const found = reports.find((r) => r.id === e.target.value) || null;
                    if (found) selectAndManageReport(found);
                  }}
                  className="w-full text-xs border border-slate-200 rounded-lg px-3 py-2 bg-white"
                >
                  <option value="">-- Select complaint --</option>
                  {reports.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.complaintId} · {r.title} [{r.status}]
                    </option>
                  ))}
                </select>

                {selectedReport && (
                  <div className="space-y-3 text-xs">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <label className="border border-dashed border-slate-300 rounded-lg p-3 cursor-pointer hover:bg-slate-50">
                        <div className="font-semibold text-slate-800">Before-Work Photos ({beforePhotos.length})</div>
                        <div className="text-slate-500 mt-0.5">Upload site before repair</div>
                        <input
                          type="file"
                          accept="image/*"
                          multiple
                          onChange={(e) => uploadEvidenceFiles(e.target.files, setBeforePhotos, 'Before work')}
                          className="hidden"
                        />
                      </label>
                      <label className="border border-dashed border-emerald-400 rounded-lg p-3 cursor-pointer hover:bg-emerald-50/40">
                        <div className="font-semibold text-green-950">After-Work Photos ({afterPhotos.length})</div>
                        <div className="text-slate-500 mt-0.5">Upload completed repair</div>
                        <input
                          type="file"
                          accept="image/*"
                          multiple
                          onChange={(e) => uploadEvidenceFiles(e.target.files, setAfterPhotos, 'After work')}
                          className="hidden"
                        />
                      </label>
                      <label className="border border-dashed border-slate-300 rounded-lg p-3 cursor-pointer hover:bg-slate-50">
                        <div className="font-semibold text-slate-800">Additional Proof ({extraResPhotos.length})</div>
                        <div className="text-slate-500 mt-0.5">Optional extra angles</div>
                        <input
                          type="file"
                          accept="image/*"
                          multiple
                          onChange={(e) => uploadEvidenceFiles(e.target.files, setExtraResPhotos, 'Extra evidence')}
                          className="hidden"
                        />
                      </label>
                    </div>

                    <textarea
                      rows={2}
                      value={workNote}
                      onChange={(e) => setWorkNote(e.target.value)}
                      placeholder="Mandatory completion notes (min 5 chars)..."
                      className="w-full border border-slate-200 rounded-lg px-3 py-2"
                    />
                    <input
                      type="text"
                      value={resolutionDesc}
                      onChange={(e) => setResolutionDesc(e.target.value)}
                      placeholder="Summary of repair/materials used..."
                      className="w-full border border-slate-200 rounded-lg px-3 py-2"
                    />
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => handleManageProgressOrEvidence(selectedReport, true)}
                        className="px-4 py-2 bg-slate-900 text-white font-semibold rounded-lg"
                      >
                        Submit Evidence for Final Approval
                      </button>
                      {(authoritySession.role === 'supervisor' || authoritySession.role === 'admin') && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setNextStatus('Resolved');
                            handleManageProgressOrEvidence(selectedReport, false);
                          }}
                          className="px-4 py-2 bg-green-900 text-white font-semibold rounded-lg"
                        >
                          Upload Evidence &amp; Mark Resolved
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Supervisor / Admin Approval Queue */}
              {(authoritySession.role === 'supervisor' || authoritySession.role === 'admin') && (
                <div className="border border-slate-200 rounded-xl bg-white p-5 space-y-3">
                  <h3 className="font-display text-base font-bold text-slate-900">
                    Pending Supervisor Final Approval ({awaitingApprovalReports.length})
                  </h3>
                  {awaitingApprovalReports.length === 0 ? (
                    <p className="text-xs text-slate-500">No resolutions awaiting final supervisor sign-off.</p>
                  ) : (
                    awaitingApprovalReports.map((r) => (
                      <div key={r.id} className="border border-slate-200 rounded-xl p-4 space-y-2 text-xs">
                        <div className="font-mono font-semibold text-slate-900">
                          {r.complaintId} · {r.title}
                        </div>
                        <p className="text-slate-600">{r.resolutionEvidence?.completionNotes}</p>
                        <div className="grid grid-cols-2 gap-2">
                          {r.resolutionEvidence?.beforePhotos.map((p) => (
                            <img key={p.id} src={p.url} alt="Before" className="h-28 w-full object-cover rounded border" />
                          ))}
                          {r.resolutionEvidence?.afterPhotos.map((p) => (
                            <img key={p.id} src={p.url} alt="After" className="h-28 w-full object-cover rounded border border-emerald-400" />
                          ))}
                        </div>
                        <div className="flex flex-wrap gap-2 pt-1">
                          <input
                            type="text"
                            value={approvalNotes}
                            onChange={(e) => setApprovalNotes(e.target.value)}
                            placeholder="Supervisor sign-off / rework notes..."
                            className="flex-1 border border-slate-200 rounded-lg px-2.5 py-1.5"
                          />
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => handleApproveResolution(r, 'approve')}
                            className="px-3 py-1.5 bg-green-900 text-white font-semibold rounded-md"
                          >
                            Approve Resolution
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => handleApproveResolution(r, 'request_rework')}
                            className="px-3 py-1.5 bg-amber-600 text-white font-semibold rounded-md"
                          >
                            Request Rework
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          )}

          {/* MODULE 11: CITIZEN COMPLAINTS BOX OVERSIGHT */}
          {activeModule === 'complaints' && (
            <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 items-start">
              <div className="xl:col-span-5 border border-slate-200 rounded-xl bg-white divide-y divide-slate-200">
                <div className="p-3.5 text-xs font-semibold text-slate-700 bg-slate-50 rounded-t-xl">
                  Independent Oversight Queue ({complaintsBox.length})
                </div>
                {complaintsBox.length === 0 ? (
                  <div className="p-8 text-center text-xs text-slate-500">No accountability complaints visible.</div>
                ) : (
                  complaintsBox.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => {
                        setSelectedComplaint(c);
                        setCmpStatus(c.status);
                      }}
                      className={`w-full text-left p-3.5 ${
                        selectedComplaint?.id === c.id ? 'bg-emerald-50/50' : 'hover:bg-slate-50'
                      }`}
                    >
                      <div className="flex justify-between text-xs">
                        <span className="font-mono font-semibold">{c.complaintRef}</span>
                        <span className="font-semibold text-amber-800">{c.status}</span>
                      </div>
                      <div className="text-sm font-medium text-slate-900 mt-0.5">{c.subject}</div>
                      <div className="text-xs text-slate-500 mt-0.5">
                        Target: {c.targetDepartment} {c.targetOfficerName ? `(${c.targetOfficerName})` : ''}
                      </div>
                    </button>
                  ))
                )}
              </div>

              <div className="xl:col-span-7 border border-slate-200 rounded-xl bg-white p-5 space-y-4 text-xs">
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-amber-950">
                  <strong>Anti-Self-Review Safeguard Active:</strong> Target officers cannot view, self-assign, or close complaints filed against themselves (enforced HTTP 403 on backend).
                </div>
                {!selectedComplaint ? (
                  <p className="text-slate-500 py-8 text-center">Select a complaint to assign an independent reviewer and record findings.</p>
                ) : (
                  <>
                    <div>
                      <div className="font-mono text-slate-500">{selectedComplaint.complaintRef}</div>
                      <h3 className="font-display text-base font-bold text-slate-900">{selectedComplaint.subject}</h3>
                      <p className="text-slate-700 mt-1">{selectedComplaint.description}</p>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <div>
                        <label className="font-semibold block mb-1">Independent Reviewer (Excludes Target)</label>
                        <select
                          value={cmpReviewerUid}
                          onChange={(e) => setCmpReviewerUid(e.target.value)}
                          className="w-full border border-slate-200 rounded-lg px-2.5 py-2 bg-white"
                        >
                          <option value="">Keep current / Self ({authoritySession.name})</option>
                          {officers
                            .filter(
                              (o) =>
                                o.uid !== selectedComplaint.targetOfficerUid &&
                                o.name.toLowerCase() !== (selectedComplaint.targetOfficerName || '').toLowerCase()
                            )
                            .map((o) => (
                              <option key={o.uid} value={o.uid}>
                                {o.name} ({o.department})
                              </option>
                            ))}
                        </select>
                      </div>
                      <div>
                        <label className="font-semibold block mb-1">Oversight Status</label>
                        <select
                          value={cmpStatus}
                          onChange={(e) => setCmpStatus(e.target.value)}
                          className="w-full border border-slate-200 rounded-lg px-2.5 py-2 bg-white"
                        >
                          <option value="Submitted">Submitted</option>
                          <option value="Under Supervisor Review">Under Supervisor Review</option>
                          <option value="Investigating">Investigating</option>
                          <option value="Action Taken">Action Taken</option>
                          <option value="Resolved">Resolved</option>
                          <option value="Closed">Closed</option>
                        </select>
                      </div>
                    </div>
                    <input
                      type="text"
                      value={cmpInternalNote}
                      onChange={(e) => setCmpInternalNote(e.target.value)}
                      placeholder="Internal confidential investigation note (never shown to citizen)..."
                      className="w-full border border-slate-200 rounded-lg px-3 py-2"
                    />
                    <input
                      type="text"
                      value={cmpPublicUpdate}
                      onChange={(e) => setCmpPublicUpdate(e.target.value)}
                      placeholder="Public progress update visible to citizen..."
                      className="w-full border border-slate-200 rounded-lg px-3 py-2"
                    />
                    <input
                      type="text"
                      value={cmpResolution}
                      onChange={(e) => setCmpResolution(e.target.value)}
                      placeholder="Final resolution summary..."
                      className="w-full border border-slate-200 rounded-lg px-3 py-2"
                    />
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => handleManageComplaintBox(selectedComplaint)}
                      className="px-4 py-2 bg-green-900 text-white font-semibold rounded-lg"
                    >
                      Save Oversight Action
                    </button>
                  </>
                )}
              </div>
            </div>
          )}

          {/* MODULE 12: DEPARTMENT PERFORMANCE RANKINGS */}
          {activeModule === 'departments' && (
            <div className="border border-slate-200 rounded-xl bg-white p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-display text-lg font-bold text-slate-900">Department Performance &amp; SLA Compliance</h2>
                <button
                  type="button"
                  onClick={() => window.print()}
                  className="px-3 py-1.5 border border-slate-200 text-xs font-medium rounded-lg hover:bg-slate-50"
                >
                  Print Dept Report
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs text-left">
                  <thead className="border-b border-slate-200 text-slate-500">
                    <tr>
                      <th className="py-2 pr-3">Department</th>
                      <th className="py-2 pr-3">Total</th>
                      <th className="py-2 pr-3">Pending</th>
                      <th className="py-2 pr-3">Resolved</th>
                      <th className="py-2 pr-3">Overdue</th>
                      <th className="py-2 pr-3">Reopened</th>
                      <th className="py-2 pr-3">SLA %</th>
                      <th className="py-2 pr-3">Avg Hrs</th>
                      <th className="py-2">Score</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {(perfData?.departmentRankings || []).map((d) => (
                      <tr key={d.department}>
                        <td className="py-2.5 pr-3 font-semibold text-slate-900">{d.department}</td>
                        <td className="py-2.5 pr-3 font-mono">{d.totalReports}</td>
                        <td className="py-2.5 pr-3 font-mono">{d.pendingCount}</td>
                        <td className="py-2.5 pr-3 font-mono">{d.resolvedCount}</td>
                        <td className="py-2.5 pr-3 font-mono text-amber-800">{d.overdueCount}</td>
                        <td className="py-2.5 pr-3 font-mono text-red-700">{d.reopenedCount}</td>
                        <td className="py-2.5 pr-3 font-mono">{d.slaComplianceRate}%</td>
                        <td className="py-2.5 pr-3 font-mono">{d.avgResolutionHours}h</td>
                        <td className="py-2.5 font-mono font-bold text-green-900">{d.departmentScore}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* MODULE 13: AUTHORITY LEADERBOARD & RECOGNITION */}
          {activeModule === 'leaderboard' && (
            <div className="border border-slate-200 rounded-xl bg-white p-5 space-y-4">
              <div>
                <h2 className="font-display text-lg font-bold text-slate-900">
                  Authority Performance Index &amp; Digital Badges
                </h2>
                <p className="text-xs text-slate-600">
                  Evaluates resolved cases, Before/After evidence quality, SLA speed, citizen rating, and penalizes reopened or overdue complaints.
                </p>
              </div>
              <div className="space-y-2.5">
                {(perfData?.officerLeaderboard || []).map((o, idx) => (
                  <div key={o.uid} className="border border-slate-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3 text-xs">
                    <div>
                      <div className="font-display text-sm font-bold text-slate-900">
                        #{idx + 1} {o.name} · <span className="font-normal text-slate-600">{o.department}</span>
                      </div>
                      <div className="text-slate-600 mt-0.5">
                        Resolved: {o.resolvedCount} · Evidence Verified: {o.evidenceVerifiedCount} · Reopened Penalties:{' '}
                        {o.reopenedCount} · Overdue: {o.overdueCount}
                      </div>
                      {o.badges.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mt-1.5">
                          {o.badges.map((b) => (
                            <span key={b} className="px-2 py-0.5 bg-emerald-50 border border-emerald-200 text-green-950 rounded text-[11px] font-medium">
                              {b}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="text-right">
                      <div className="text-[11px] text-slate-500">Performance Index</div>
                      <div className="font-mono text-2xl font-bold text-green-900">{o.performanceIndex}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* MODULE 14: 3-TIER ESCALATIONS */}
          {activeModule === 'escalations' && (
            <div className="border border-slate-200 rounded-xl bg-white p-5 space-y-4 text-xs">
              <h2 className="font-display text-lg font-bold text-slate-900">
                3-Tier SLA Escalation Console
              </h2>
              <select
                value={selectedReport?.id || ''}
                onChange={(e) => {
                  const found = reports.find((r) => r.id === e.target.value) || null;
                  if (found) selectAndManageReport(found);
                }}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 bg-white"
              >
                <option value="">-- Select complaint to escalate --</option>
                {reports.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.complaintId} · {r.title} [{r.status}]
                  </option>
                ))}
              </select>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <select
                  value={escLevel}
                  onChange={(e) => setEscLevel(Number(e.target.value) as 1 | 2 | 3)}
                  className="border border-slate-200 rounded-lg px-2.5 py-2 bg-white"
                >
                  <option value={1}>Level 1: Duty Lead / Field Officer</option>
                  <option value={2}>Level 2: Department Supervisor</option>
                  <option value={3}>Level 3: Senior Admin / Commissioner</option>
                </select>
                <input
                  type="text"
                  value={escReason}
                  onChange={(e) => setEscReason(e.target.value)}
                  placeholder="Escalation justification (min 5 chars)..."
                  className="sm:col-span-2 border border-slate-200 rounded-lg px-3 py-2"
                />
              </div>
              <button
                type="button"
                disabled={!selectedReport || busy}
                onClick={() => selectedReport && handleEscalateReport(selectedReport)}
                className="px-4 py-2 bg-red-700 text-white font-semibold rounded-lg disabled:opacity-50"
              >
                Trigger Level {escLevel} Escalation
              </button>

              {selectedReport?.escalations && selectedReport.escalations.length > 0 && (
                <div className="pt-3 border-t border-slate-200 space-y-1.5">
                  <div className="font-semibold text-slate-800">Escalation History</div>
                  {selectedReport.escalations.map((e) => (
                    <div key={e.id} className="bg-red-50 border border-red-200 rounded p-2 text-red-950">
                      <strong>Level {e.level}</strong> → {e.targetRole}: {e.reason} (by {e.escalatedBy})
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* MODULE 15: CENTRALIZED AUTHORITY NOTIFICATIONS */}
          {activeModule === 'notifications' && (
            <div className="border border-slate-200 rounded-xl bg-white p-5 space-y-3 text-xs">
              <div className="flex items-center justify-between">
                <h2 className="font-display text-lg font-bold text-slate-900">
                  Authority Notification Center ({unreadNotifs} unread)
                </h2>
                {unreadNotifs > 0 && (
                  <button
                    type="button"
                    onClick={handleMarkAllAuthNotifsRead}
                    className="font-semibold text-green-900 hover:underline"
                  >
                    Mark all read
                  </button>
                )}
              </div>
              {authNotifications.length === 0 ? (
                <p className="text-slate-500 py-8 text-center">No operational notifications yet.</p>
              ) : (
                <div className="divide-y divide-slate-200 max-h-[480px] overflow-y-auto">
                  {authNotifications.map((n) => (
                    <div key={n.id} className="py-3 flex items-start justify-between gap-3">
                      <div>
                        <div className={`text-sm ${n.read ? 'text-slate-700' : 'font-semibold text-slate-900'}`}>
                          {n.title}
                        </div>
                        <div className="text-slate-600 mt-0.5">{n.message}</div>
                        <div className="text-[11px] text-slate-400 mt-0.5">
                          {new Date(n.createdAt).toLocaleString()}
                        </div>
                      </div>
                      {!n.read && (
                        <button
                          type="button"
                          onClick={() => handleMarkAuthNotifRead(n.id)}
                          className="text-green-900 font-semibold hover:underline shrink-0"
                        >
                          Mark read
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* MODULE 16: ANALYTICS & CHARTS */}
          {activeModule === 'analytics' && perfData && (
            <div className="space-y-5">
              <div className="border border-slate-200 rounded-xl bg-white p-5 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <TrendingUp className="w-5 h-5 text-green-900" />
                    <h2 className="font-display text-lg font-bold text-slate-900">
                      Civic Operations Analytics &amp; Resolution Trends
                    </h2>
                  </div>
                  <div className="flex gap-1 bg-slate-100 p-1 rounded-lg text-xs">
                    <button
                      type="button"
                      onClick={() => setTrendWindow('7d')}
                      className={`px-3 py-1 rounded ${trendWindow === '7d' ? 'bg-white font-semibold shadow-sm' : ''}`}
                    >
                      7 Days
                    </button>
                    <button
                      type="button"
                      onClick={() => setTrendWindow('30d')}
                      className={`px-3 py-1 rounded ${trendWindow === '30d' ? 'bg-white font-semibold shadow-sm' : ''}`}
                    >
                      30 Days
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                  <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
                    <div className="text-slate-500">Resolution Rate</div>
                    <div className="font-mono text-2xl font-bold text-green-900 mt-1">
                      {perfData.analytics.resolutionRate}%
                    </div>
                  </div>
                  <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
                    <div className="text-slate-500">Avg Resolution Time</div>
                    <div className="font-mono text-2xl font-bold text-slate-900 mt-1">
                      {perfData.analytics.avgResolutionHours}h
                    </div>
                  </div>
                  <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
                    <div className="text-slate-500">Total Reports</div>
                    <div className="font-mono text-2xl font-bold text-slate-900 mt-1">
                      {perfData.analytics.totalReports}
                    </div>
                  </div>
                  <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
                    <div className="text-slate-500">Animal Rescue Cases</div>
                    <div className="font-mono text-2xl font-bold text-slate-900 mt-1">
                      {perfData.analytics.animalRescueTotal ?? animalRescueReports.length}
                    </div>
                  </div>
                </div>

                {/* Real Trend Bar Chart */}
                <div className="space-y-2">
                  <div className="text-xs font-semibold text-slate-700">
                    Daily Intake vs Resolved ({trendWindow === '7d' ? 'Last 7 Days' : 'Last 30 Days'})
                  </div>
                  <div className="flex items-end gap-1.5 h-36 border border-slate-200 rounded-xl p-3 bg-slate-50 overflow-x-auto">
                    {(trendWindow === '7d'
                      ? perfData.analytics.last7Days
                      : perfData.analytics.last30Days || perfData.analytics.last7Days
                    ).map((day) => {
                      const maxVal = Math.max(
                        1,
                        ...perfData.analytics.last7Days.map((x) => x.total),
                        ...(perfData.analytics.last30Days || []).map((x) => x.total)
                      );
                      const totalH = Math.max(8, Math.round((day.total / maxVal) * 96));
                      const resH = Math.round((day.resolved / maxVal) * 96);
                      return (
                        <div key={day.date} className="flex flex-col items-center justify-end flex-1 min-w-[20px] h-full">
                          <div className="flex items-end gap-0.5 w-full justify-center">
                            <div
                              title={`${day.label}: ${day.total} total`}
                              style={{ height: `${totalH}px` }}
                              className="w-2.5 bg-slate-800 rounded-t"
                            />
                            <div
                              title={`${day.label}: ${day.resolved} resolved`}
                              style={{ height: `${resH}px` }}
                              className="w-2.5 bg-emerald-600 rounded-t"
                            />
                          </div>
                          <span className="text-[10px] text-slate-500 mt-1 truncate max-w-full">{day.label}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                  <div className="border border-slate-200 rounded-lg p-3.5 space-y-1.5">
                    <div className="font-semibold text-slate-800">By Civic Category</div>
                    {Object.entries(perfData.analytics.byCategory).map(([cat, cnt]) => (
                      <div key={cat} className="flex justify-between">
                        <span className="text-slate-700">{cat}</span>
                        <span className="font-mono font-semibold">{cnt}</span>
                      </div>
                    ))}
                  </div>
                  <div className="border border-slate-200 rounded-lg p-3.5 space-y-1.5">
                    <div className="font-semibold text-slate-800">By Lifecycle Stage</div>
                    {Object.entries(perfData.analytics.byStatus).map(([st, cnt]) => (
                      <div key={st} className="flex justify-between">
                        <span className="text-slate-700">{st}</span>
                        <span className="font-mono font-semibold">{cnt}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* MODULE 17: PRIVACY, SECURITY, AUDIT TRAIL & SMS LOGS */}
          {activeModule === 'logs' && (
            <div className="space-y-5 text-xs">
              <div className="border border-slate-200 rounded-xl bg-white p-5 space-y-2">
                <h2 className="font-display text-base font-bold text-slate-900">
                  Privacy, RBAC Separation &amp; DPDP Security Controls
                </h2>
                <ul className="list-disc pl-5 text-slate-700 space-y-1">
                  <li>Strict Dashboard Separation: Citizen accounts cannot access Authority APIs (HTTP 401/403), and Authority Bearer sessions are blocked from Citizen mutations (HTTP 403).</li>
                  <li>Conflict-of-Interest Guard: Target officers cannot review, self-assign, or close citizen accountability complaints filed against themselves.</li>
                  <li>Mandatory Resolution Evidence Gate: Before &amp; After photos + completion notes enforced server-side before case closure.</li>
                </ul>
              </div>

              <div className="border border-slate-200 rounded-xl bg-white p-5 space-y-3">
                <h3 className="font-display text-base font-bold text-slate-900">
                  SMS Caregiver Delivery &amp; Twilio Webhook Logs ({smsLogs.length})
                </h3>
                {smsLogs.length === 0 ? (
                  <p className="text-slate-500">No SMS alert dispatches logged yet.</p>
                ) : (
                  <div className="divide-y divide-slate-200 max-h-56 overflow-y-auto">
                    {smsLogs.map((l) => (
                      <div key={l.id} className="py-2 flex flex-wrap justify-between gap-2">
                        <div>
                          <span className="font-mono font-semibold text-slate-900">{l.emergencyType.toUpperCase()}</span> ·{' '}
                          {l.recipientName} ({l.recipientPhone}) · Status: <strong>{l.status}</strong>
                          {l.error && <span className="text-red-700"> — {l.error}</span>}
                        </div>
                        <span className="font-mono text-slate-500">{new Date(l.updatedAt).toLocaleString()}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="border border-slate-200 rounded-xl bg-white p-5 space-y-3">
                <h3 className="font-display text-base font-bold text-slate-900">
                  Governance Audit Trail ({auditLogs.length})
                </h3>
                <div className="divide-y divide-slate-200 max-h-72 overflow-y-auto">
                  {auditLogs.map((log) => (
                    <div key={log.id} className="py-2 flex flex-wrap justify-between gap-2">
                      <div>
                        <span className="font-mono font-semibold text-slate-900">{log.action}</span> · {log.detail}
                      </div>
                      <span className="font-mono text-slate-500">{new Date(log.timestamp).toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
