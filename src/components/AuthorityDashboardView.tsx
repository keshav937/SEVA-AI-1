import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  KeyRound,
  Lock,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Volume2,
} from 'lucide-react';
import { doc, increment, serverTimestamp, updateDoc } from 'firebase/firestore';
import { useAuth } from '../contexts/AuthContext';
import { db } from '../lib/firebase';
import { CivicReport, ReportStatus } from '../types/seva';

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

interface AuthorityDashboardViewProps {
  onSpeakText: (text: string) => void;
}

export const AuthorityDashboardView: React.FC<AuthorityDashboardViewProps> = ({ onSpeakText }) => {
  const { firebaseUser, authoritySession, verifyAuthorityAccess, clearAuthoritySession, signInWithGoogle } =
    useAuth();

  const [passcodeConfigured, setPasscodeConfigured] = useState<boolean | null>(null);
  const [setupPasscode, setSetupPasscode] = useState('');
  const [department, setDepartment] = useState('Municipal Corporation');
  const [jurisdiction, setJurisdiction] = useState('Central & Citywide');
  const [passcodeInput, setPasscodeInput] = useState('');
  const [authMsg, setAuthMsg] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

  const [queueTab, setQueueTab] = useState<'operational' | 'fraud_review' | 'analytics' | 'admin'>('operational');
  const [statusFilter, setStatusFilter] = useState('All');
  const [severityFilter, setSeverityFilter] = useState('All');
  const [reports, setReports] = useState<CivicReport[]>([]);
  const [stats, setStats] = useState<Record<string, number>>({});
  const [sosEvents, setSosEvents] = useState<any[]>([]);
  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [selectedReport, setSelectedReport] = useState<CivicReport | null>(null);

  // Action fields
  const [officerName, setOfficerName] = useState('');
  const [actionNote, setActionNote] = useState('');
  const [nextStatus, setNextStatus] = useState<ReportStatus>('Authority Acknowledged');
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    fetch('/api/auth/authority-config')
      .then((r) => r.json())
      .then((d) => setPasscodeConfigured(Boolean(d.passcodeConfigured)))
      .catch(() => setPasscodeConfigured(true));
  }, []);

  const fetchAuthorityData = useCallback(async () => {
    if (!authoritySession) return;
    const fq = queueTab === 'fraud_review' ? 'fraud_review' : queueTab === 'operational' ? 'operational' : 'all';
    const qs = new URLSearchParams({
      fraudQueue: fq,
      status: statusFilter,
      severity: severityFilter,
    });
    const res = await fetch(`/api/authority/reports?${qs.toString()}`, {
      headers: { Authorization: `Bearer ${authoritySession.token}` },
    });
    if (!res.ok) return;
    const data = await res.json();
    setReports(data.reports || []);
    setStats(data.stats || {});
    setSosEvents(data.sosEvents || []);
    setAuditLogs(data.auditLogs || []);
  }, [authoritySession, queueTab, severityFilter, statusFilter]);

  useEffect(() => {
    fetchAuthorityData();
  }, [fetchAuthorityData]);

  // Real-time WebSocket listener for incoming civic reports & SOS alerts
  useEffect(() => {
    if (!authoritySession) return;
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}/ws`);
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'subscribe', topic: 'authority:all' }));
    };
    ws.onmessage = () => {
      fetchAuthorityData();
    };
    return () => ws.close();
  }, [authoritySession, fetchAuthorityData]);

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
    setAuthMsg('Official department access code configured. You can now sign in directly.');
  };

  const handleVerifySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthMsg(null);
    setVerifying(true);
    try {
      await verifyAuthorityAccess({
        department,
        jurisdiction,
        passcode: passcodeInput,
      });
    } catch (err: any) {
      setAuthMsg(err?.message || 'Verification failed.');
    } finally {
      setVerifying(false);
    }
  };

  const handleManageReport = async (fraudDecision?: 'cleared' | 'rejected' | 'investigation_queue') => {
    if (!selectedReport || !authoritySession) return;
    setUpdating(true);
    try {
      const res = await fetch(`/api/authority/reports/${encodeURIComponent(selectedReport.id)}/manage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authoritySession.token}`,
        },
        body: JSON.stringify({
          status: fraudDecision === 'rejected' ? 'Rejected' : fraudDecision ? selectedReport.status : nextStatus,
          assignedOfficer: officerName || selectedReport.assignedOfficer,
          actionNotes: actionNote || undefined,
          resolutionNotes: nextStatus === 'Resolved' ? actionNote : undefined,
          fraudDecision,
        }),
      });

      const data = await res.json();
      if (res.ok && data.report) {
        setSelectedReport(data.report);
        setActionNote('');
        await fetchAuthorityData();

        // Sync back to Firestore if bootstrapped admin is signed in (updates citizen real-time view & verified points!)
        try {
          await updateDoc(doc(db, 'reports', selectedReport.id), {
            status: data.report.status,
            fraudQueueStatus: data.report.fraudQueueStatus,
            assignedOfficer: data.report.assignedOfficer || '',
            actionNotes: data.report.actionNotes || '',
            resolutionNotes: data.report.resolutionNotes || '',
            updatedAt: serverTimestamp(),
          });

          if (nextStatus === 'Resolved' && !fraudDecision && data.report.fraudQueueStatus !== 'rejected') {
            await updateDoc(doc(db, 'users', selectedReport.reporterUid), {
              points: increment(50),
              verifiedReportsCount: increment(1),
              resolvedReportsCount: increment(1),
              updatedAt: serverTimestamp(),
            });
            await updateDoc(doc(db, 'leaderboard', selectedReport.reporterUid), {
              points: increment(50),
              verifiedReportsCount: increment(1),
              resolvedReportsCount: increment(1),
              updatedAt: serverTimestamp(),
            });
          }
        } catch {
          // Non-bootstrapped department officers update via operational server ledger + WebSocket
        }
      }
    } finally {
      setUpdating(false);
    }
  };

  const speakDashboardBriefing = () => {
    const summary = `Authority Operational Briefing for ${authoritySession?.department}. There are ${
      stats.total ?? 0
    } total reports, ${stats.pending ?? 0} pending complaints, ${
      stats.resolved ?? 0
    } resolved complaints, and ${stats.highPriority ?? 0} high priority incidents. ${
      stats.underVerification ?? 0
    } items are currently held in the Seva Trust fraud verification queue.`;
    onSpeakText(summary);
  };

  if (!authoritySession) {
    return (
      <div className="max-w-xl mx-auto space-y-6">
        <div>
          <h1 className="font-display text-2xl font-bold text-slate-900">
            Authority &amp; Department Portal
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Direct authenticated access for verified municipal, police, medical, and emergency personnel. Zero manual approval waiting queue.
          </p>
        </div>

        {!firebaseUser && (
          <div className="border border-amber-200 bg-amber-50 rounded-xl p-4 flex items-center justify-between gap-3">
            <span className="text-xs text-amber-950">
              Step 1: Authenticate your official Google identity.
            </span>
            <button
              type="button"
              onClick={() => signInWithGoogle()}
              className="px-4 py-2 bg-green-900 text-white text-xs font-medium rounded-lg"
            >
              Sign In with Google
            </button>
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
              No <code className="font-mono">AUTHORITY_ACCESS_CODE</code> environment secret is set yet. Create your server-hashed official department access code below (min 6 chars).
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
              <button
                type="submit"
                className="px-4 py-2 bg-slate-900 text-white text-xs font-medium rounded-lg"
              >
                Save Passcode
              </button>
            </div>
          </form>
        )}

        <form
          onSubmit={handleVerifySubmit}
          className="border border-slate-200 rounded-xl bg-white p-6 space-y-4"
        >
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              Assigned Department
            </label>
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
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              Jurisdiction / Ward Assignment
            </label>
            <input
              type="text"
              value={jurisdiction}
              onChange={(e) => setJurisdiction(e.target.value)}
              className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2.5"
              required
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              Department-Issued Access Code
            </label>
            <input
              type="password"
              value={passcodeInput}
              onChange={(e) => setPasscodeInput(e.target.value)}
              placeholder="Enter official department code"
              className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2.5"
              required
            />
          </div>

          {authMsg && (
            <div className="text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded-lg p-3">
              {authMsg}
            </div>
          )}

          <button
            type="submit"
            disabled={!firebaseUser || verifying}
            className="w-full py-2.5 bg-green-900 text-white text-sm font-medium rounded-lg hover:bg-green-800 disabled:opacity-50 inline-flex items-center justify-center gap-2"
          >
            <Lock className="w-4 h-4" />
            {verifying ? 'Verifying Credentials...' : 'Enter Authority Dashboard Directly'}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900">
            Authority Operations · {authoritySession.department}
          </h1>
          <p className="text-sm text-slate-600 mt-0.5">
            Jurisdiction: {authoritySession.jurisdiction} · Role: {authoritySession.role.toUpperCase()}
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
            onClick={fetchAuthorityData}
            className="inline-flex items-center gap-1.5 px-3 py-2 border border-slate-200 text-slate-700 text-xs font-medium rounded-lg hover:bg-slate-50"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </button>
          <button
            type="button"
            onClick={clearAuthoritySession}
            className="px-3 py-2 border border-slate-200 text-slate-700 text-xs font-medium rounded-lg hover:bg-slate-50"
          >
            Lock Portal
          </button>
        </div>
      </div>

      {/* Live Statistics Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
        {[
          { label: 'Total Reports', val: stats.total ?? 0 },
          { label: 'New', val: stats.newReports ?? 0 },
          { label: 'Pending', val: stats.pending ?? 0 },
          { label: 'Resolved', val: stats.resolved ?? 0 },
          { label: 'High Priority', val: stats.highPriority ?? 0 },
          { label: 'Fraud Queue', val: stats.underVerification ?? 0 },
        ].map((s) => (
          <div key={s.label} className="border border-slate-200 rounded-xl bg-white p-3.5">
            <div className="text-xs text-slate-500">{s.label}</div>
            <div className="font-mono text-2xl font-bold text-slate-900 mt-1 tabular-nums">{s.val}</div>
          </div>
        ))}
      </div>

      {/* Active SOS Alert Banner */}
      {sosEvents.some((s) => s.status === 'active') && (
        <div className="border border-red-300 bg-red-50 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 text-red-800 text-sm font-semibold">
            <ShieldAlert className="w-5 h-5" />
            Active Citizen SOS Alert(s):{' '}
            {sosEvents
              .filter((s) => s.status === 'active')
              .map((s) => `${s.displayName} (${s.address})`)
              .join(' | ')}
          </div>
        </div>
      )}

      {/* Workspace Tabs */}
      <div className="flex flex-wrap items-center gap-2 p-1 bg-slate-100 rounded-lg w-fit">
        {[
          { id: 'operational', label: 'Operational Complaints' },
          { id: 'fraud_review', label: 'Seva Trust Fraud Queue' },
          { id: 'analytics', label: 'Department Analytics' },
          { id: 'admin', label: 'Admin & Audit Logs' },
        ].map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setQueueTab(t.id as any)}
            className={`px-3.5 py-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              queueTab === t.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {(queueTab === 'operational' || queueTab === 'fraud_review') && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Reports Table / List */}
          <div className="lg:col-span-7 border border-slate-200 rounded-xl bg-white p-4 space-y-3">
            <div className="flex flex-wrap gap-2">
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 bg-white"
              >
                <option value="All">Status: All</option>
                <option value="Submitted">Submitted</option>
                <option value="Authority Acknowledged">Authority Acknowledged</option>
                <option value="Assigned">Assigned</option>
                <option value="In Progress">In Progress</option>
                <option value="Resolved">Resolved</option>
                <option value="Rejected">Rejected</option>
              </select>

              <select
                value={severityFilter}
                onChange={(e) => setSeverityFilter(e.target.value)}
                className="text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 bg-white"
              >
                <option value="All">Severity: All</option>
                <option value="Low">Low</option>
                <option value="Medium">Medium</option>
                <option value="High">High</option>
                <option value="Critical">Critical</option>
              </select>
            </div>

            {reports.length === 0 ? (
              <div className="py-10 text-center text-sm text-slate-500">
                No reports currently in this queue.
              </div>
            ) : (
              <div className="divide-y divide-slate-200">
                {reports.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => {
                      setSelectedReport(r);
                      setNextStatus(r.status);
                      setOfficerName(r.assignedOfficer || '');
                    }}
                    className={`w-full text-left py-3 px-2.5 rounded-lg transition-colors ${
                      selectedReport?.id === r.id ? 'bg-emerald-50/50' : 'hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-mono font-semibold text-slate-800">{r.complaintId}</span>
                      <span className="text-slate-600">
                        {r.status} · Risk {r.fraudRiskScore}/100
                      </span>
                    </div>
                    <div className="font-medium text-sm text-slate-900 mt-0.5">{r.title}</div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      {r.category} · {r.severity} · {r.address}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Management Drawer */}
          <div className="lg:col-span-5 border border-slate-200 rounded-xl bg-white p-5 space-y-4">
            {!selectedReport ? (
              <div className="py-12 text-center text-sm text-slate-500">
                Select a report to inspect AI screening, read details aloud, assign an officer, or update status.
              </div>
            ) : (
              <>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-mono text-xs text-slate-500">{selectedReport.complaintId}</div>
                    <h3 className="font-display text-base font-bold text-slate-900 mt-0.5">
                      {selectedReport.title}
                    </h3>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      onSpeakText(
                        `Complaint ${selectedReport.complaintId}, category ${selectedReport.category}, severity ${selectedReport.severity}, at ${selectedReport.address}. Description: ${selectedReport.description}`
                      )
                    }
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-slate-100 text-slate-800 text-xs font-medium rounded-md hover:bg-slate-200 shrink-0"
                  >
                    <Volume2 className="w-3.5 h-3.5" />
                    Read Aloud
                  </button>
                </div>

                <p className="text-xs text-slate-700 leading-relaxed">{selectedReport.description}</p>

                {selectedReport.photoDataUrl && (
                  <img
                    src={selectedReport.photoDataUrl}
                    alt="Report evidence"
                    className="w-full h-40 object-cover rounded-lg border border-slate-200"
                  />
                )}

                <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs space-y-1">
                  <div>
                    <strong>Seva Trust Risk:</strong> {selectedReport.fraudRiskScore}/100 (
                    {selectedReport.fraudRiskLevel}) · Queue:{' '}
                    {selectedReport.fraudQueueStatus.replace(/_/g, ' ')}
                  </div>
                  {selectedReport.fraudExplanation && (
                    <div className="text-slate-600">{selectedReport.fraudExplanation}</div>
                  )}
                </div>

                <div className="space-y-3 pt-2 border-t border-slate-200">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Assign Officer
                    </label>
                    <input
                      type="text"
                      value={officerName}
                      onChange={(e) => setOfficerName(e.target.value)}
                      placeholder="Officer name or field unit"
                      className="w-full text-xs border border-slate-200 rounded-lg px-3 py-2"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Update Operational Status
                    </label>
                    <select
                      value={nextStatus}
                      onChange={(e) => setNextStatus(e.target.value as ReportStatus)}
                      className="w-full text-xs border border-slate-200 rounded-lg px-3 py-2 bg-white"
                    >
                      <option value="Submitted">Submitted</option>
                      <option value="Authority Acknowledged">Authority Acknowledged</option>
                      <option value="Assigned">Assigned</option>
                      <option value="In Progress">In Progress</option>
                      <option value="Resolved">Resolved</option>
                      <option value="Rejected">Rejected</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Action / Resolution Notes
                    </label>
                    <textarea
                      rows={2}
                      value={actionNote}
                      onChange={(e) => setActionNote(e.target.value)}
                      placeholder="Field inspection or resolution remarks..."
                      className="w-full text-xs border border-slate-200 rounded-lg px-3 py-2"
                    />
                  </div>

                  <button
                    type="button"
                    disabled={updating}
                    onClick={() => handleManageReport()}
                    className="w-full py-2.5 bg-green-900 text-white text-xs font-medium rounded-lg hover:bg-green-800 disabled:opacity-50"
                  >
                    {updating ? 'Saving...' : 'Save Status & Notify Citizen'}
                  </button>

                  {queueTab === 'fraud_review' && (
                    <div className="grid grid-cols-2 gap-2 pt-2">
                      <button
                        type="button"
                        onClick={() => handleManageReport('cleared')}
                        className="py-2 bg-emerald-700 text-white text-xs font-medium rounded-lg inline-flex items-center justify-center gap-1"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        Clear to Operations
                      </button>
                      <button
                        type="button"
                        onClick={() => handleManageReport('rejected')}
                        className="py-2 bg-red-600 text-white text-xs font-medium rounded-lg inline-flex items-center justify-center gap-1"
                      >
                        <AlertTriangle className="w-3.5 h-3.5" />
                        Reject Report
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {queueTab === 'analytics' && (
        <div className="border border-slate-200 rounded-xl bg-white p-5 space-y-4">
          <div className="flex items-center gap-2">
            <BarChart3 className="w-5 h-5 text-green-900" />
            <h3 className="font-display text-lg font-semibold text-slate-900">
              Live Database Category Breakdown
            </h3>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {[
              { label: 'Medical Emergencies', val: stats.medicalEmergencies ?? 0 },
              { label: 'Road Accidents', val: stats.accidents ?? 0 },
              { label: 'Women & Child Safety', val: stats.womenSafety ?? 0 },
              { label: 'Animal Rescue', val: stats.animalRescue ?? 0 },
            ].map((item) => (
              <div key={item.label} className="bg-slate-50 border border-slate-200 rounded-lg p-3.5">
                <div className="text-xs text-slate-500">{item.label}</div>
                <div className="font-mono text-xl font-bold text-slate-900 mt-1 tabular-nums">
                  {item.val}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {queueTab === 'admin' && (
        <div className="border border-slate-200 rounded-xl bg-white p-5 space-y-4">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-green-900" />
            <h3 className="font-display text-lg font-semibold text-slate-900">
              Audit Logs &amp; Governance Trail
            </h3>
          </div>
          {auditLogs.length === 0 ? (
            <p className="text-xs text-slate-500">
              Audit logs are visible when authenticated as Platform Administration.
            </p>
          ) : (
            <div className="divide-y divide-slate-200 text-xs">
              {auditLogs.map((log) => (
                <div key={log.id} className="py-2.5 flex flex-wrap justify-between gap-2">
                  <div>
                    <span className="font-mono font-semibold text-slate-900">{log.action}</span> ·{' '}
                    <span className="text-slate-700">{log.detail}</span>
                  </div>
                  <span className="font-mono text-slate-500 tabular-nums">
                    {new Date(log.timestamp).toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
