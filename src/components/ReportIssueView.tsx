import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  FileVideo,
  Loader2,
  MapPin,
  Mic,
  Navigation,
  ShieldCheck,
  Upload,
} from 'lucide-react';
import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { useAuth } from '../contexts/AuthContext';
import { useLocationEngine } from '../contexts/LocationContext';
import { OperationType, db, handleFirestoreError } from '../lib/firebase';
import {
  CivicCategory,
  ReportAnalysisResponse,
  SeverityLevel,
  VoiceDraftPayload,
} from '../types/seva';
import { LeafletMap } from './LeafletMap';

const CATEGORIES: CivicCategory[] = [
  'Roads and Potholes',
  'Waste Management',
  'Blocked Drains and Waterlogging',
  'Traffic and Road Obstructions',
  'Road Accident Reporting',
  'Medical Assistance',
  'Women and Child Safety',
  'Animal Rescue and Welfare',
];

const DEPT_MAP: Record<string, string> = {
  'Roads and Potholes': 'Public Works Department',
  'Waste Management': 'Municipal Corporation',
  'Blocked Drains and Waterlogging': 'Municipal Corporation',
  'Traffic and Road Obstructions': 'Traffic Police',
  'Road Accident Reporting': 'Emergency Control Room',
  'Medical Assistance': 'Medical Services',
  'Women and Child Safety': 'Police Department',
  'Animal Rescue and Welfare': 'Animal Welfare & Rescue',
};

async function compressImageToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const maxDim = 960;
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const ratio = Math.min(maxDim / width, maxDim / height);
          width = Math.round(width * ratio);
          height = Math.round(height * ratio);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return reject(new Error('Canvas context unavailable'));
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.72));
      };
      img.onerror = () => reject(new Error('Invalid image file'));
      img.src = String(reader.result);
    };
    reader.onerror = () => reject(new Error('Unable to read image file'));
    reader.readAsDataURL(file);
  });
}

interface ReportIssueViewProps {
  initialCategory?: CivicCategory;
  voiceDraft?: VoiceDraftPayload | null;
  onOpenVoiceAssistant: () => void;
  onSubmittedSuccess: () => void;
}

export const ReportIssueView: React.FC<ReportIssueViewProps> = ({
  initialCategory,
  voiceDraft,
  onOpenVoiceAssistant,
  onSubmittedSuccess,
}) => {
  const { firebaseUser, profile, signingIn, signInWithGoogle } = useAuth();
  const { lat, lng, accuracyMeters, address, ward, city, requestCurrentLocation, setManualLocation } =
    useLocationEngine();

  const [category, setCategory] = useState<CivicCategory>(initialCategory || 'Roads and Potholes');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [severity, setSeverity] = useState<SeverityLevel>('Medium');
  const [manualAddress, setManualAddress] = useState('');
  const [photoDataUrl, setPhotoDataUrl] = useState<string>('');
  const [videoName, setVideoName] = useState<string>('');
  const [contactNote, setContactNote] = useState('');

  const [analyzing, setAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState<ReportAnalysisResponse | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submittedResult, setSubmittedResult] = useState<{
    complaintId: string;
    department: string;
    fraudQueueStatus: string;
  } | null>(null);

  useEffect(() => {
    if (initialCategory) setCategory(initialCategory);
  }, [initialCategory]);

  useEffect(() => {
    if (address && !manualAddress) {
      setManualAddress(address);
    }
  }, [address]);

  useEffect(() => {
    if (!voiceDraft) return;
    if (voiceDraft.category && CATEGORIES.includes(voiceDraft.category as CivicCategory)) {
      setCategory(voiceDraft.category as CivicCategory);
    }
    if (voiceDraft.title) setTitle(voiceDraft.title);
    if (voiceDraft.description) setDescription(voiceDraft.description);
    if (voiceDraft.severity) setSeverity(voiceDraft.severity);
    if (voiceDraft.locationMentioned) setManualAddress(voiceDraft.locationMentioned);
    setAnalysis(null);
  }, [voiceDraft]);

  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const compressed = await compressImageToDataUrl(file);
      setPhotoDataUrl(compressed);
      setAnalysis(null);
    } catch (err: any) {
      setSubmitError(err?.message || 'Unable to process image.');
    }
  };

  const handleVideoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setVideoName(`${file.name} (${(file.size / (1024 * 1024)).toFixed(1)} MB)`);
  };

  const runAiAndFraudAnalysis = async () => {
    setAnalysisError(null);
    if (!title.trim() || title.trim().length < 3) {
      setAnalysisError('Please enter an incident title (at least 3 characters).');
      return;
    }
    if (!description.trim() || description.trim().length < 8) {
      setAnalysisError('Please provide a clear description (at least 8 characters).');
      return;
    }
    if (lat === null || lng === null) {
      setAnalysisError('Please acquire GPS coordinates or click a location on the map first.');
      return;
    }

    setAnalyzing(true);
    try {
      const res = await fetch('/api/ai/analyze-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category,
          title: title.trim(),
          description: description.trim(),
          severity,
          address: manualAddress || address,
          lat,
          lng,
          photoDataUrl: photoDataUrl || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'AI analysis failed.');
      setAnalysis(data as ReportAnalysisResponse);
    } catch (err: any) {
      setAnalysisError(
        err?.message || 'AI analysis unavailable right now. You may review and submit manually.'
      );
    } finally {
      setAnalyzing(false);
    }
  };

  const applyAiSuggestions = () => {
    if (!analysis) return;
    if (CATEGORIES.includes(analysis.suggestedCategory as CivicCategory)) {
      setCategory(analysis.suggestedCategory as CivicCategory);
    }
    setSeverity(analysis.suggestedSeverity);
  };

  const handleConfirmSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(null);

    if (!firebaseUser) {
      setSubmitError('Please sign in with Google to submit a verified civic report.');
      return;
    }
    if (!title.trim() || title.trim().length < 3 || !description.trim() || description.trim().length < 5) {
      setSubmitError('Please complete the incident title and description.');
      return;
    }
    if (lat === null || lng === null) {
      setSubmitError('Location coordinates are required. Click "Acquire GPS" or tap on the map.');
      return;
    }

    setSubmitting(true);
    const complaintId = `SEVA-${new Date().getFullYear()}-${Math.floor(100000 + Math.random() * 900000)}`;
    const reportDocId = `rep_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const finalAddress = (manualAddress || address || `GPS (${lat.toFixed(5)}, ${lng.toFixed(5)})`).slice(0, 300);

    const isEmergency =
      category === 'Medical Assistance' ||
      category === 'Road Accident Reporting' ||
      category === 'Women and Child Safety';
    const isSensitive = category === 'Women and Child Safety';
    const department = DEPT_MAP[category] || 'Municipal Corporation';

    const fraudScore = analysis?.fraudRiskScore ?? 12;
    const fraudLevel = analysis?.fraudRiskLevel ?? 'Low';
    // Emergency Exception: Never allow fraud score alone to block genuine emergencies
    const fraudQueueStatus = isEmergency
      ? 'cleared'
      : fraudScore >= 80
      ? 'investigation_queue'
      : fraudScore >= 60
      ? 'restricted_queue'
      : fraudScore >= 30
      ? 'validation_needed'
      : 'cleared';

    const firestorePayload: Record<string, any> = {
      complaintId,
      reporterUid: firebaseUser.uid,
      reporterDisplayName: (profile?.displayName || firebaseUser.displayName || 'Citizen').slice(0, 80),
      category,
      title: title.trim().slice(0, 160),
      description: description.trim().slice(0, 3000),
      severity,
      status: 'Submitted',
      department,
      ward: (ward || profile?.ward || 'Central Ward').slice(0, 80),
      locality: (city || profile?.city || 'City').slice(0, 120),
      address: finalAddress,
      lat,
      lng,
      isEmergency,
      isSensitive,
      fraudRiskScore: fraudScore,
      fraudRiskLevel: fraudLevel,
      fraudIndicators: analysis?.fraudIndicators || [],
      fraudExplanation: (analysis?.fraudExplanation || 'Manual submission without automated flags.').slice(0, 600),
      fraudQueueStatus,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };

    if (typeof accuracyMeters === 'number') firestorePayload.accuracyMeters = accuracyMeters;
    if (photoDataUrl && photoDataUrl.length <= 345000) firestorePayload.photoDataUrl = photoDataUrl;
    if (videoName) {
      firestorePayload.hasVideo = true;
      firestorePayload.videoName = videoName.slice(0, 120);
    }
    if (analysis) {
      firestorePayload.aiSummary = analysis.summary.slice(0, 600);
      firestorePayload.aiSuggestedCategory = analysis.suggestedCategory.slice(0, 80);
      firestorePayload.aiSuggestedSeverity = analysis.suggestedSeverity;
      firestorePayload.aiConfidence = analysis.confidence;
    }

    try {
      await setDoc(doc(db, 'reports', reportDocId), firestorePayload);

      const historyId = `hist_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      await setDoc(doc(db, 'reportStatusHistory', historyId), {
        reportId: reportDocId,
        reporterUid: firebaseUser.uid,
        step: 'submitted',
        label: 'Report Submitted & Routed',
        actorRole: 'Citizen',
        note: `Assigned to ${department} (${complaintId})`,
        createdAt: serverTimestamp(),
      });

      const notifId = `not_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      await setDoc(doc(db, 'notifications', notifId), {
        uid: firebaseUser.uid,
        type: 'report_submitted',
        title: `Complaint ${complaintId} Received`,
        message: `Routed to ${department}. Current integrity queue: ${fraudQueueStatus.replace(/_/g, ' ')}.`,
        relatedId: reportDocId,
        read: false,
        createdAt: serverTimestamp(),
      });

      // Sync to backend operational ledger for Authority Dashboard & real-time WebSockets
      const nowIso = new Date().toISOString();
      await fetch('/api/reports/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...firestorePayload,
          id: reportDocId,
          imageHash: analysis?.imageHash,
          timeline: [
            {
              step: 'submitted',
              label: 'Report Submitted',
              actorRole: 'Citizen',
              timestamp: nowIso,
            },
            ...(analysis
              ? [
                  {
                    step: 'ai_analysis',
                    label: 'AI Analysis Completed',
                    actorRole: 'SEVA AI Engine',
                    note: analysis.summary,
                    timestamp: nowIso,
                  },
                  {
                    step: 'fraud_screening',
                    label: 'Seva Trust Integrity Check',
                    actorRole: 'Seva Trust',
                    note: `Risk ${fraudScore}/100 (${fraudLevel})`,
                    timestamp: nowIso,
                  },
                ]
              : []),
            {
              step: 'routed',
              label: `Routed to ${department}`,
              actorRole: 'SEVA Router',
              timestamp: nowIso,
            },
          ],
          createdAt: nowIso,
          updatedAt: nowIso,
        }),
      });

      setSubmittedResult({ complaintId, department, fraudQueueStatus });
      setTitle('');
      setDescription('');
      setPhotoDataUrl('');
      setVideoName('');
      setAnalysis(null);
    } catch (err: any) {
      if (err?.message?.includes('Missing or insufficient permissions')) {
        handleFirestoreError(err, OperationType.CREATE, `reports/${reportDocId}`);
      }
      setSubmitError(err?.message || 'Unable to submit report. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900">
            Report a Civic Issue
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Select a category, capture live GPS and evidence, run AI &amp; Seva Trust verification, and confirm before submission.
          </p>
        </div>

        <button
          type="button"
          onClick={onOpenVoiceAssistant}
          className="inline-flex items-center gap-2 px-4 py-2.5 bg-green-900 text-white text-sm font-medium rounded-lg hover:bg-green-800 transition-colors whitespace-nowrap"
        >
          <Mic className="w-4 h-4" />
          Report Using Voice
        </button>
      </div>

      {/* Category Selector */}
      <div className="border border-slate-200 rounded-xl bg-white p-4">
        <div className="text-xs font-semibold text-slate-700 mb-2.5">
          Issue Category (Auto-routes to {DEPT_MAP[category]})
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {CATEGORIES.map((cat) => {
            const active = category === cat;
            return (
              <button
                key={cat}
                type="button"
                onClick={() => setCategory(cat)}
                className={`text-left px-3 py-2.5 rounded-lg border text-xs font-medium transition-colors ${
                  active
                    ? 'bg-green-900 text-white border-green-900'
                    : 'bg-slate-50 text-slate-800 border-slate-200 hover:bg-slate-100'
                }`}
              >
                {cat}
              </button>
            );
          })}
        </div>
      </div>

      {submittedResult && (
        <div className="border border-emerald-700/30 bg-emerald-50 rounded-xl p-5 space-y-2">
          <div className="flex items-center gap-2 text-green-900 font-display font-semibold">
            <CheckCircle2 className="w-5 h-5" />
            Report Confirmed &amp; Saved
          </div>
          <p className="text-sm text-slate-800">
            Complaint ID: <span className="font-mono font-semibold">{submittedResult.complaintId}</span> · Routed to{' '}
            <strong>{submittedResult.department}</strong> · Screening status:{' '}
            <span className="capitalize">{submittedResult.fraudQueueStatus.replace(/_/g, ' ')}</span>
          </p>
          <button
            type="button"
            onClick={onSubmittedSuccess}
            className="text-xs font-semibold text-green-900 underline"
          >
            Track Complaint in My Reports
          </button>
        </div>
      )}

      {!firebaseUser && (
        <div className="border border-amber-200 bg-amber-50 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-amber-950">
            Sign in with Google to save your verified civic complaint and track authority progress.
          </p>
          <button
            type="button"
            disabled={signingIn}
            onClick={() => signInWithGoogle()}
            className="px-4 py-2 bg-green-900 text-white text-xs font-medium rounded-lg hover:bg-green-800 disabled:opacity-50"
          >
            {signingIn ? 'Signing in...' : 'Sign In with Google'}
          </button>
        </div>
      )}

      <form onSubmit={handleConfirmSubmit} className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Details & Evidence */}
        <div className="lg:col-span-7 border border-slate-200 rounded-xl bg-white p-5 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="sm:col-span-2">
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Incident Title
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={160}
                placeholder="e.g., Deep water-filled pothole near main market crossing"
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2.5 text-slate-900 focus:outline-none focus:ring-2 focus:ring-green-800"
                required
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Severity
              </label>
              <select
                value={severity}
                onChange={(e) => setSeverity(e.target.value as SeverityLevel)}
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2.5 text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-green-800"
              >
                <option value="Low">Low</option>
                <option value="Medium">Medium</option>
                <option value="High">High</option>
                <option value="Critical">Critical</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              Detailed Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              maxLength={3000}
              placeholder="Describe the civic hazard, traffic impact, landmarks, and duration..."
              className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2.5 text-slate-900 focus:outline-none focus:ring-2 focus:ring-green-800"
              required
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              Address / Landmark (Auto-filled from GPS, editable)
            </label>
            <input
              type="text"
              value={manualAddress}
              onChange={(e) => setManualAddress(e.target.value)}
              maxLength={300}
              placeholder="Street, sector, ward, or nearest landmark"
              className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2.5 text-slate-900 focus:outline-none focus:ring-2 focus:ring-green-800"
            />
          </div>

          {/* Evidence Uploads */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="border border-dashed border-slate-300 rounded-lg p-3.5 flex items-center gap-3 cursor-pointer hover:bg-slate-50">
              <Camera className="w-5 h-5 text-green-900 shrink-0" />
              <div className="min-w-0">
                <div className="text-xs font-semibold text-slate-800">Capture or Upload Photo</div>
                <div className="text-xs text-slate-500 truncate">
                  {photoDataUrl ? 'Photo attached & compressed' : 'JPEG / PNG evidence'}
                </div>
              </div>
              <input
                type="file"
                accept="image/*"
                capture="environment"
                onChange={handlePhotoUpload}
                className="hidden"
              />
            </label>

            <label className="border border-dashed border-slate-300 rounded-lg p-3.5 flex items-center gap-3 cursor-pointer hover:bg-slate-50">
              <FileVideo className="w-5 h-5 text-slate-700 shrink-0" />
              <div className="min-w-0">
                <div className="text-xs font-semibold text-slate-800">Attach Video Clip (Optional)</div>
                <div className="text-xs text-slate-500 truncate">
                  {videoName || 'MP4 / WebM evidence'}
                </div>
              </div>
              <input
                type="file"
                accept="video/*"
                onChange={handleVideoUpload}
                className="hidden"
              />
            </label>
          </div>

          {photoDataUrl && (
            <div className="relative rounded-lg overflow-hidden border border-slate-200 max-h-48 bg-slate-100">
              <img
                src={photoDataUrl}
                alt="Uploaded civic evidence preview"
                className="w-full h-48 object-cover"
              />
              <button
                type="button"
                onClick={() => setPhotoDataUrl('')}
                className="absolute top-2 right-2 px-2.5 py-1 bg-slate-900/80 text-white text-xs rounded-md"
              >
                Remove
              </button>
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              Optional Follow-up Preference
            </label>
            <input
              type="text"
              value={contactNote}
              onChange={(e) => setContactNote(e.target.value)}
              placeholder="Preferred inspection timing (stored privately, never shown publicly)"
              className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 text-slate-900"
            />
          </div>

          {/* Step 1: AI & Seva Trust Screening */}
          <div className="pt-2 border-t border-slate-200 flex flex-wrap items-center justify-between gap-3">
            <button
              type="button"
              onClick={runAiAndFraudAnalysis}
              disabled={analyzing}
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-slate-900 text-white text-sm font-medium rounded-lg hover:bg-slate-800 disabled:opacity-50"
            >
              {analyzing ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
              Analyze with AI &amp; Seva Trust
            </button>

            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-2 px-5 py-2.5 bg-green-900 text-white text-sm font-medium rounded-lg hover:bg-green-800 disabled:opacity-50"
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
              Confirm &amp; Submit Report
            </button>
          </div>

          {analysisError && (
            <div className="text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded-lg p-3">
              {analysisError}
            </div>
          )}
          {submitError && (
            <div className="text-xs text-red-800 bg-red-50 border border-red-200 rounded-lg p-3">
              {submitError}
            </div>
          )}
        </div>

        {/* Right Column: GPS Pin & AI / Seva Trust Review */}
        <div className="lg:col-span-5 space-y-5">
          <div className="border border-slate-200 rounded-xl bg-white p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-display text-sm font-semibold text-slate-900">
                Incident Location Pin
              </h3>
              <button
                type="button"
                onClick={() => requestCurrentLocation()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 text-slate-800 text-xs font-medium rounded-md hover:bg-slate-200"
              >
                <Navigation className="w-3.5 h-3.5" />
                Acquire GPS
              </button>
            </div>

            {lat !== null && lng !== null ? (
              <>
                <div className="text-xs font-mono text-slate-600 tabular-nums">
                  {lat.toFixed(5)}, {lng.toFixed(5)}
                  {accuracyMeters ? ` (±${accuracyMeters}m)` : ' (Manual map pin)'}
                </div>
                <LeafletMap
                  centerLat={lat}
                  centerLng={lng}
                  zoom={16}
                  userLat={lat}
                  userLng={lng}
                  userAccuracyMeters={accuracyMeters}
                  onMapClick={(cLat, cLng) => setManualLocation(cLat, cLng)}
                  heightClass="h-[230px]"
                />
              </>
            ) : (
              <div className="h-[200px] rounded-lg border border-dashed border-slate-300 bg-slate-50 flex flex-col items-center justify-center p-4 text-center">
                <MapPin className="w-5 h-5 text-slate-400 mb-1.5" />
                <p className="text-xs text-slate-600 mb-3">
                  Click &ldquo;Acquire GPS&rdquo; to attach real coordinates to this civic complaint.
                </p>
                <button
                  type="button"
                  onClick={() => requestCurrentLocation()}
                  className="px-3 py-1.5 bg-green-900 text-white text-xs font-medium rounded-md"
                >
                  Sense My GPS
                </button>
              </div>
            )}
          </div>

          {analysis && (
            <div className="border border-slate-200 rounded-xl bg-slate-50 p-4 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-display text-sm font-semibold text-slate-900">
                  AI Analysis &amp; Seva Trust Integrity
                </h3>
                <span className="font-mono text-xs font-semibold text-slate-800 tabular-nums">
                  Risk {analysis.fraudRiskScore}/100 ({analysis.fraudRiskLevel})
                </span>
              </div>

              <p className="text-xs text-slate-700 leading-relaxed">{analysis.summary}</p>

              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="bg-white border border-slate-200 rounded-lg p-2.5">
                  <div className="text-slate-500">AI Suggested Category</div>
                  <div className="font-medium text-slate-900 mt-0.5">{analysis.suggestedCategory}</div>
                </div>
                <div className="bg-white border border-slate-200 rounded-lg p-2.5">
                  <div className="text-slate-500">Suggested Severity</div>
                  <div className="font-medium text-slate-900 mt-0.5">{analysis.suggestedSeverity}</div>
                </div>
              </div>

              {analysis.detectedIssueFromImage && photoDataUrl && (
                <div className="text-xs text-slate-700 bg-white border border-slate-200 rounded-lg p-2.5">
                  <strong>Photo Inspection:</strong> {analysis.detectedIssueFromImage}
                </div>
              )}

              <div className="text-xs text-slate-700 bg-white border border-slate-200 rounded-lg p-2.5">
                <strong>Seva Trust Assessment:</strong> {analysis.fraudExplanation}
                {analysis.fraudIndicators?.length > 0 && (
                  <ul className="list-disc pl-4 mt-1 text-amber-800">
                    {analysis.fraudIndicators.map((ind, idx) => (
                      <li key={idx}>{ind}</li>
                    ))}
                  </ul>
                )}
              </div>

              {analysis.fraudRiskScore >= 60 && (
                <div className="flex items-start gap-2 text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded-lg p-2.5">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>
                    Non-emergency reports with score ≥60 enter the Seva Trust verification queue before normal dispatch. Genuine emergencies still route immediately.
                  </span>
                </div>
              )}

              <button
                type="button"
                onClick={applyAiSuggestions}
                className="w-full py-2 bg-white border border-slate-300 text-slate-800 text-xs font-medium rounded-lg hover:bg-slate-100"
              >
                Apply AI Category &amp; Severity Suggestions
              </button>
            </div>
          )}
        </div>
      </form>
    </div>
  );
};
