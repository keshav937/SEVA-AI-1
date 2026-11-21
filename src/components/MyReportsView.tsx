import React, { useEffect, useState } from 'react';
import { CheckCircle2, Clock, MapPin, MessageSquare, Star } from 'lucide-react';
import { doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { useAuth } from '../contexts/AuthContext';
import { OperationType, db, handleFirestoreError } from '../lib/firebase';
import { CivicReport } from '../types/seva';

interface MyReportsViewProps {
  reports: CivicReport[];
  onGoToReport: () => void;
}

export const MyReportsView: React.FC<MyReportsViewProps> = ({ reports, onGoToReport }) => {
  const { firebaseUser, signInWithGoogle } = useAuth();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [extraDetail, setExtraDetail] = useState('');
  const [rating, setRating] = useState(5);
  const [feedbackComment, setFeedbackComment] = useState('');
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedId && reports.length > 0) {
      setSelectedId(reports[0].id);
    }
  }, [reports, selectedId]);

  const selected = reports.find((r) => r.id === selectedId) || null;

  const submitFollowUp = async (report: CivicReport) => {
    if (!extraDetail.trim()) return;
    setActionMsg(null);
    try {
      const merged = `${report.description}\n[Citizen Follow-Up]: ${extraDetail.trim()}`.slice(0, 3000);
      await updateDoc(doc(db, 'reports', report.id), {
        description: merged,
        updatedAt: serverTimestamp(),
      });
      setExtraDetail('');
      setActionMsg('Additional information appended to your report.');
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `reports/${report.id}`);
    }
  };

  const submitFeedback = async (report: CivicReport) => {
    setActionMsg(null);
    try {
      await updateDoc(doc(db, 'reports', report.id), {
        feedbackRating: rating,
        feedbackComment: feedbackComment.trim().slice(0, 500),
        updatedAt: serverTimestamp(),
      });
      setFeedbackComment('');
      setActionMsg('Thank you! Resolution feedback recorded.');
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `reports/${report.id}`);
    }
  };

  if (!firebaseUser) {
    return (
      <div className="border border-slate-200 rounded-xl bg-slate-50 p-8 text-center space-y-4">
        <h2 className="font-display text-xl font-semibold text-slate-900">
          Track Your Civic Complaints
        </h2>
        <p className="text-sm text-slate-600 max-w-md mx-auto">
          Sign in with Google to view your submitted complaint IDs, AI/Seva Trust screening milestones, and live authority resolution updates.
        </p>
        <button
          type="button"
          onClick={() => signInWithGoogle()}
          className="px-5 py-2.5 bg-green-900 text-white text-sm font-medium rounded-lg"
        >
          Sign In with Google
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900">
            My Reports &amp; Complaint Tracking
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Real-time status milestones synced from Firestore and Authority Operations.
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

      {reports.length === 0 ? (
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
                <div className="flex items-center justify-between text-xs text-slate-500">
                  <span className="font-mono font-semibold text-slate-800">{r.complaintId}</span>
                  <span className="font-medium text-green-900">{r.status}</span>
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
                    {selected.complaintId} · {selected.department}
                  </div>
                  <h2 className="font-display text-xl font-bold text-slate-900 mt-1">
                    {selected.title}
                  </h2>
                </div>
                <div className="text-right">
                  <div className="text-xs text-slate-500">Current Status</div>
                  <div className="text-sm font-semibold text-green-900">{selected.status}</div>
                </div>
              </div>

              <p className="text-sm text-slate-700 whitespace-pre-line">{selected.description}</p>

              <div className="flex items-start gap-2 text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg p-3">
                <MapPin className="w-4 h-4 text-green-900 shrink-0 mt-0.5" />
                <span>
                  {selected.address} ({selected.lat.toFixed(5)}, {selected.lng.toFixed(5)})
                </span>
              </div>

              {selected.photoDataUrl && (
                <img
                  src={selected.photoDataUrl}
                  alt="Submitted report evidence"
                  className="w-full max-h-56 object-cover rounded-lg border border-slate-200"
                />
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
                  {selected.aiSummary && (
                    <div className="flex items-start gap-2.5 text-xs">
                      <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0 mt-0.5" />
                      <div>
                        <div className="font-semibold text-slate-900">AI Analysis &amp; Seva Trust Screening</div>
                        <div className="text-slate-600">
                          Risk {selected.fraudRiskScore}/100 ({selected.fraudRiskLevel}) · Queue:{' '}
                          {selected.fraudQueueStatus.replace(/_/g, ' ')}
                        </div>
                      </div>
                    </div>
                  )}
                  {(selected.timeline || [])
                    .filter((t) => !['submitted', 'ai_analysis', 'fraud_screening', 'routed'].includes(t.step))
                    .map((step, idx) => (
                      <div key={idx} className="flex items-start gap-2.5 text-xs">
                        <Clock className="w-4 h-4 text-green-900 shrink-0 mt-0.5" />
                        <div>
                          <div className="font-semibold text-slate-900">
                            {step.label} <span className="text-slate-500 font-normal">({step.actorRole})</span>
                          </div>
                          {step.note && <div className="text-slate-600">{step.note}</div>}
                        </div>
                      </div>
                    ))}
                </div>
              </div>

              {selected.assignedOfficer && (
                <div className="text-xs bg-slate-50 border border-slate-200 rounded-lg p-3">
                  <strong>Assigned Officer:</strong> {selected.assignedOfficer}
                  {selected.actionNotes && <div className="mt-1 text-slate-700">Action Notes: {selected.actionNotes}</div>}
                  {selected.resolutionNotes && (
                    <div className="mt-1 text-emerald-800">Resolution: {selected.resolutionNotes}</div>
                  )}
                </div>
              )}

              {/* Citizen Follow-Up or Resolution Feedback */}
              {selected.status !== 'Resolved' && selected.status !== 'Rejected' ? (
                <div className="pt-3 border-t border-slate-200 space-y-2">
                  <label className="block text-xs font-semibold text-slate-700">
                    Add Additional Details for Authority
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={extraDetail}
                      onChange={(e) => setExtraDetail(e.target.value)}
                      placeholder="Add landmark clarification or update..."
                      className="flex-1 text-xs border border-slate-200 rounded-lg px-3 py-2"
                    />
                    <button
                      type="button"
                      onClick={() => submitFollowUp(selected)}
                      className="px-3.5 py-2 bg-slate-900 text-white text-xs font-medium rounded-lg inline-flex items-center gap-1.5"
                    >
                      <MessageSquare className="w-3.5 h-3.5" />
                      Update
                    </button>
                  </div>
                </div>
              ) : selected.status === 'Resolved' && !selected.feedbackRating ? (
                <div className="pt-3 border-t border-slate-200 space-y-2.5">
                  <div className="text-xs font-semibold text-slate-800">Rate Resolution Quality</div>
                  <div className="flex items-center gap-2">
                    {[1, 2, 3, 4, 5].map((n) => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => setRating(n)}
                        className={`p-1.5 rounded border ${
                          rating >= n ? 'border-amber-500 text-amber-600 bg-amber-50' : 'border-slate-200 text-slate-400'
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
                      placeholder="Optional feedback on the resolution..."
                      className="flex-1 text-xs border border-slate-200 rounded-lg px-3 py-2"
                    />
                    <button
                      type="button"
                      onClick={() => submitFeedback(selected)}
                      className="px-4 py-2 bg-green-900 text-white text-xs font-medium rounded-lg"
                    >
                      Submit Feedback
                    </button>
                  </div>
                </div>
              ) : null}

              {actionMsg && <p className="text-xs text-green-900 font-medium">{actionMsg}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
