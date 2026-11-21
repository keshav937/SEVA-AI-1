import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  FileUp,
  Lock,
  MessageSquareWarning,
  ShieldCheck,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import {
  CitizenComplaintAgainstAuthority,
  CivicReport,
  UploadedFileRef,
} from '../types/seva';

const DEPARTMENTS = [
  'Municipal Corporation',
  'Public Works Department',
  'Traffic Police',
  'Police Department',
  'Emergency Control Room',
  'Medical Services',
  'Animal Welfare & Rescue',
];

const COMPLAINT_CATEGORIES = [
  'Delayed Action / Negligence',
  'Premature Closure / False Resolution',
  'Misconduct / Unprofessional Behavior',
  'Bribery or Integrity Concern',
  'Refusal to Register Civic Issue',
  'Other Oversight Issue',
];

interface ComplaintBoxViewProps {
  myReports: CivicReport[];
}

export const ComplaintBoxView: React.FC<ComplaintBoxViewProps> = ({ myReports }) => {
  const { firebaseUser, profile, signingIn, signInWithGoogle } = useAuth();

  const [subject, setSubject] = useState('');
  const [relatedReportId, setRelatedReportId] = useState('');
  const [targetDepartment, setTargetDepartment] = useState(DEPARTMENTS[0]);
  const [targetOfficerName, setTargetOfficerName] = useState('');
  const [category, setCategory] = useState(COMPLAINT_CATEGORIES[0]);
  const [description, setDescription] = useState('');
  const [isAnonymous, setIsAnonymous] = useState(false);
  const [evidenceFiles, setEvidenceFiles] = useState<UploadedFileRef[]>([]);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [submittedRef, setSubmittedRef] = useState<string | null>(null);
  const [myComplaints, setMyComplaints] = useState<CitizenComplaintAgainstAuthority[]>([]);

  const loadComplaints = useCallback(async () => {
    if (!firebaseUser) {
      setMyComplaints([]);
      return;
    }
    try {
      const res = await fetch(`/api/citizen/complaints/${encodeURIComponent(firebaseUser.uid)}`);
      const data = await res.json();
      if (Array.isArray(data.complaints)) setMyComplaints(data.complaints);
    } catch {}
  }, [firebaseUser]);

  useEffect(() => {
    loadComplaints();
  }, [loadComplaints]);

  useEffect(() => {
    if (!firebaseUser) return;
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}/ws`);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'subscribe', topic: `citizen:${firebaseUser.uid}` }));
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.event === 'complaint:updated') loadComplaints();
      } catch {}
    };
    return () => ws.close();
  }, [firebaseUser, loadComplaints]);

  const handleUploadEvidence = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploading(true);
    setErrorMsg(null);
    try {
      const form = new FormData();
      Array.from(files).forEach((f) => form.append('files', f));
      const res = await fetch('/api/uploads', { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed.');
      setEvidenceFiles((prev) => [...prev, ...(data.files || [])]);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to upload supporting files.');
    } finally {
      setUploading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setSubmittedRef(null);
    if (!firebaseUser) {
      setErrorMsg('Please sign in with Google to file a confidential oversight complaint.');
      return;
    }
    if (subject.trim().length < 4 || description.trim().length < 10) {
      setErrorMsg('Please enter a subject and detailed description (minimum 10 characters).');
      return;
    }

    // Look up related report assignedOfficerUid if selected
    const matchedReport = myReports.find((r) => r.complaintId === relatedReportId || r.id === relatedReportId);

    setSubmitting(true);
    try {
      const res = await fetch('/api/complaints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          citizenUid: firebaseUser.uid,
          citizenName: profile?.displayName || firebaseUser.displayName || 'Citizen',
          isAnonymous,
          subject: subject.trim(),
          relatedReportId: relatedReportId || undefined,
          targetDepartment,
          targetOfficerUid: matchedReport?.assignedOfficerUid || undefined,
          targetOfficerName: (targetOfficerName.trim() || matchedReport?.assignedOfficer || '').trim() || undefined,
          category,
          description: description.trim(),
          evidenceFiles,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to submit complaint.');
      setSubmittedRef(data.complaint.complaintRef);
      setSubject('');
      setDescription('');
      setTargetOfficerName('');
      setRelatedReportId('');
      setEvidenceFiles([]);
      await loadComplaints();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to file complaint.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <div className="inline-flex items-center gap-1.5 text-xs font-semibold text-green-900 mb-1">
          <MessageSquareWarning className="w-4 h-4" />
          Independent Civic Oversight
        </div>
        <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900">
          Citizen Complaint Box (Against Authority)
        </h1>
        <p className="text-sm text-slate-600 mt-1">
          Report delayed action, premature resolution, misconduct, or negligence. Complaints are routed strictly to independent Supervisors &amp; Platform Administration — the accused officer can never view, assign, or resolve their own complaint.
        </p>
      </div>

      {!firebaseUser && (
        <div className="border border-amber-200 bg-amber-50 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-amber-950">
            Sign in with Google to track oversight updates securely. You may still toggle &ldquo;Submit Anonymously&rdquo; so your name is shielded from department review logs.
          </p>
          <button
            type="button"
            disabled={signingIn}
            onClick={() => signInWithGoogle()}
            className="px-4 py-2 bg-green-900 text-white text-xs font-medium rounded-lg"
          >
            {signingIn ? 'Signing in...' : 'Sign In with Google'}
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <form onSubmit={handleSubmit} className="lg:col-span-6 border border-slate-200 rounded-xl bg-white p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-lg font-bold text-slate-900">File an Oversight Complaint</h2>
            <span className="inline-flex items-center gap-1 text-xs text-slate-500">
              <Lock className="w-3.5 h-3.5" /> Protected &amp; Audited
            </span>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Complaint Subject</label>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="e.g., Pothole marked Resolved without repair or after photos"
              className="w-full text-xs border border-slate-200 rounded-lg px-3 py-2.5"
              required
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Complaint Category</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full text-xs border border-slate-200 rounded-lg px-3 py-2 bg-white"
              >
                {COMPLAINT_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Target Department</label>
              <select
                value={targetDepartment}
                onChange={(e) => setTargetDepartment(e.target.value)}
                className="w-full text-xs border border-slate-200 rounded-lg px-3 py-2 bg-white"
              >
                {DEPARTMENTS.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Related Civic Report ID (Optional)
              </label>
              <select
                value={relatedReportId}
                onChange={(e) => {
                  const val = e.target.value;
                  setRelatedReportId(val);
                  const found = myReports.find((r) => r.complaintId === val);
                  if (found) {
                    setTargetDepartment(found.department);
                    if (found.assignedOfficer) setTargetOfficerName(found.assignedOfficer);
                  }
                }}
                className="w-full text-xs border border-slate-200 rounded-lg px-3 py-2 bg-white"
              >
                <option value="">None / General Complaint</option>
                {myReports.map((r) => (
                  <option key={r.id} value={r.complaintId}>
                    {r.complaintId} — {r.title.slice(0, 32)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Officer Name (If known)
              </label>
              <input
                type="text"
                value={targetOfficerName}
                onChange={(e) => setTargetOfficerName(e.target.value)}
                placeholder="Name / Designation of officer"
                className="w-full text-xs border border-slate-200 rounded-lg px-3 py-2"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Detailed Description</label>
            <textarea
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Provide dates, behavior, inaction details, or discrepancies..."
              className="w-full text-xs border border-slate-200 rounded-lg px-3 py-2"
              required
            />
          </div>

          <div className="space-y-2">
            <label className="border border-dashed border-slate-300 rounded-lg p-3 flex items-center gap-3 cursor-pointer hover:bg-slate-50">
              <FileUp className="w-5 h-5 text-green-900 shrink-0" />
              <div className="text-xs">
                <div className="font-semibold text-slate-800">
                  {uploading ? 'Uploading Evidence...' : 'Attach Supporting Evidence (Images / PDF)'}
                </div>
                <div className="text-slate-500">
                  {evidenceFiles.length > 0 ? `${evidenceFiles.length} file(s) attached` : 'Screenshots, site photos, or documents'}
                </div>
              </div>
              <input
                type="file"
                accept="image/*,application/pdf"
                multiple
                onChange={handleUploadEvidence}
                className="hidden"
              />
            </label>
          </div>

          <label className="flex items-center gap-2 text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded-lg p-3 cursor-pointer">
            <input
              type="checkbox"
              checked={isAnonymous}
              onChange={(e) => setIsAnonymous(e.target.checked)}
              className="rounded border-slate-300 text-green-900"
            />
            <span>
              <strong>Submit Anonymously:</strong> Hide my name from department review records (system still syncs oversight updates to my private tracking portal).
            </span>
          </label>

          <button
            type="submit"
            disabled={submitting}
            className="w-full py-2.5 bg-green-900 text-white text-sm font-medium rounded-lg hover:bg-green-800 disabled:opacity-50"
          >
            {submitting ? 'Filing Confidentially...' : 'Submit Oversight Complaint'}
          </button>

          {errorMsg && (
            <div className="flex items-start gap-2 text-xs text-red-800 bg-red-50 border border-red-200 rounded-lg p-3">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{errorMsg}</span>
            </div>
          )}

          {submittedRef && (
            <div className="flex items-start gap-2 text-xs text-emerald-950 bg-emerald-50 border border-emerald-200 rounded-lg p-3.5">
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                <strong>Complaint Filed:</strong> Reference{' '}
                <span className="font-mono font-bold">{submittedRef}</span>. Routed to Supervisor / Independent Oversight.
              </div>
            </div>
          )}
        </form>

        {/* Citizen Complaint Status Tracker */}
        <div className="lg:col-span-6 border border-slate-200 rounded-xl bg-white p-5 space-y-4">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-green-900" />
            <h2 className="font-display text-base font-bold text-slate-900">
              Your Filed Oversight Complaints ({myComplaints.length})
            </h2>
          </div>

          {myComplaints.length === 0 ? (
            <div className="py-10 text-center text-xs text-slate-500 border border-dashed border-slate-200 rounded-lg">
              You have not filed any complaints against authorities.
            </div>
          ) : (
            <div className="space-y-3">
              {myComplaints.map((c) => (
                <div key={c.id} className="border border-slate-200 rounded-xl p-4 space-y-2.5 bg-slate-50">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="font-mono font-bold text-slate-900">{c.complaintRef}</span>
                    <span className="px-2 py-0.5 bg-white border border-slate-200 rounded font-semibold text-green-900">
                      {c.status}
                    </span>
                  </div>
                  <div className="text-sm font-semibold text-slate-900">{c.subject}</div>
                  <div className="text-xs text-slate-600">
                    Target: <strong>{c.targetDepartment}</strong>
                    {c.targetOfficerName ? ` (${c.targetOfficerName})` : ''} · {c.category}
                  </div>
                  <p className="text-xs text-slate-700">{c.description}</p>
                  {c.reviewerName && (
                    <div className="text-xs text-slate-700">
                      <strong>Assigned Independent Reviewer:</strong> {c.reviewerName}
                    </div>
                  )}
                  {c.finalResolution && (
                    <div className="text-xs bg-emerald-50 border border-emerald-200 text-emerald-950 rounded-lg p-2.5">
                      <strong>Final Oversight Resolution:</strong> {c.finalResolution}
                    </div>
                  )}
                  <div className="pt-2 border-t border-slate-200 space-y-1.5">
                    {c.publicUpdates.map((u) => (
                      <div key={u.id} className="text-[11px] text-slate-600">
                        <span className="font-semibold text-slate-800">{u.actor}</span> ({u.status}): {u.message}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
