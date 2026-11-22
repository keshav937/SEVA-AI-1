import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Camera,
  CheckCircle2,
  FileVideo,
  Loader2,
  MapPin,
  Mic,
  MicOff,
  Navigation,
  Search,
  ShieldCheck,
  Upload,
  Volume2,
  X,
} from 'lucide-react';
import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { useAuth } from '../contexts/AuthContext';
import { useLocationEngine } from '../contexts/LocationContext';
import { OperationType, db, handleFirestoreError } from '../lib/firebase';
import {
  CivicCategory,
  ReportAnalysisResponse,
  SeverityLevel,
  SupportedLanguage,
  UploadedFileRef,
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
  language?: SupportedLanguage;
  onOpenVoiceAssistant: () => void;
  onSubmittedSuccess: () => void;
}

export const ReportIssueView: React.FC<ReportIssueViewProps> = ({
  initialCategory,
  voiceDraft,
  language = 'en',
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
  const [uploadedPhotos, setUploadedPhotos] = useState<UploadedFileRef[]>([]);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [videoName, setVideoName] = useState<string>('');
  const [contactNote, setContactNote] = useState('');

  // Manual place search fallback
  const [placeQuery, setPlaceQuery] = useState('');
  const [searchingPlace, setSearchingPlace] = useState(false);
  const [placeError, setPlaceError] = useState<string | null>(null);

  // 5-Step Guided Voice Reporting Wizard
  const [voiceWizardOpen, setVoiceWizardOpen] = useState(false);
  const [wizardStep, setWizardStep] = useState<1 | 2 | 3 | 4 | 5>(1);
  const [extraLandmarkVoice, setExtraLandmarkVoice] = useState('');
  const [recordingStep, setRecordingStep] = useState(false);
  const [transcribingStep, setTranscribingStep] = useState(false);
  const [wizardVoiceError, setWizardVoiceError] = useState<string | null>(null);
  const [readingBack, setReadingBack] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const readbackAudioRef = useRef<HTMLAudioElement | null>(null);

  const [analyzing, setAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState<ReportAnalysisResponse | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submittedResult, setSubmittedResult] = useState<{
    complaintId: string;
    referenceNumber: string;
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

  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
      if (readbackAudioRef.current) {
        readbackAudioRef.current.pause();
      }
    };
  }, []);

  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    setSubmitError(null);
    setUploadingPhoto(true);
    try {
      const first = files[0];
      const compressed = await compressImageToDataUrl(first);
      setPhotoDataUrl(compressed);
      setAnalysis(null);

      // Persist full evidence images on server uploads store
      const form = new FormData();
      for (const f of files.slice(0, 6)) {
        form.append('files', f);
      }
      const res = await fetch('/api/uploads', { method: 'POST', body: form });
      const data = await res.json();
      if (res.ok && Array.isArray(data.files)) {
        setUploadedPhotos((prev) => [...prev, ...data.files].slice(0, 6));
      }
    } catch (err: any) {
      setSubmitError(err?.message || 'Unable to process image.');
    } finally {
      setUploadingPhoto(false);
    }
  };

  const handleVideoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setVideoName(`${file.name} (${(file.size / (1024 * 1024)).toFixed(1)} MB)`);
  };

  const handleSearchPlace = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setPlaceError(null);
    if (placeQuery.trim().length < 3) {
      setPlaceError('Enter at least 3 characters (street, ward, or landmark).');
      return;
    }
    setSearchingPlace(true);
    try {
      const res = await fetch(`/api/places/search?q=${encodeURIComponent(placeQuery.trim())}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Location not found.');
      setManualLocation(data.lat, data.lng);
      setManualAddress(data.address || placeQuery.trim());
    } catch (err: any) {
      setPlaceError(err?.message || 'Unable to find location.');
    } finally {
      setSearchingPlace(false);
    }
  };

  // Guided Voice Wizard Recorder
  const startStepRecording = async (targetField: 'title' | 'description' | 'extra') => {
    setWizardVoiceError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setWizardVoiceError('Microphone capture is not supported in this browser. Type your input below.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      streamRef.current = stream;
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : '';
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      recorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        setRecordingStep(false);

        if (blob.size < 450) {
          setWizardVoiceError('Recording was too short. Please speak clearly for at least 1–2 seconds.');
          return;
        }
        setTranscribingStep(true);
        try {
          const form = new FormData();
          form.append('audio', blob, 'voice_step.webm');
          form.append('language', language);
          const res = await fetch('/api/voice/stt', { method: 'POST', body: form });
          const data = await res.json();
          if (!res.ok || !data.text) {
            throw new Error(data.error || 'Speech transcription failed. Please edit manually.');
          }
          const spokenText = String(data.text).trim();
          if (targetField === 'title') {
            setTitle(spokenText.slice(0, 160));
          } else if (targetField === 'description') {
            setDescription((prev) => (prev ? `${prev} ${spokenText}` : spokenText).slice(0, 3000));
          } else {
            setExtraLandmarkVoice(spokenText);
            setDescription((prev) =>
              (prev ? `${prev}\n[Landmark/Context]: ${spokenText}` : spokenText).slice(0, 3000)
            );
            // Auto-classify severity/category from spoken context
            try {
              const aiRes = await fetch('/api/voice/assistant', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  message: `Extract civic report details from: ${title}. ${description}. ${spokenText}`,
                  language,
                  userContext: { isSignedIn: Boolean(firebaseUser), currentAddress: manualAddress || address },
                }),
              });
              const aiJson = await aiRes.json();
              if (aiRes.ok && aiJson.extractedReport) {
                if (
                  aiJson.extractedReport.category &&
                  CATEGORIES.includes(aiJson.extractedReport.category as CivicCategory)
                ) {
                  setCategory(aiJson.extractedReport.category as CivicCategory);
                }
                if (aiJson.extractedReport.severity) {
                  setSeverity(aiJson.extractedReport.severity);
                }
                if (aiJson.extractedReport.locationMentioned && !manualAddress) {
                  setManualAddress(aiJson.extractedReport.locationMentioned);
                }
              }
            } catch {
              // Classification hint is best-effort
            }
          }
        } catch (err: any) {
          setWizardVoiceError(err?.message || 'Unable to transcribe speech.');
        } finally {
          setTranscribingStep(false);
        }
      };

      mediaRecorderRef.current = recorder;
      recorder.start(250);
      setRecordingStep(true);
    } catch (err: any) {
      setWizardVoiceError(
        err?.name === 'NotAllowedError'
          ? 'Microphone permission denied. Please enable mic access or type below.'
          : err?.message || 'Unable to start microphone.'
      );
    }
  };

  const stopStepRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
  };

  const speakWizardSummary = async () => {
    const summaryText = `Please confirm your civic report. Category: ${category}, routed to ${
      DEPT_MAP[category]
    }. Title: ${title || 'Not entered'}. Severity: ${severity}. Location: ${
      manualAddress || address || 'GPS coordinates attached'
    }. Description: ${description || 'Not entered'}.`;

    setReadingBack(true);
    try {
      const res = await fetch('/api/voice/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: summaryText, language }),
      });
      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        readbackAudioRef.current = audio;
        audio.onended = () => {
          setReadingBack(false);
          URL.revokeObjectURL(url);
        };
        audio.onerror = () => setReadingBack(false);
        await audio.play();
        return;
      }
    } catch {
      // Fallback to Web Speech Synthesis
    }
    if ('speechSynthesis' in window) {
      const u = new SpeechSynthesisUtterance(summaryText);
      u.lang = language === 'hi' ? 'hi-IN' : 'en-IN';
      u.onend = () => setReadingBack(false);
      u.onerror = () => setReadingBack(false);
      window.speechSynthesis.speak(u);
    } else {
      setReadingBack(false);
    }
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

  const handleConfirmSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
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
      setSubmitError('Location coordinates are required. Click "Acquire GPS", search address, or tap on the map.');
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
        message: `Routed to ${department}. Integrity status: ${fraudQueueStatus.replace(/_/g, ' ')}.`,
        relatedId: reportDocId,
        read: false,
        createdAt: serverTimestamp(),
      });

      const nowIso = new Date().toISOString();
      const syncRes = await fetch('/api/reports/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...firestorePayload,
          id: reportDocId,
          photoUrls: uploadedPhotos,
          fraudProbability: analysis?.fraudProbability,
          evidenceCompleteness: analysis?.evidenceCompleteness,
          recommendedActionText: analysis?.recommendedActionText,
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
      const syncJson = await syncRes.json().catch(() => ({}));

      setSubmittedResult({
        complaintId,
        referenceNumber: syncJson.referenceNumber || `REF-${complaintId}`,
        department,
        fraudQueueStatus,
      });
      setTitle('');
      setDescription('');
      setPhotoDataUrl('');
      setUploadedPhotos([]);
      setVideoName('');
      setExtraLandmarkVoice('');
      setAnalysis(null);
      setVoiceWizardOpen(false);
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
            Report manually or use the 5-step Guided Voice Wizard. Every submission receives a trackable Complaint ID &amp; Reference Number.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setVoiceWizardOpen((v) => !v);
              setWizardStep(1);
            }}
            className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-lg transition-colors whitespace-nowrap ${
              voiceWizardOpen
                ? 'bg-slate-900 text-white'
                : 'bg-green-900 text-white hover:bg-green-800'
            }`}
          >
            <Mic className="w-4 h-4" />
            {voiceWizardOpen ? 'Close Voice Wizard' : 'Report an Issue Using Voice'}
          </button>
          <button
            type="button"
            onClick={onOpenVoiceAssistant}
            className="inline-flex items-center gap-2 px-3.5 py-2.5 border border-slate-200 text-slate-800 text-xs font-medium rounded-lg hover:bg-slate-50 whitespace-nowrap"
          >
            Ask SEVA SAATHI
          </button>
        </div>
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

      {/* 5-Step Guided Voice Reporting Wizard */}
      {voiceWizardOpen && (
        <div className="border-2 border-green-900/30 bg-emerald-50/40 rounded-xl p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-xs font-semibold text-green-900 uppercase tracking-wide">
                Guided Voice Reporting · Step {wizardStep} of 5
              </div>
              <h2 className="font-display text-lg font-bold text-slate-900 mt-0.5">
                {wizardStep === 1 && 'Step 1: Speak Incident Title'}
                {wizardStep === 2 && 'Step 2: Speak Detailed Description'}
                {wizardStep === 3 && 'Step 3: Capture Live GPS or Select Location'}
                {wizardStep === 4 && 'Step 4: Speak Additional Details / Landmarks'}
                {wizardStep === 5 && 'Step 5: Listen to Read-Back & Confirm Submission'}
              </h2>
            </div>

            <div className="flex items-center gap-1">
              {[1, 2, 3, 4, 5].map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setWizardStep(s as 1 | 2 | 3 | 4 | 5)}
                  className={`w-7 h-7 rounded-full text-xs font-semibold ${
                    wizardStep === s
                      ? 'bg-green-900 text-white'
                      : wizardStep > s
                      ? 'bg-emerald-200 text-green-950'
                      : 'bg-white border border-slate-200 text-slate-500'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          {wizardStep === 1 && (
            <div className="space-y-3">
              <p className="text-xs text-slate-600">
                Press Start Speaking and state a short summary (e.g., &ldquo;Deep pothole near Station Road bus stop&rdquo;). Review or edit the transcript below.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {!recordingStep ? (
                  <button
                    type="button"
                    disabled={transcribingStep}
                    onClick={() => startStepRecording('title')}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-green-900 text-white text-xs font-semibold rounded-lg"
                  >
                    <Mic className="w-4 h-4" />
                    {transcribingStep ? 'Transcribing...' : 'Speak Incident Title'}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={stopStepRecording}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-red-600 text-white text-xs font-semibold rounded-lg"
                  >
                    <MicOff className="w-4 h-4 animate-pulse" />
                    Stop Recording
                  </button>
                )}
              </div>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Recognized or typed incident title..."
                className="w-full text-sm bg-white border border-slate-200 rounded-lg px-3 py-2.5"
              />
            </div>
          )}

          {wizardStep === 2 && (
            <div className="space-y-3">
              <p className="text-xs text-slate-600">
                Describe what happened, traffic or safety impact, and how long it has been unresolved.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {!recordingStep ? (
                  <button
                    type="button"
                    disabled={transcribingStep}
                    onClick={() => startStepRecording('description')}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-green-900 text-white text-xs font-semibold rounded-lg"
                  >
                    <Mic className="w-4 h-4" />
                    {transcribingStep ? 'Transcribing...' : 'Speak Full Description'}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={stopStepRecording}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-red-600 text-white text-xs font-semibold rounded-lg"
                  >
                    <MicOff className="w-4 h-4 animate-pulse" />
                    Stop Recording
                  </button>
                )}
              </div>
              <textarea
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Recognized or typed detailed description..."
                className="w-full text-sm bg-white border border-slate-200 rounded-lg px-3 py-2.5"
              />
            </div>
          )}

          {wizardStep === 3 && (
            <div className="space-y-3">
              <p className="text-xs text-slate-600">
                Acquire live browser GPS or search an address/landmark so dispatch teams know the exact site.
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => requestCurrentLocation()}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-green-900 text-white text-xs font-semibold rounded-lg"
                >
                  <Navigation className="w-3.5 h-3.5" />
                  Acquire Live GPS
                </button>
                <div className="flex-1 flex gap-1.5 min-w-[220px]">
                  <input
                    type="text"
                    value={placeQuery}
                    onChange={(e) => setPlaceQuery(e.target.value)}
                    placeholder="Search street, market, or city..."
                    className="flex-1 text-xs bg-white border border-slate-200 rounded-lg px-3 py-2"
                  />
                  <button
                    type="button"
                    disabled={searchingPlace}
                    onClick={() => handleSearchPlace()}
                    className="px-3 py-2 bg-slate-900 text-white text-xs font-medium rounded-lg"
                  >
                    {searchingPlace ? '...' : 'Set Pin'}
                  </button>
                </div>
              </div>
              {lat !== null && lng !== null && (
                <div className="text-xs bg-white border border-slate-200 rounded-lg p-2.5 font-mono text-slate-700">
                  Selected Pin: {lat.toFixed(5)}, {lng.toFixed(5)} · {manualAddress || address}
                </div>
              )}
            </div>
          )}

          {wizardStep === 4 && (
            <div className="space-y-3">
              <p className="text-xs text-slate-600">
                Speak nearby landmarks, urgency, or upload a photo below. SEVA AI will auto-verify category &amp; severity.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {!recordingStep ? (
                  <button
                    type="button"
                    disabled={transcribingStep}
                    onClick={() => startStepRecording('extra')}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-green-900 text-white text-xs font-semibold rounded-lg"
                  >
                    <Mic className="w-4 h-4" />
                    {transcribingStep ? 'Transcribing & Classifying...' : 'Speak Landmarks / Additional Details'}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={stopStepRecording}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-red-600 text-white text-xs font-semibold rounded-lg"
                  >
                    <MicOff className="w-4 h-4 animate-pulse" />
                    Stop Recording
                  </button>
                )}
              </div>
              {extraLandmarkVoice && (
                <div className="text-xs bg-white border border-slate-200 rounded-lg p-2.5 text-slate-800">
                  <strong>Added Context:</strong> {extraLandmarkVoice}
                </div>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <div>
                  <label className="font-semibold text-slate-700 block mb-1">Confirmed Category</label>
                  <select
                    value={category}
                    onChange={(e) => setCategory(e.target.value as CivicCategory)}
                    className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-2"
                  >
                    {CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="font-semibold text-slate-700 block mb-1">Severity</label>
                  <select
                    value={severity}
                    onChange={(e) => setSeverity(e.target.value as SeverityLevel)}
                    className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-2"
                  >
                    <option value="Low">Low</option>
                    <option value="Medium">Medium</option>
                    <option value="High">High</option>
                    <option value="Critical">Critical</option>
                  </select>
                </div>
              </div>
            </div>
          )}

          {wizardStep === 5 && (
            <div className="space-y-3 bg-white border border-slate-200 rounded-xl p-4 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="font-semibold text-slate-900 text-sm">Review &amp; Confirm Voice Submission</div>
                <button
                  type="button"
                  disabled={readingBack}
                  onClick={speakWizardSummary}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-900 text-white text-xs font-medium rounded-lg"
                >
                  <Volume2 className="w-3.5 h-3.5" />
                  {readingBack ? 'Reading Summary...' : 'Voice Read-Back'}
                </button>
              </div>
              <div>
                <strong>Category:</strong> {category} → {DEPT_MAP[category]}
              </div>
              <div>
                <strong>Title:</strong> {title || 'Missing'}
              </div>
              <div>
                <strong>Description:</strong> {description || 'Missing'}
              </div>
              <div>
                <strong>Location:</strong>{' '}
                {lat !== null && lng !== null
                  ? `${manualAddress || address} (${lat.toFixed(5)}, ${lng.toFixed(5)})`
                  : 'Coordinates required — go to Step 3'}
              </div>
              <button
                type="button"
                disabled={submitting}
                onClick={() => handleConfirmSubmit()}
                className="w-full py-2.5 bg-green-900 text-white text-sm font-semibold rounded-lg hover:bg-green-800 disabled:opacity-50"
              >
                {submitting ? 'Submitting Report...' : 'Confirm & Submit Voice Report'}
              </button>
            </div>
          )}

          {wizardVoiceError && (
            <div className="text-xs text-red-800 bg-red-50 border border-red-200 rounded-lg p-2.5">
              {wizardVoiceError}
            </div>
          )}

          <div className="flex items-center justify-between pt-2 border-t border-emerald-200/70">
            <button
              type="button"
              disabled={wizardStep === 1}
              onClick={() => setWizardStep((s) => Math.max(1, s - 1) as any)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-slate-300 bg-white rounded-lg disabled:opacity-40"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Back
            </button>
            {wizardStep < 5 && (
              <button
                type="button"
                onClick={() => setWizardStep((s) => Math.min(5, s + 1) as any)}
                className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold bg-green-900 text-white rounded-lg"
              >
                Next Step
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      )}

      {submittedResult && (
        <div className="border border-emerald-700/30 bg-emerald-50 rounded-xl p-5 space-y-2">
          <div className="flex items-center gap-2 text-green-900 font-display font-semibold">
            <CheckCircle2 className="w-5 h-5" />
            Report Confirmed &amp; Saved
          </div>
          <p className="text-sm text-slate-800">
            Complaint ID: <span className="font-mono font-semibold">{submittedResult.complaintId}</span> · Reference:{' '}
            <span className="font-mono font-semibold">{submittedResult.referenceNumber}</span> · Routed to{' '}
            <strong>{submittedResult.department}</strong> · Screening status:{' '}
            <span className="capitalize">{submittedResult.fraudQueueStatus.replace(/_/g, ' ')}</span>
          </p>
          <button
            type="button"
            onClick={onSubmittedSuccess}
            className="text-xs font-semibold text-green-900 underline"
          >
            Track Complaint &amp; Reference Number in My Reports →
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
              <label className="block text-xs font-semibold text-slate-700 mb-1">Incident Title</label>
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
              <label className="block text-xs font-semibold text-slate-700 mb-1">Severity</label>
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
            <label className="block text-xs font-semibold text-slate-700 mb-1">Detailed Description</label>
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
                <div className="text-xs font-semibold text-slate-800">
                  {uploadingPhoto ? 'Uploading Photo(s)...' : 'Capture or Upload Photos'}
                </div>
                <div className="text-xs text-slate-500 truncate">
                  {uploadedPhotos.length > 0
                    ? `${uploadedPhotos.length} photo(s) saved`
                    : photoDataUrl
                    ? 'Photo attached'
                    : 'JPEG / PNG / WEBP evidence'}
                </div>
              </div>
              <input
                type="file"
                accept="image/*"
                multiple
                onChange={handlePhotoUpload}
                className="hidden"
              />
            </label>

            <label className="border border-dashed border-slate-300 rounded-lg p-3.5 flex items-center gap-3 cursor-pointer hover:bg-slate-50">
              <FileVideo className="w-5 h-5 text-slate-700 shrink-0" />
              <div className="min-w-0">
                <div className="text-xs font-semibold text-slate-800">Attach Video Clip (Optional)</div>
                <div className="text-xs text-slate-500 truncate">{videoName || 'MP4 / WebM evidence'}</div>
              </div>
              <input type="file" accept="video/*" onChange={handleVideoUpload} className="hidden" />
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
                onClick={() => {
                  setPhotoDataUrl('');
                  setUploadedPhotos([]);
                }}
                className="absolute top-2 right-2 px-2.5 py-1 bg-slate-900/80 text-white text-xs rounded-md inline-flex items-center gap-1"
              >
                <X className="w-3 h-3" />
                Remove
              </button>
            </div>
          )}

          {uploadedPhotos.length > 1 && (
            <div className="flex flex-wrap gap-2">
              {uploadedPhotos.map((u) => (
                <a
                  key={u.id}
                  href={u.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs px-2.5 py-1 bg-slate-100 rounded border border-slate-200 text-slate-700 hover:underline"
                >
                  {u.originalName}
                </a>
              ))}
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

        {/* Right Column: GPS Pin & Manual Search + AI Verification */}
        <div className="lg:col-span-5 space-y-5">
          <div className="border border-slate-200 rounded-xl bg-white p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-display text-sm font-semibold text-slate-900">Incident Location Pin</h3>
              <button
                type="button"
                onClick={() => requestCurrentLocation()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 text-slate-800 text-xs font-medium rounded-md hover:bg-slate-200"
              >
                <Navigation className="w-3.5 h-3.5" />
                Acquire GPS
              </button>
            </div>

            {/* Manual Address Search */}
            <div className="flex gap-1.5">
              <input
                type="text"
                value={placeQuery}
                onChange={(e) => setPlaceQuery(e.target.value)}
                placeholder="Or search street / ward / landmark..."
                className="flex-1 text-xs border border-slate-200 rounded-lg px-2.5 py-2"
              />
              <button
                type="button"
                disabled={searchingPlace}
                onClick={() => handleSearchPlace()}
                className="inline-flex items-center gap-1 px-3 py-2 bg-slate-900 text-white text-xs font-medium rounded-lg"
              >
                <Search className="w-3.5 h-3.5" />
                {searchingPlace ? '...' : 'Find'}
              </button>
            </div>
            {placeError && <div className="text-xs text-red-700">{placeError}</div>}

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
                  Click &ldquo;Acquire GPS&rdquo; or search an address above to attach coordinates.
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
                  AI Analysis &amp; Seva Trust Verification
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
                  <div className="text-slate-500">Evidence Completeness</div>
                  <div className="font-medium text-slate-900 mt-0.5">
                    {analysis.evidenceCompleteness || (photoDataUrl ? 'Complete' : 'Partial')}
                  </div>
                </div>
              </div>

              {analysis.detectedIssueFromImage && photoDataUrl && (
                <div className="text-xs text-slate-700 bg-white border border-slate-200 rounded-lg p-2.5">
                  <strong>Photo Inspection:</strong> {analysis.detectedIssueFromImage}
                </div>
              )}

              <div className="text-xs text-slate-700 bg-white border border-slate-200 rounded-lg p-2.5">
                <strong>Verification Assessment:</strong> {analysis.fraudExplanation}
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
                    Non-emergency reports with score ≥60 enter the Authority Verification Queue for secondary confirmation. Genuine emergencies always dispatch immediately.
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
