import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Camera,
  CheckCircle2,
  Clock,
  MapPin,
  MessageSquare,
  Mic,
  MicOff,
  RotateCcw,
  Search,
  Star,
} from 'lucide-react';
import { doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { useAuth } from '../contexts/AuthContext';
import { OperationType, buildFirestoreErrorInfo, db } from '../lib/firebase';
import { CivicReport, SupportedLanguage, UploadedFileRef } from '../types/seva';

interface MyReportsViewProps {
  reports: CivicReport[];
  language?: SupportedLanguage;
  onGoToReport: () => void;
  onRefreshReports?: () => void;
}

export const MyReportsView: React.FC<MyReportsViewProps> = ({
  reports,
  language = 'en',
  onGoToReport,
  onRefreshReports,
}) => {
  const { firebaseUser, signingIn, signInWithGoogle } = useAuth();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [extraDetail, setExtraDetail] = useState('');
  const [extraFiles, setExtraFiles] = useState<UploadedFileRef[]>([]);
  const [uploadingExtra, setUploadingExtra] = useState(false);

  const [rating, setRating] = useState(5);
  const [feedbackComment, setFeedbackComment] = useState('');
  const [disputeReason, setDisputeReason] = useState('');
  const [showReopenBox, setShowReopenBox] = useState(false);
  const [submittingAction, setSubmittingAction] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);

  // Voice & Manual Follow-Up Reference Lookup
  const [lookupInput, setLookupInput] = useState('');
  const [lookupResult, setLookupResult] = useState<CivicReport | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const [recordingRef, setRecordingRef] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    if (!selectedId && reports.length > 0) {
      setSelectedId(reports[0].id);
    }
  }, [reports, selectedId]);

  useEffect(() => {
    return () => {
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const selected =
    reports.find((r) => r.id === selectedId) ||
    (lookupResult && lookupResult.id === selectedId ? lookupResult : null);

  const handleLookup = async (refQuery?: string) => {
    const queryStr = (refQuery ?? lookupInput).trim();
    setLookupError(null);
    setLookupResult(null);
    if (!queryStr) {
      setLookupError('Enter or speak a Reference Number (e.g., REF-...) or Complaint ID (e.g., SEVA-...).');
      return;
    }
    setLookingUp(true);
    try {
      const res = await fetch(`/api/reports/lookup/${encodeURIComponent(queryStr)}`);
      const data = await res.json();
      if (!res.ok || !data.report) {
        setLookupError(data.error || `No report found matching "${queryStr}".`);
        return;
      }
      setLookupResult(data.report);
      setSelectedId(data.report.id);
    } catch (err: any) {
      setLookupError(err?.message || 'Unable to look up reference.');
    } finally {
      setLookingUp(false);
    }
  };

  const startVoiceReferenceCapture = async () => {
    setLookupError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setLookupError('Microphone unavailable in this browser. Type your Reference Number manually.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      recorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        setRecordingRef(false);
        if (blob.size < 400) {
          setLookupError('Recording too short. Speak your reference ID clearly.');
          return;
        }
        setLookingUp(true);
        try {
          const form = new FormData();
          form.append('audio', blob, 'ref_lookup.webm');
          form.append('language', language);
          const res = await fetch('/api/voice/stt', { method: 'POST', body: form });
          const data = await res.json();
          if (!res.ok || !data.text) {
            throw new Error(data.error || 'Could not recognize reference ID.');
          }
          const normalized = String(data.text).replace(/\s+/g, '').toUpperCase();
          setLookupInput(normalized);
          await handleLookup(normalized);
        } catch (err: any) {
          setLookupError(err?.message || 'Voice lookup failed.');
        } finally {
          setLookingUp(false);
        }
      };
      recorderRef.current = recorder;
      recorder.start(250);
      setRecordingRef(true);
    } catch (err: any) {
      setLookupError(err?.message || 'Microphone access denied.');
    }
  };

  const stopVoiceReferenceCapture = () => {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop();
    }
  };

  const handleUploadExtraEvidence = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    setUploadingExtra(true);
    setActionErr(null);
    try {
      const form = new FormData();
      for (const f of files.slice(0, 6)) form.append('files', f);
      const res = await fetch('/api/uploads', { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed.');
      setExtraFiles((prev) => [...prev, ...(data.files || [])].slice(0, 6));
    } catch (err: any) {
      setActionErr(err?.message || 'Unable to upload additional evidence.');
    } finally {
      setUploadingExtra(false);
    }
  };

  const submitFollowUp = async (report: CivicReport) => {
    if (!firebaseUser) return;
    if (!extraDetail.trim() && extraFiles.length === 0) {
      setActionErr('Enter follow-up details or attach an evidence photo/PDF.');
      return;
    }
    setActionMsg(null);
    setActionErr(null);
    setSubmittingAction(true);
    try {
      const res = await fetch(`/api/citizen/reports/${encodeURIComponent(report.id)}/follow-up`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uid: firebaseUser.uid,
          note: extraDetail.trim() || undefined,
          evidenceFiles: extraFiles,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Unable to update report.');

      if (extraDetail.trim()) {
        try {
          const merged = `${report.description}\n[Citizen Follow-Up]: ${extraDetail.trim()}`.slice(0, 3000);
          await updateDoc(doc(db, 'reports', report.id), {
            description: merged,
            updatedAt: serverTimestamp(),
          });
        } catch {
          // Server ledger already synced
        }
      }

      setExtraDetail('');
      setExtraFiles([]);
      setActionMsg('Additional details & evidence saved and routed to the assigned authority.');
      onRefreshReports?.();
    } catch (err: any) {
      setActionErr(err?.message || 'Unable to send follow-up.');
    } finally {
      setSubmittingAction(false);
    }
  };

  const submitResolutionResponse = async (report: CivicReport, action: 'confirm' | 'reopen') => {
    if (!firebaseUser) return;
    setActionMsg(null);
    setActionErr(null);
    if (action === 'reopen' && disputeReason.trim().length < 5) {
      setActionErr('Please explain why the issue remains unresolved (min 5 characters).');
      return;
    }
    setSubmittingAction(true);
    try {
      const res = await fetch(`/api/citizen/reports/${encodeURIComponent(report.id)}/resolution-response`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uid: firebaseUser.uid,
          action,
          rating: action === 'confirm' ? rating : undefined,
          comment: action === 'confirm' ? feedbackComment.trim() : undefined,
          disputeReason: action === 'reopen' ? disputeReason.trim() : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Unable to record your response.');

      if (action === 'confirm') {
        try {
          await updateDoc(doc(db, 'reports', report.id), {
            feedbackRating: rating,
            feedbackComment: feedbackComment.trim().slice(0, 500),
            updatedAt: serverTimestamp(),
          });
        } catch (err: any) {
          buildFirestoreErrorInfo(err, OperationType.UPDATE, `reports/${report.id}`);
        }
      }

      setFeedbackComment('');
      setDisputeReason('');
      setShowReopenBox(false);
      setActionMsg(
        action === 'confirm'
          ? 'Thank you! Resolution confirmed and rating recorded.'
          : 'Issue reopened and flagged to department supervisors for rework.'
      );
      onRefreshReports?.();
    } catch (err: any) {
      setActionErr(err?.message || 'Unable to submit response.');
    } finally {
      setSubmittingAction(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900">
            My Reports &amp; Voice Reference Lookup
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Track real-time status milestones, review Before/After resolution evidence, confirm or reopen resolved cases, and check any reference ID by voice.
          </p>
        </div>

        <button
          type="button"
          onClick={onGoToReport}
          className="px-4 py-2 bg-green-900 text-white text-sm font-medium rounded-lg hover:bg-green-800"
        >
          Submit New Report
        </button>
      </div>

      {/* Voice Follow-Up Reference Lookup Bar */}
      <div className="border border-slate-200 rounded-xl bg-white p-4 space-y-3">
        <div className="text-xs font-semibold text-slate-800">
          Voice &amp; Text Reference Number Lookup (Real Backend Verification)
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            type="text"
            value={lookupInput}
            onChange={(e) => setLookupInput(e.target.value)}
            placeholder="Enter Complaint ID (SEVA-...) or Reference Number (REF-...)"
            className="flex-1 min-w-[220px] text-xs font-mono border border-slate-200 rounded-lg px-3 py-2.5"
          />
          {!recordingRef ? (
            <button
              type="button"
              onClick={startVoiceReferenceCapture}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-slate-900 text-white text-xs font-medium rounded-lg hover:bg-slate-800"
            >
              <Mic className="w-3.5 h-3.5" />
              Speak Reference ID
            </button>
          ) : (
            <button
              type="button"
              onClick={stopVoiceReferenceCapture}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-red-600 text-white text-xs font-medium rounded-lg"
            >
              <MicOff className="w-3.5 h-3.5 animate-pulse" />
              Stop Mic
            </button>
          )}
          <button
            type="button"
            disabled={lookingUp}
            onClick={() => handleLookup()}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-green-900 text-white text-xs font-medium rounded-lg hover:bg-green-800 disabled:opacity-50"
          >
            <Search className="w-3.5 h-3.5" />
            {lookingUp ? 'Checking...' : 'Check Status'}
          </button>
        </div>
        {lookupError && <div className="text-xs text-red-700">{lookupError}</div>}
      </div>

      {!firebaseUser && !lookupResult ? (
        <div className="border border-slate-200 rounded-xl bg-slate-50 p-8 text-center space-y-4">
          <h2 className="font-display text-xl font-semibold text-slate-900">Sign In to Manage Your Reports</h2>
          <p className="text-sm text-slate-600 max-w-md mx-auto">
            Sign in with Google to view all your submitted complaints, upload follow-up evidence, or confirm/reopen resolved issues.
          </p>
          <button
            type="button"
            disabled={signingIn}
            onClick={() => signInWithGoogle()}
            className="px-5 py-2.5 bg-green-900 text-white text-sm font-medium rounded-lg disabled:opacity-50"
          >
            {signingIn ? 'Signing in...' : 'Sign In with Google'}
          </button>
        </div>
      ) : reports.length === 0 && !lookupResult ? (
        <div className="border border-slate-200 rounded-xl bg-slate-50 p-10 text-center space-y-3">
          <p className="text-sm font-medium text-slate-700">You have not submitted any civic reports yet.</p>
          <button
            type="button"
            onClick={onGoToReport}
            className="px-4 py-2 bg-green-900 text-white text-xs font-medium rounded-lg"
          >
            Create Your First Report
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Complaint List */}
          <div className="lg:col-span-5 space-y-2.5">
            {lookupResult && !reports.some((r) => r.id === lookupResult.id) && (
              <button
                type="button"
                onClick={() => setSelectedId(lookupResult.id)}
                className={`w-full text-left border rounded-xl p-4 transition-colors ${
                  selected?.id === lookupResult.id
                    ? 'border-green-900 bg-emerald-50/40'
                    : 'border-slate-200 bg-white'
                }`}
              >
                <div className="flex items-center justify-between text-xs text-slate-500">
                  <span className="font-mono font-semibold text-green-900">
                    LOOKUP · {lookupResult.referenceNumber || lookupResult.complaintId}
                  </span>
                  <span className="font-medium text-green-900">{lookupResult.status}</span>
                </div>
                <div className="font-display text-sm font-semibold text-slate-900 mt-1">
                  {lookupResult.title}
                </div>
              </button>
            )}

            {reports.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => setSelectedId(r.id)}
                className={`w-full text-left border rounded-xl p-4 transition-colors ${
                  selected?.id === r.id
                    ? 'border-green-900 bg-emerald-50/30'
                    : 'border-slate-200 bg-white hover:bg-slate-50'
                }`}
              >
                <div className="flex items-center justify-between text-xs text-slate-500 gap-2">
                  <span className="font-mono font-semibold text-slate-800">
                    {r.referenceNumber || r.complaintId}
                  </span>
                  <span
                    className={`font-medium ${
                      r.status === 'Reopened'
                        ? 'text-red-700'
                        : r.status === 'Awaiting Evidence'
                        ? 'text-amber-700'
                        : 'text-green-900'
                    }`}
                  >
                    {r.status}
                  </span>
                </div>
                <div className="font-display text-sm font-semibold text-slate-900 mt-1">{r.title}</div>
                <div className="text-xs text-slate-600 mt-1">
                  {r.category} · {r.department}
                </div>
              </button>
            ))}
          </div>

          {/* Detail & Milestone Timeline */}
          {selected && (
            <div className="lg:col-span-7 border border-slate-200 rounded-xl bg-white p-5 space-y-5">
              <div className="flex flex-wrap items-start justify-between gap-2 pb-4 border-b border-slate-200">
                <div>
                  <div className="font-mono text-xs text-slate-500">
                    {selected.complaintId}
                    {selected.referenceNumber ? ` · Ref: ${selected.referenceNumber}` : ''} ·{' '}
                    {selected.department}
                  </div>
                  <h2 className="font-display text-xl font-bold text-slate-900 mt-1">
                    {selected.title}
                  </h2>
                </div>
                <div className="text-right">
                  <div className="text-xs text-slate-500">Current Status</div>
                  <div className="text-sm font-semibold text-green-900">{selected.status}</div>
                  {selected.verificationStatus && (
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      Verification: {selected.verificationStatus}
                    </div>
                  )}
                </div>
              </div>

              {selected.additionalEvidenceRequested && (
                <div className="border border-amber-300 bg-amber-50 rounded-lg p-3.5 text-xs text-amber-950 flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                  <div>
                    <div className="font-semibold">Authority Requested Additional Evidence</div>
                    <p className="mt-0.5">{selected.additionalEvidenceRequestNote}</p>
                  </div>
                </div>
              )}

              <p className="text-sm text-slate-700 whitespace-pre-line">{selected.description}</p>

              <div className="flex items-start gap-2 text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg p-3">
                <MapPin className="w-4 h-4 text-green-900 shrink-0 mt-0.5" />
                <div>
                  <div>
                    {selected.address} ({selected.lat.toFixed(5)}, {selected.lng.toFixed(5)})
                  </div>
                  {selected.slaDeadlineAt && (
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      SLA Target Resolution: {new Date(selected.slaDeadlineAt).toLocaleString()}
                    </div>
                  )}
                </div>
              </div>

              {selected.photoDataUrl && (
                <img
                  src={selected.photoDataUrl}
                  alt="Submitted report evidence"
                  className="w-full max-h-56 object-cover rounded-lg border border-slate-200"
                />
              )}

              {/* Authority Resolution Before & After Photos */}
              {selected.resolutionEvidence &&
                (selected.resolutionEvidence.beforePhotos.length > 0 ||
                  selected.resolutionEvidence.afterPhotos.length > 0) && (
                  <div className="border border-emerald-200 bg-emerald-50/40 rounded-xl p-4 space-y-3">
                    <div className="text-xs font-semibold text-green-950">
                      Authority Resolution Proof (Before &amp; After Work Evidence)
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {selected.resolutionEvidence.beforePhotos.map((p) => (
                        <div key={p.id} className="space-y-1">
                          <div className="text-[11px] font-semibold text-slate-600">Before Work</div>
                          <img
                            src={p.url}
                            alt="Before resolution"
                            className="w-full h-36 object-cover rounded-lg border border-slate-200 bg-white"
                          />
                        </div>
                      ))}
                      {selected.resolutionEvidence.afterPhotos.map((p) => (
                        <div key={p.id} className="space-y-1">
                          <div className="text-[11px] font-semibold text-green-900">After Work Completed</div>
                          <img
                            src={p.url}
                            alt="After resolution"
                            className="w-full h-36 object-cover rounded-lg border border-emerald-300 bg-white"
                          />
                        </div>
                      ))}
                    </div>
                    {selected.resolutionEvidence.completionNotes && (
                      <p className="text-xs text-slate-700">
                        <strong>Completion Notes:</strong> {selected.resolutionEvidence.completionNotes}
                      </p>
                    )}
                    {selected.resolutionEvidence.approvedBy && (
                      <p className="text-[11px] text-slate-500">
                        Approved by Supervisor: {selected.resolutionEvidence.approvedBy}
                      </p>
                    )}
                  </div>
                )}

              {/* Genuine Milestones */}
              <div className="space-y-3">
                <h3 className="font-display text-sm font-semibold text-slate-900">
                  Verified Progress Timeline
                </h3>
                <div className="space-y-2.5">
                  <div className="flex items-start gap-2.5 text-xs">
                    <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0 mt-0.5" />
                    <div>
                      <div className="font-semibold text-slate-900">Report Submitted</div>
                      <div className="text-slate-500">Routed to {selected.department}</div>
                    </div>
                  </div>
                  {(selected.timeline || [])
                    .filter((t) => !['submitted', 'routed'].includes(t.step))
                    .map((step, idx) => (
                      <div key={idx} className="flex items-start gap-2.5 text-xs">
                        <Clock className="w-4 h-4 text-green-900 shrink-0 mt-0.5" />
                        <div>
                          <div className="font-semibold text-slate-900">
                            {step.label} <span className="text-slate-500 font-normal">({step.actorRole})</span>
                          </div>
                          {step.note && <div className="text-slate-600">{step.note}</div>}
                          <div className="text-[11px] text-slate-400">
                            {new Date(step.timestamp).toLocaleString()}
                          </div>
                        </div>
                      </div>
                    ))}
                </div>
              </div>

              {selected.assignedOfficer && (
                <div className="text-xs bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-1">
                  <div>
                    <strong>Assigned Officer:</strong> {selected.assignedOfficer} ({selected.department})
                  </div>
                  {selected.actionNotes && (
                    <div className="text-slate-700">Action Notes: {selected.actionNotes}</div>
                  )}
                  {selected.resolutionNotes && (
                    <div className="text-emerald-800">Resolution: {selected.resolutionNotes}</div>
                  )}
                </div>
              )}

              {/* Citizen Follow-Up / Additional Evidence Upload */}
              {firebaseUser &&
                selected.reporterUid === firebaseUser.uid &&
                selected.status !== 'Resolved' &&
                selected.status !== 'Rejected' && (
                  <div className="pt-3 border-t border-slate-200 space-y-2.5">
                    <label className="block text-xs font-semibold text-slate-700">
                      Add Follow-Up Clarification or Evidence Files
                    </label>
                    <div className="flex flex-wrap gap-2">
                      <input
                        type="text"
                        value={extraDetail}
                        onChange={(e) => setExtraDetail(e.target.value)}
                        placeholder="Add landmark clarification or update..."
                        className="flex-1 min-w-[200px] text-xs border border-slate-200 rounded-lg px-3 py-2"
                      />
                      <label className="inline-flex items-center gap-1.5 px-3 py-2 border border-slate-200 rounded-lg text-xs font-medium text-slate-700 cursor-pointer hover:bg-slate-50">
                        <Camera className="w-3.5 h-3.5 text-green-900" />
                        {uploadingExtra ? 'Uploading...' : `Attach Photos (${extraFiles.length})`}
                        <input
                          type="file"
                          accept="image/*,.pdf"
                          multiple
                          onChange={handleUploadExtraEvidence}
                          className="hidden"
                        />
                      </label>
                      <button
                        type="button"
                        disabled={submittingAction}
                        onClick={() => submitFollowUp(selected)}
                        className="px-3.5 py-2 bg-slate-900 text-white text-xs font-medium rounded-lg inline-flex items-center gap-1.5 disabled:opacity-50"
                      >
                        <MessageSquare className="w-3.5 h-3.5" />
                        Send Update
                      </button>
                    </div>
                  </div>
                )}

              {/* Citizen Confirm Resolution OR Dispute / Reopen Loop */}
              {firebaseUser &&
                selected.reporterUid === firebaseUser.uid &&
                selected.status === 'Resolved' && (
                  <div className="pt-3 border-t border-slate-200 space-y-3">
                    {!selected.citizenConfirmedResolution && !selected.feedbackRating ? (
                      <>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="text-xs font-semibold text-slate-800">
                            Verify Completion: Confirm Resolution or Request Reopening
                          </div>
                          <button
                            type="button"
                            onClick={() => setShowReopenBox((v) => !v)}
                            className="inline-flex items-center gap-1 text-xs font-medium text-red-700 hover:underline"
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                            {showReopenBox ? 'Cancel Dispute' : 'Issue Not Fixed? Reopen'}
                          </button>
                        </div>

                        {!showReopenBox ? (
                          <div className="space-y-2.5">
                            <div className="flex items-center gap-2">
                              {[1, 2, 3, 4, 5].map((n) => (
                                <button
                                  key={n}
                                  type="button"
                                  onClick={() => setRating(n)}
                                  className={`p-1.5 rounded border ${
                                    rating >= n
                                      ? 'border-amber-500 text-amber-600 bg-amber-50'
                                      : 'border-slate-200 text-slate-400'
                                  }`}
                                >
                                  <Star className="w-4 h-4" />
                                </button>
                              ))}
                            </div>
                            <div className="flex gap-2">
                              <input
                                type="text"
                                value={feedbackComment}
                                onChange={(e) => setFeedbackComment(e.target.value)}
                                placeholder="Optional feedback on repair quality..."
                                className="flex-1 text-xs border border-slate-200 rounded-lg px-3 py-2"
                              />
                              <button
                                type="button"
                                disabled={submittingAction}
                                onClick={() => submitResolutionResponse(selected, 'confirm')}
                                className="px-4 py-2 bg-green-900 text-white text-xs font-medium rounded-lg disabled:opacity-50"
                              >
                                Confirm Resolution
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="space-y-2 bg-red-50 border border-red-200 rounded-lg p-3">
                            <textarea
                              rows={2}
                              value={disputeReason}
                              onChange={(e) => setDisputeReason(e.target.value)}
                              placeholder="Explain why the resolution is incomplete or problem persists..."
                              className="w-full text-xs bg-white border border-red-200 rounded-lg px-3 py-2"
                            />
                            <button
                              type="button"
                              disabled={submittingAction}
                              onClick={() => submitResolutionResponse(selected, 'reopen')}
                              className="px-4 py-2 bg-red-700 text-white text-xs font-semibold rounded-lg disabled:opacity-50"
                            >
                              Submit Dispute &amp; Reopen Issue
                            </button>
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="text-xs text-emerald-900 bg-emerald-50 border border-emerald-200 rounded-lg p-3">
                        Resolution confirmed by citizen · Rating: {selected.feedbackRating || 5}/5
                        {selected.feedbackComment ? ` — "${selected.feedbackComment}"` : ''}
                      </div>
                    )}
                  </div>
                )}

              {actionMsg && <p className="text-xs text-green-900 font-medium">{actionMsg}</p>}
              {actionErr && <p className="text-xs text-red-700 font-medium">{actionErr}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
