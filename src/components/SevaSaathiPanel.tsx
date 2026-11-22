import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  Edit3,
  Globe,
  Mic,
  MicOff,
  Pause,
  Play,
  RotateCcw,
  Send,
  ShieldAlert,
  Square,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useLocationEngine } from '../contexts/LocationContext';
import { AppTab, CivicReport, SupportedLanguage, VoiceDraftPayload } from '../types/seva';

interface VoiceOption {
  voice_id: string;
  name: string;
}

interface LanguageCapability {
  code: SupportedLanguage;
  label: string;
  nativeLabel: string;
  sttSupported: boolean;
  ttsSupported: boolean;
  notes: string;
}

interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
  audioUrl?: string;
  draftReport?: VoiceDraftPayload & { missingFields?: string[] };
  navTarget?: AppTab;
  shouldTriggerSos?: boolean;
}

interface SevaSaathiPanelProps {
  isOpen: boolean;
  onClose: () => void;
  language: SupportedLanguage;
  onLanguageChange: (lang: SupportedLanguage) => void;
  myReports: CivicReport[];
  onPopulateReportDraft: (draft: VoiceDraftPayload) => void;
  onNavigate: (tab: AppTab) => void;
  externalSpeakRequest?: { text: string; id: number } | null;
}

type VoicePhase = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'synthesizing' | 'speaking';

export const SevaSaathiPanel: React.FC<SevaSaathiPanelProps> = ({
  isOpen,
  onClose,
  language,
  onLanguageChange,
  myReports,
  onPopulateReportDraft,
  onNavigate,
  externalSpeakRequest,
}) => {
  const { firebaseUser, profile, authoritySession } = useAuth();
  const { lat, lng, address } = useLocationEngine();

  const [elevenlabsConfigured, setElevenlabsConfigured] = useState<boolean | null>(null);
  const [geminiVoiceFallback, setGeminiVoiceFallback] = useState<boolean>(false);
  const [activeVoiceProvider, setActiveVoiceProvider] = useState<'elevenlabs' | 'gemini' | 'browser' | null>(null);
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [selectedVoiceId, setSelectedVoiceId] = useState('21m00Tcm4TlvDq8ikWAM');
  const [langCaps, setLangCaps] = useState<LanguageCapability[]>([]);

  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [micPermission, setMicPermission] = useState<'unknown' | 'granted' | 'denied' | 'unavailable'>('unknown');
  const [consentGranted, setConsentGranted] = useState(true);
  const [muted, setMuted] = useState(false);

  const [pendingTranscript, setPendingTranscript] = useState('');
  const [editingTranscript, setEditingTranscript] = useState(false);
  const [textInput, setTextInput] = useState('');
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [turns, setTurns] = useState<ChatTurn[]>([]);

  const [isPaused, setIsPaused] = useState(false);
  const [activeAudioTurnId, setActiveAudioTurnId] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const createdUrlsRef = useRef<string[]>([]);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  const serverVoiceReady = Boolean(elevenlabsConfigured || geminiVoiceFallback);

  // Load voice engine capabilities on mount
  useEffect(() => {
    fetch('/api/voice/capabilities')
      .then((r) => r.json())
      .then((data) => {
        setElevenlabsConfigured(Boolean(data.elevenlabsConfigured));
        setGeminiVoiceFallback(Boolean(data.geminiVoiceFallback));
        setActiveVoiceProvider(data.activeVoiceProvider || null);
        if (Array.isArray(data.voices) && data.voices.length > 0) {
          setVoices(data.voices);
          setSelectedVoiceId(data.voices[0].voice_id);
        }
        if (Array.isArray(data.languages)) {
          setLangCaps(data.languages);
        }
      })
      .catch(() => {
        setElevenlabsConfigured(false);
        setGeminiVoiceFallback(false);
      });
  }, []);

  // Check microphone permission status honestly
  useEffect(() => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setMicPermission('unavailable');
      return;
    }
    if (navigator.permissions && navigator.permissions.query) {
      navigator.permissions
        .query({ name: 'microphone' as PermissionName })
        .then((status) => {
          setMicPermission(
            status.state === 'granted' ? 'granted' : status.state === 'denied' ? 'denied' : 'unknown'
          );
          status.onchange = () => {
            setMicPermission(
              status.state === 'granted' ? 'granted' : status.state === 'denied' ? 'denied' : 'unknown'
            );
          };
        })
        .catch(() => {});
    }
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns, pendingTranscript]);

  const stopAudioPlayback = useCallback(() => {
    if (audioElRef.current) {
      audioElRef.current.pause();
      audioElRef.current.currentTime = 0;
    }
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    setIsPaused(false);
    setActiveAudioTurnId(null);
    if (phase === 'speaking') setPhase('idle');
  }, [phase]);

  const cleanupRecordingResources = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    analyserRef.current = null;
    mediaRecorderRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      cleanupRecordingResources();
      stopAudioPlayback();
      createdUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
      createdUrlsRef.current = [];
    };
  }, [cleanupRecordingResources, stopAudioPlayback]);

  const drawLiveWaveform = useCallback(() => {
    const canvas = canvasRef.current;
    const analyser = analyserRef.current;
    if (!canvas || !analyser) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const bufferLen = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLen);

    const renderFrame = () => {
      if (!analyserRef.current) return;
      analyserRef.current.getByteFrequencyData(dataArray);
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const barCount = 32;
      const step = Math.max(1, Math.floor(bufferLen / barCount));
      const barWidth = canvas.width / barCount;

      for (let i = 0; i < barCount; i++) {
        const val = dataArray[i * step] || 0;
        const normalized = Math.max(0.08, val / 255);
        const h = normalized * (canvas.height - 6);
        const x = i * barWidth + 2;
        const y = (canvas.height - h) / 2;
        ctx.fillStyle = '#14532D';
        ctx.fillRect(x, y, Math.max(3, barWidth - 4), h);
      }

      rafRef.current = requestAnimationFrame(renderFrame);
    };
    renderFrame();
  }, []);

  const playSpeechForText = useCallback(
    async (text: string, turnId: string) => {
      if (muted || !text.trim()) return;
      stopAudioPlayback();

      const speakWithBrowserFallback = (content: string) => {
        if (!('speechSynthesis' in window)) return false;
        const utter = new SpeechSynthesisUtterance(content);
        utter.lang =
          language === 'hi'
            ? 'hi-IN'
            : language === 'bn'
            ? 'bn-IN'
            : language === 'as'
            ? 'as-IN'
            : 'en-IN';
        utter.rate = 0.96;
        utter.onstart = () => {
          setPhase('speaking');
          setIsPaused(false);
        };
        utter.onend = () => {
          setPhase('idle');
          setIsPaused(false);
          setActiveAudioTurnId(null);
        };
        utter.onerror = () => {
          setPhase('idle');
          setActiveAudioTurnId(null);
        };
        window.speechSynthesis.speak(utter);
        return true;
      };

      setPhase('synthesizing');
      setActiveAudioTurnId(turnId);

      try {
        const res = await fetch('/api/voice/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text,
            voiceId: selectedVoiceId,
            language,
          }),
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          if (speakWithBrowserFallback(text)) return;
          setPhase('idle');
          setActiveAudioTurnId(null);
          setErrorBanner(
            errData.error ||
              'Server speech synthesis is unavailable. Text response is displayed below.'
          );
          return;
        }

        const providerHeader = res.headers.get('X-Voice-Provider');
        if (providerHeader === 'elevenlabs' || providerHeader === 'gemini') {
          setActiveVoiceProvider(providerHeader);
        }

        const audioBlob = await res.blob();
        const url = URL.createObjectURL(audioBlob);
        createdUrlsRef.current.push(url);
        setTurns((prev) => prev.map((t) => (t.id === turnId ? { ...t, audioUrl: url } : t)));

        const audio = new Audio(url);
        audioElRef.current = audio;
        audio.onplay = () => {
          setPhase('speaking');
          setIsPaused(false);
        };
        audio.onpause = () => {
          if (!audio.ended) setIsPaused(true);
        };
        audio.onended = () => {
          setPhase('idle');
          setIsPaused(false);
          setActiveAudioTurnId(null);
        };
        audio.onerror = () => {
          if (!speakWithBrowserFallback(text)) {
            setPhase('idle');
            setActiveAudioTurnId(null);
            setErrorBanner('Audio playback failed on this device.');
          }
        };
        await audio.play();
      } catch (err: any) {
        if (speakWithBrowserFallback(text)) return;
        setPhase('idle');
        setActiveAudioTurnId(null);
        setErrorBanner(err?.message || 'Unable to generate voice audio.');
      }
    },
    [language, muted, selectedVoiceId, stopAudioPlayback]
  );

  // Triggered from Authority Dashboard or Seva Shield spoken briefing requests
  useEffect(() => {
    if (!externalSpeakRequest?.text) return;
    const turnId = `brief-${externalSpeakRequest.id}`;
    setTurns((prev) => [
      ...prev,
      {
        id: turnId,
        role: 'assistant',
        text: externalSpeakRequest.text,
        timestamp: new Date().toLocaleTimeString(),
      },
    ]);
    playSpeechForText(externalSpeakRequest.text, turnId);
  }, [externalSpeakRequest]);

  const sendMessageToSaathi = useCallback(
    async (messageText: string) => {
      const trimmed = messageText.trim();
      if (!trimmed) return;

      setErrorBanner(null);
      setPendingTranscript('');
      setEditingTranscript(false);
      setTextInput('');

      const userTurn: ChatTurn = {
        id: `u-${Date.now()}`,
        role: 'user',
        text: trimmed,
        timestamp: new Date().toLocaleTimeString(),
      };
      setTurns((prev) => [...prev, userTurn]);
      setPhase('thinking');

      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (authoritySession?.token) {
          headers.Authorization = `Bearer ${authoritySession.token}`;
        }

        const res = await fetch('/api/voice/assistant', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            message: trimmed,
            language,
            history: turns.slice(-6).map((t) => ({ role: t.role, text: t.text })),
            userContext: {
              isSignedIn: Boolean(firebaseUser),
              role: authoritySession ? authoritySession.role : profile?.role || 'citizen',
              currentAddress: address || undefined,
              lat: lat ?? undefined,
              lng: lng ?? undefined,
              myReportsSummary: myReports.slice(0, 8).map((r) => ({
                complaintId: r.complaintId,
                referenceNumber: r.referenceNumber,
                title: r.title,
                category: r.category,
                status: r.status,
                updatedAt: String(r.updatedAt || ''),
              })),
              includeAuthorityStats: Boolean(authoritySession),
            },
          }),
        });

        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || 'SEVA SAATHI could not process your request.');
        }

        const assistantTurnId = `a-${Date.now()}`;
        const assistantTurn: ChatTurn = {
          id: assistantTurnId,
          role: 'assistant',
          text: data.replyText || 'How can I assist you with civic services today?',
          timestamp: new Date().toLocaleTimeString(),
          draftReport:
            data.intent === 'report_issue' && data.extractedReport
              ? {
                  category: data.extractedReport.category,
                  title: data.extractedReport.title,
                  description: data.extractedReport.description || trimmed,
                  severity: data.extractedReport.severity,
                  locationMentioned: data.extractedReport.locationMentioned,
                  missingFields: data.extractedReport.missingFields,
                }
              : undefined,
          navTarget: data.navigationTarget,
          shouldTriggerSos: Boolean(data.shouldTriggerSosFlow),
        };

        setTurns((prev) => [...prev, assistantTurn]);
        setPhase('idle');

        if (!muted && serverVoiceReady) {
          await playSpeechForText(assistantTurn.text, assistantTurnId);
        }
      } catch (err: any) {
        setPhase('idle');
        setErrorBanner(err?.message || 'Unable to reach SEVA SAATHI backend.');
      }
    },
    [
      address,
      authoritySession,
      firebaseUser,
      language,
      lat,
      lng,
      muted,
      myReports,
      playSpeechForText,
      profile?.role,
      serverVoiceReady,
      turns,
    ]
  );

  const startRecording = async () => {
    if (!consentGranted) {
      setErrorBanner('Please confirm voice processing consent before recording.');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setMicPermission('unavailable');
      setErrorBanner('Microphone capture is not supported in this browser.');
      return;
    }

    stopAudioPlayback();
    setErrorBanner(null);
    setPendingTranscript('');
    setEditingTranscript(false);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      setMicPermission('granted');
      mediaStreamRef.current = stream;

      const audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 128;
      source.connect(analyser);
      audioCtxRef.current = audioCtx;
      analyserRef.current = analyser;

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
        cleanupRecordingResources();

        if (blob.size < 450) {
          setPhase('idle');
          setErrorBanner('Recording was empty or too brief. Please hold or tap Speak and speak clearly.');
          return;
        }

        setPhase('transcribing');
        try {
          const form = new FormData();
          form.append('audio', blob, 'citizen_voice.webm');
          form.append('language', language);

          const res = await fetch('/api/voice/stt', {
            method: 'POST',
            body: form,
          });
          const data = await res.json();
          if (!res.ok) {
            setPhase('idle');
            setErrorBanner(
              data.error ||
                'ElevenLabs transcription failed. You can type your message in the text box below.'
            );
            return;
          }

          setPendingTranscript(data.text);
          setEditingTranscript(true);
          setPhase('idle');
        } catch (err: any) {
          setPhase('idle');
          setErrorBanner(err?.message || 'Speech recognition request failed.');
        }
      };

      mediaRecorderRef.current = recorder;
      recorder.start(250);
      setPhase('listening');
      requestAnimationFrame(drawLiveWaveform);
    } catch (err: any) {
      cleanupRecordingResources();
      setPhase('idle');
      if (err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError') {
        setMicPermission('denied');
        setErrorBanner('Microphone permission denied. Allow microphone access in browser settings or use text input.');
      } else {
        setErrorBanner(err?.message || 'Unable to start microphone recording.');
      }
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
  };

  const togglePauseResumeAudio = () => {
    const audio = audioElRef.current;
    if (!audio) return;
    if (audio.paused) {
      audio.play().catch(() => {});
      setIsPaused(false);
      setPhase('speaking');
    } else {
      audio.pause();
      setIsPaused(true);
    }
  };

  if (!isOpen) return null;

  const currentLangInfo = langCaps.find((l) => l.code === language);

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-slate-900/35 backdrop-blur-[1px]"
      role="dialog"
      aria-label="SEVA SAATHI ElevenLabs Voice Assistant"
    >
      <div className="w-full max-w-lg bg-white h-full flex flex-col border-l border-slate-200 shadow-xl">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-4 bg-white">
          <div className="flex items-center gap-3 min-w-0">
            <img
              src="/src/assets/images/seva_saathi_avatar_1795250515781.jpg"
              alt="SEVA SAATHI Civic Advisor"
              referrerPolicy="no-referrer"
              className="w-10 h-10 rounded-full object-cover border border-slate-200 shrink-0"
            />
            <div className="min-w-0">
              <h2 className="font-display text-base font-semibold text-slate-900 truncate">
                SEVA SAATHI
              </h2>
              <p className="text-xs text-slate-500 truncate">
                Your Voice, Your City, Your Seva · ElevenLabs AI
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => {
                setMuted((m) => !m);
                if (!muted) stopAudioPlayback();
              }}
              aria-label={muted ? 'Unmute assistant speech' : 'Mute assistant speech'}
              className="p-2 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 transition-colors"
              title={muted ? 'Unmute speech' : 'Mute speech'}
            >
              {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
            </button>
            <button
              type="button"
              onClick={() => {
                stopAudioPlayback();
                setTurns([]);
                setPendingTranscript('');
                setErrorBanner(null);
              }}
              aria-label="Clear conversation"
              className="p-2 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 transition-colors"
              title="Clear conversation"
            >
              <RotateCcw className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close voice assistant"
              className="p-2 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Language, Voice & Permission Controls */}
        <div className="px-5 py-3 bg-slate-50 border-b border-slate-200 space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 flex-wrap">
              <Globe className="w-3.5 h-3.5 text-slate-500 shrink-0" />
              {(['en', 'hi', 'bn', 'as'] as SupportedLanguage[]).map((code) => {
                const labelMap: Record<SupportedLanguage, string> = {
                  en: 'English',
                  hi: 'हिन्दी',
                  bn: 'বাংলা',
                  as: 'অসমীয়া',
                };
                return (
                  <button
                    key={code}
                    type="button"
                    onClick={() => onLanguageChange(code)}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                      language === code
                        ? 'bg-green-900 text-white'
                        : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    {labelMap[code]}
                  </button>
                );
              })}
            </div>

            <div className="text-xs text-slate-600">
              Mic:{' '}
              <span className="font-medium text-slate-900">
                {micPermission === 'granted'
                  ? 'Allowed'
                  : micPermission === 'denied'
                  ? 'Denied'
                  : micPermission === 'unavailable'
                  ? 'Unavailable'
                  : 'Ready'}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <label htmlFor="saathi-voice-select" className="text-xs text-slate-600 shrink-0">
              Voice:
            </label>
            <select
              id="saathi-voice-select"
              value={selectedVoiceId}
              onChange={(e) => setSelectedVoiceId(e.target.value)}
              className="flex-1 text-xs bg-white border border-slate-200 rounded-md px-2.5 py-1.5 text-slate-800 focus:outline-none focus:ring-2 focus:ring-green-800"
            >
              {voices.map((v) => (
                <option key={v.voice_id} value={v.voice_id}>
                  {v.name}
                </option>
              ))}
            </select>
          </div>

          {elevenlabsConfigured === false && geminiVoiceFallback && (
            <div className="text-xs text-emerald-950 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
              <strong>Voice Engine Active (Gemini Speech Fallback):</strong> Live voice transcription and spoken replies are active right now. Add <code className="font-mono">ELEVENLABS_API_KEY</code> in Settings &gt; Secrets to use ElevenLabs voices.
            </div>
          )}

          {elevenlabsConfigured === false && !geminiVoiceFallback && (
            <div className="text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              <strong>Voice Keys Missing:</strong> Add <code className="font-mono">ELEVENLABS_API_KEY</code> or <code className="font-mono">GEMINI_API_KEY</code> in Settings &gt; Secrets for live voice synthesis. Text chat remains available.
            </div>
          )}

          {currentLangInfo && currentLangInfo.code !== 'en' && currentLangInfo.code !== 'hi' && (
            <div className="text-xs text-slate-700 bg-white border border-slate-200 rounded-lg px-3 py-2">
              {currentLangInfo.notes}
            </div>
          )}

          <label className="flex items-start gap-2 text-xs text-slate-600 cursor-pointer">
            <input
              type="checkbox"
              checked={consentGranted}
              onChange={(e) => setConsentGranted(e.target.checked)}
              className="mt-0.5 rounded border-slate-300 text-green-900 focus:ring-green-900"
            />
            <span>
              I consent to transient microphone audio processing for civic assistance. Audio clips are not stored permanently.
            </span>
          </label>
        </div>

        {/* Conversation Feed */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {turns.length === 0 && (
            <div className="border border-slate-200 rounded-xl p-4 bg-slate-50 space-y-3">
              <p className="text-sm text-slate-800 font-medium">
                Ask SEVA SAATHI in English, Hindi, Bengali, or Assamese:
              </p>
              <div className="grid grid-cols-1 gap-2">
                {[
                  'There is a large pothole near my street causing problems for vehicles.',
                  'How can I report garbage accumulation or a blocked drain?',
                  'What is the status of my latest submitted complaint?',
                  'मेरे इलाके में जलभराव और नाले जाम होने की शिकायत दर्ज करें।',
                ].map((promptText) => (
                  <button
                    key={promptText}
                    type="button"
                    onClick={() => sendMessageToSaathi(promptText)}
                    className="text-left text-xs text-slate-700 bg-white border border-slate-200 hover:border-green-800 rounded-lg px-3 py-2 transition-colors"
                  >
                    &ldquo;{promptText}&rdquo;
                  </button>
                ))}
              </div>
            </div>
          )}

          {turns.map((turn) => (
            <div
              key={turn.id}
              className={`flex flex-col ${turn.role === 'user' ? 'items-end' : 'items-start'}`}
            >
              <div
                className={`max-w-[88%] rounded-xl px-4 py-3 text-sm leading-relaxed ${
                  turn.role === 'user'
                    ? 'bg-green-900 text-white'
                    : 'bg-slate-50 border border-slate-200 text-slate-900'
                }`}
              >
                <div className="text-xs opacity-75 mb-1">
                  {turn.role === 'user' ? 'Citizen' : 'SEVA SAATHI'} · {turn.timestamp}
                </div>
                <p>{turn.text}</p>

                {turn.role === 'assistant' && (
                  <div className="mt-2.5 pt-2 border-t border-slate-200/80 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => playSpeechForText(turn.text, turn.id)}
                      className="inline-flex items-center gap-1.5 text-xs font-medium text-green-900 hover:text-green-700"
                    >
                      <Play className="w-3.5 h-3.5" />
                      Listen
                    </button>

                    {!authoritySession && turn.draftReport && (
                      <button
                        type="button"
                        onClick={() => {
                          onPopulateReportDraft({
                            category: turn.draftReport?.category,
                            title: turn.draftReport?.title,
                            description: turn.draftReport?.description,
                            severity: turn.draftReport?.severity,
                            locationMentioned: turn.draftReport?.locationMentioned,
                          });
                          onClose();
                        }}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-green-900 text-white text-xs font-medium rounded-md hover:bg-green-800"
                      >
                        Review &amp; Fill Report Form
                      </button>
                    )}

                    {!authoritySession && turn.navTarget && !turn.draftReport && (
                      <button
                        type="button"
                        onClick={() => {
                          onNavigate(turn.navTarget!);
                          onClose();
                        }}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-white border border-slate-300 text-slate-800 text-xs font-medium rounded-md hover:bg-slate-100"
                      >
                        Open {turn.navTarget.toUpperCase()}
                      </button>
                    )}

                    {!authoritySession && turn.shouldTriggerSos && (
                      <button
                        type="button"
                        onClick={() => {
                          onNavigate('shield');
                          onClose();
                        }}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-red-600 text-white text-xs font-medium rounded-md hover:bg-red-700"
                      >
                        <ShieldAlert className="w-3.5 h-3.5" />
                        Open Seva Shield SOS
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}

          {/* Editable Transcription Preview before submission */}
          {editingTranscript && (
            <div className="border border-emerald-700/30 bg-emerald-50/50 rounded-xl p-3.5 space-y-2.5">
              <div className="flex items-center justify-between text-xs font-medium text-green-900">
                <span className="inline-flex items-center gap-1.5">
                  <Edit3 className="w-3.5 h-3.5" />
                  Recognized Speech (Review or Edit Before Sending)
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setEditingTranscript(false);
                    setPendingTranscript('');
                  }}
                  className="text-slate-500 hover:text-slate-800"
                >
                  Discard
                </button>
              </div>
              <textarea
                value={pendingTranscript}
                onChange={(e) => setPendingTranscript(e.target.value)}
                rows={3}
                className="w-full text-sm bg-white border border-slate-200 rounded-lg p-2.5 text-slate-900 focus:outline-none focus:ring-2 focus:ring-green-800"
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => sendMessageToSaathi(pendingTranscript)}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-green-900 text-white text-xs font-medium rounded-lg hover:bg-green-800"
                >
                  <Check className="w-3.5 h-3.5" />
                  Confirm &amp; Send to SEVA SAATHI
                </button>
              </div>
            </div>
          )}

          {errorBanner && (
            <div className="flex items-start gap-2 text-xs text-red-800 bg-red-50 border border-red-200 rounded-lg px-3 py-2.5">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{errorBanner}</span>
            </div>
          )}

          <div ref={chatEndRef} />
        </div>

        {/* Live Waveform & Audio Playback Bar */}
        <div className="px-5 py-3 border-t border-slate-200 bg-slate-50 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs font-medium text-slate-700">
              {phase === 'listening' && 'Listening to your voice...'}
              {phase === 'transcribing' &&
                `Converting speech to text (${activeVoiceProvider === 'elevenlabs' ? 'ElevenLabs Scribe' : 'Gemini Speech'})...`}
              {phase === 'thinking' && 'Processing civic request with SEVA AI...'}
              {phase === 'synthesizing' &&
                `Generating natural speech (${activeVoiceProvider === 'elevenlabs' ? 'ElevenLabs' : 'Gemini Speech'})...`}
              {phase === 'speaking' && (isPaused ? 'Playback paused' : 'Speaking response...')}
              {phase === 'idle' && 'Ready for voice or text'}
            </div>

            {(phase === 'speaking' || activeAudioTurnId) && (
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={togglePauseResumeAudio}
                  className="px-2.5 py-1 text-xs font-medium bg-white border border-slate-200 rounded-md hover:bg-slate-100 inline-flex items-center gap-1"
                >
                  {isPaused ? <Play className="w-3 h-3" /> : <Pause className="w-3 h-3" />}
                  {isPaused ? 'Resume' : 'Pause'}
                </button>
                <button
                  type="button"
                  onClick={stopAudioPlayback}
                  className="px-2.5 py-1 text-xs font-medium bg-white border border-slate-200 rounded-md hover:bg-slate-100 inline-flex items-center gap-1"
                >
                  <Square className="w-3 h-3" />
                  Stop
                </button>
              </div>
            )}
          </div>

          {phase === 'listening' && (
            <canvas
              ref={canvasRef}
              width={440}
              height={44}
              className="w-full h-11 rounded-lg bg-white border border-slate-200"
            />
          )}

          {/* Voice Capture & Text Input */}
          <div className="flex items-center gap-2">
            {phase === 'listening' ? (
              <button
                type="button"
                onClick={stopRecording}
                className="px-4 py-2.5 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 transition-colors inline-flex items-center gap-2 shrink-0"
              >
                <MicOff className="w-4 h-4 animate-pulse" />
                Stop Speaking
              </button>
            ) : (
              <button
                type="button"
                onClick={startRecording}
                disabled={phase !== 'idle' || micPermission === 'unavailable'}
                className="px-4 py-2.5 bg-green-900 text-white text-sm font-medium rounded-lg hover:bg-green-800 disabled:opacity-50 transition-colors inline-flex items-center gap-2 shrink-0"
              >
                <Mic className="w-4 h-4" />
                Start Speaking
              </button>
            )}

            <form
              className="flex-1 flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                sendMessageToSaathi(textInput);
              }}
            >
              <input
                type="text"
                value={textInput}
                onChange={(e) => setTextInput(e.target.value)}
                placeholder="Or type your civic question or report..."
                className="flex-1 text-sm bg-white border border-slate-200 rounded-lg px-3 py-2.5 text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-green-800"
              />
              <button
                type="submit"
                disabled={!textInput.trim() || phase === 'thinking'}
                aria-label="Send message"
                className="p-2.5 bg-slate-900 text-white rounded-lg hover:bg-slate-800 disabled:opacity-40 transition-colors shrink-0"
              >
                <Send className="w-4 h-4" />
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
};
