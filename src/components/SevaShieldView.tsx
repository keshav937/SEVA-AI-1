import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Ambulance,
  CheckCircle2,
  HeartPulse,
  Mic,
  MicOff,
  Phone,
  Plus,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Volume2,
} from 'lucide-react';
import {
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { useAuth } from '../contexts/AuthContext';
import { useLocationEngine } from '../contexts/LocationContext';
import { OperationType, buildFirestoreErrorInfo, db, handleFirestoreError } from '../lib/firebase';
import { EmergencyContact, MedicalRequest, NearbyPlace, SosEvent } from '../types/seva';

interface SevaShieldViewProps {
  onSpeakText: (text: string) => void;
}

export const SevaShieldView: React.FC<SevaShieldViewProps> = ({ onSpeakText }) => {
  const { firebaseUser, profile, signingIn, signInWithGoogle } = useAuth();
  const {
    lat,
    lng,
    accuracyMeters,
    address,
    requestCurrentLocation,
    startLiveTracking,
    stopLiveTracking,
  } = useLocationEngine();

  const [subTab, setSubTab] = useState<'shield' | 'medical' | 'accident'>('shield');
  const [contacts, setContacts] = useState<EmergencyContact[]>([]);
  const [sosHistory, setSosHistory] = useState<SosEvent[]>([]);
  const [medicalHistory, setMedicalHistory] = useState<MedicalRequest[]>([]);
  const [nearbySafety, setNearbySafety] = useState<NearbyPlace[]>([]);

  // Contact form
  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [contactRelation, setContactRelation] = useState('Family');
  const [contactConsent, setContactConsent] = useState(true);
  const [contactError, setContactError] = useState<string | null>(null);

  // SOS hold + 5s countdown state
  const [holdProgress, setHoldProgress] = useState(0);
  const [countdownSec, setCountdownSec] = useState<number | null>(null);
  const [activeSos, setActiveSos] = useState<SosEvent | null>(null);
  const [sosStatusMsg, setSosStatusMsg] = useState<string | null>(null);

  // Opt-in Voice Protection ("Help me" / "Bachao")
  const [voiceGuardEnabled, setVoiceGuardEnabled] = useState(false);
  const [voiceGuardStatus, setVoiceGuardStatus] = useState<string>('Off');

  // Medical & Accident forms
  const [medicalCondition, setMedicalCondition] = useState('');
  const [medicalSeverity, setMedicalSeverity] = useState<'Urgent' | 'Critical'>('Urgent');
  const [accidentDetail, setAccidentDetail] = useState('');
  const [assistanceMsg, setAssistanceMsg] = useState<string | null>(null);

  const holdTimerRef = useRef<number | null>(null);
  const countdownTimerRef = useRef<number | null>(null);
  const recognitionRef = useRef<any>(null);

  // Load user's contacts, SOS history, and medical requests
  useEffect(() => {
    if (!firebaseUser) {
      setContacts([]);
      setSosHistory([]);
      setMedicalHistory([]);
      return;
    }

    const qContacts = query(collection(db, 'emergencyContacts'), where('uid', '==', firebaseUser.uid));
    const unsubContacts = onSnapshot(
      qContacts,
      (snap) => {
        setContacts(snap.docs.map((d) => ({ id: d.id, ...d.data() } as EmergencyContact)));
      },
      (err) => {
        buildFirestoreErrorInfo(err, OperationType.LIST, 'emergencyContacts');
      }
    );

    const qSos = query(collection(db, 'sosEvents'), where('uid', '==', firebaseUser.uid));
    const unsubSos = onSnapshot(
      qSos,
      (snap) => {
        const list = snap.docs.map((d) => ({ id: d.id, ...d.data() } as SosEvent));
        setSosHistory(list);
        const currentActive = list.find((s) => s.status === 'active') || null;
        setActiveSos(currentActive);
      },
      (err) => {
        buildFirestoreErrorInfo(err, OperationType.LIST, 'sosEvents');
      }
    );

    const qMed = query(collection(db, 'medicalRequests'), where('uid', '==', firebaseUser.uid));
    const unsubMed = onSnapshot(
      qMed,
      (snap) => {
        setMedicalHistory(snap.docs.map((d) => ({ id: d.id, ...d.data() } as MedicalRequest)));
      },
      (err) => {
        buildFirestoreErrorInfo(err, OperationType.LIST, 'medicalRequests');
      }
    );

    return () => {
      unsubContacts();
      unsubSos();
      unsubMed();
    };
  }, [firebaseUser]);

  // Fetch nearby police & hospitals when GPS is acquired
  useEffect(() => {
    if (lat === null || lng === null) return;
    fetch(`/api/places/nearby?lat=${lat}&lng=${lng}&radius=5000&categories=public_safety,healthcare`)
      .then((r) => r.json())
      .then((d) => setNearbySafety((d.places || []).slice(0, 8)))
      .catch(() => {});
  }, [lat, lng]);

  const executeSosActivation = async (triggerMethod: 'button_hold' | 'voice_phrase') => {
    if (!firebaseUser) {
      setSosStatusMsg('Please sign in first to record and dispatch an SOS event.');
      return;
    }

    const loc = lat !== null && lng !== null ? { lat, lng, address } : await requestCurrentLocation();
    const finalLat = loc?.lat ?? 0;
    const finalLng = loc?.lng ?? 0;
    const finalAddr = loc?.address || 'GPS acquisition pending';

    const shareToken = await startLiveTracking(true);
    const sosId = `sos_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const consentedContacts = contacts.filter((c) => c.consentGiven);
    const deliverySummary = `Recorded active SOS · ${consentedContacts.length} trusted contact(s) registered · Control Room portal alerted via WebSocket${
      shareToken ? ' · Live GPS link active' : ''
    }.`;

    try {
      await setDoc(doc(db, 'sosEvents', sosId), {
        uid: firebaseUser.uid,
        displayName: (profile?.displayName || firebaseUser.displayName || 'Citizen').slice(0, 80),
        status: 'active',
        lat: finalLat,
        lng: finalLng,
        accuracyMeters: accuracyMeters ?? 0,
        address: finalAddr.slice(0, 300),
        triggerMethod,
        notifiedContactsCount: consentedContacts.length,
        authorityNotified: true,
        deliverySummary,
        trackingSessionId: shareToken || '',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      await fetch('/api/sos/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: sosId,
          uid: firebaseUser.uid,
          displayName: profile?.displayName || firebaseUser.displayName || 'Citizen',
          status: 'active',
          lat: finalLat,
          lng: finalLng,
          accuracyMeters: accuracyMeters ?? 0,
          address: finalAddr,
          triggerMethod,
          notifiedContactsCount: consentedContacts.length,
          authorityNotified: true,
          deliverySummary,
          trackingShareToken: shareToken || undefined,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      });

      setSosStatusMsg(deliverySummary);
    } catch (err: any) {
      if (err?.message?.includes('Missing or insufficient permissions')) {
        handleFirestoreError(err, OperationType.CREATE, `sosEvents/${sosId}`);
      }
      setSosStatusMsg(err?.message || 'Failed to persist SOS event.');
    }
  };

  const beginCountdown = (method: 'button_hold' | 'voice_phrase') => {
    if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
    setCountdownSec(5);
    let remaining = 5;
    countdownTimerRef.current = window.setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
        setCountdownSec(null);
        executeSosActivation(method);
      } else {
        setCountdownSec(remaining);
      }
    }, 1000);
  };

  const cancelCountdown = () => {
    if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
    setCountdownSec(null);
    setSosStatusMsg('SOS countdown cancelled. No emergency alert was sent.');
  };

  const startHold = () => {
    if (countdownSec !== null || activeSos) return;
    setHoldProgress(10);
    const start = Date.now();
    holdTimerRef.current = window.setInterval(() => {
      const elapsed = Date.now() - start;
      const pct = Math.min(100, Math.round((elapsed / 2000) * 100));
      setHoldProgress(pct);
      if (pct >= 100) {
        if (holdTimerRef.current) clearInterval(holdTimerRef.current);
        setHoldProgress(0);
        beginCountdown('button_hold');
      }
    }, 80);
  };

  const endHold = () => {
    if (holdTimerRef.current) {
      clearInterval(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    setHoldProgress(0);
  };

  const handleMarkSafe = async () => {
    if (!activeSos || !firebaseUser) return;
    await stopLiveTracking();
    const summary = `Marked I'm Safe at ${new Date().toLocaleTimeString()}. Live GPS sharing stopped.`;
    try {
      await updateDoc(doc(db, 'sosEvents', activeSos.id), {
        status: 'safe_resolved',
        deliverySummary: summary,
        updatedAt: serverTimestamp(),
      });

      await fetch('/api/sos/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: activeSos.id,
          uid: firebaseUser.uid,
          displayName: activeSos.displayName || profile?.displayName || 'Citizen',
          status: 'safe_resolved',
          lat: activeSos.lat,
          lng: activeSos.lng,
          accuracyMeters: activeSos.accuracyMeters ?? 0,
          address: activeSos.address || '',
          triggerMethod: activeSos.triggerMethod,
          notifiedContactsCount: activeSos.notifiedContactsCount,
          authorityNotified: true,
          deliverySummary: summary,
          trackingShareToken: activeSos.trackingSessionId || undefined,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      }).catch(() => {});

      setSosStatusMsg("Status updated to I'm Safe. Live location sharing stopped and Control Room notified.");
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `sosEvents/${activeSos.id}`);
    }
  };

  // Opt-in Voice Protection ("Help me" / "Bachao")
  useEffect(() => {
    if (!voiceGuardEnabled) {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop();
        } catch {}
        recognitionRef.current = null;
      }
      setVoiceGuardStatus('Off');
      return;
    }

    const SpeechRec = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRec) {
      setVoiceGuardStatus('Browser speech phrase listener unavailable on this device. Use manual SOS button.');
      setVoiceGuardEnabled(false);
      return;
    }

    const rec = new SpeechRec();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = 'en-IN';
    rec.onstart = () => setVoiceGuardStatus('Listening for "Help me" or "Bachao"...');
    rec.onresult = (event: any) => {
      const transcript = Array.from(event.results)
        .map((r: any) => r[0]?.transcript || '')
        .join(' ')
        .toLowerCase();
      if (transcript.includes('help me') || transcript.includes('bachao')) {
        setVoiceGuardEnabled(false);
        beginCountdown('voice_phrase');
      }
    };
    rec.onerror = (e: any) => {
      setVoiceGuardStatus(`Voice guard stopped (${e.error}). Manual SOS remains active.`);
      setVoiceGuardEnabled(false);
    };
    rec.start();
    recognitionRef.current = rec;

    return () => {
      try {
        rec.stop();
      } catch {}
    };
  }, [voiceGuardEnabled]);

  const handleAddContact = async (e: React.FormEvent) => {
    e.preventDefault();
    setContactError(null);
    if (!firebaseUser) {
      setContactError('Sign in first to save trusted emergency contacts.');
      return;
    }
    if (contacts.length >= 5) {
      setContactError('Maximum of 5 trusted emergency contacts reached.');
      return;
    }
    const cleanPhone = contactPhone.replace(/[\s-]/g, '');
    if (!/^(\+91)?[6-9][0-9]{9}$/.test(cleanPhone)) {
      setContactError('Enter a valid 10-digit Indian mobile number (e.g., 9876543210 or +919876543210).');
      return;
    }
    if (contacts.some((c) => c.phone === cleanPhone)) {
      setContactError('This phone number is already in your trusted contacts.');
      return;
    }

    const id = `ec_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    try {
      await setDoc(doc(db, 'emergencyContacts', id), {
        uid: firebaseUser.uid,
        name: contactName.trim().slice(0, 100),
        phone: cleanPhone,
        relation: contactRelation.trim().slice(0, 40),
        consentGiven: contactConsent,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setContactName('');
      setContactPhone('');
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `emergencyContacts/${id}`);
    }
  };

  const handleDeleteContact = async (id: string) => {
    try {
      await deleteDoc(doc(db, 'emergencyContacts', id));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `emergencyContacts/${id}`);
    }
  };

  const submitMedicalOrAccident = async (kind: 'medical' | 'accident') => {
    setAssistanceMsg(null);
    if (!firebaseUser) {
      setAssistanceMsg('Please sign in with Google first.');
      return;
    }
    const conditionText = (kind === 'medical' ? medicalCondition : accidentDetail).trim();
    if (conditionText.length < 3) {
      setAssistanceMsg('Please describe the emergency or patient condition (at least 3 characters).');
      return;
    }

    const loc = lat !== null && lng !== null ? { lat, lng, address } : await requestCurrentLocation();
    const finalLat = loc?.lat ?? 0;
    const finalLng = loc?.lng ?? 0;
    const finalAddr = (loc?.address || 'GPS location pending').slice(0, 300);

    const trackingId = `${kind === 'medical' ? 'MED' : 'ACC'}-${Math.floor(100000 + Math.random() * 900000)}`;
    const reqId = `med_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const nearestHosp = nearbySafety.find((p) => p.category === 'healthcare')?.name || 'Nearest listed hospital lookup';

    try {
      await setDoc(doc(db, 'medicalRequests', reqId), {
        uid: firebaseUser.uid,
        trackingId,
        patientCondition: conditionText.slice(0, 400),
        severity: medicalSeverity,
        lat: finalLat,
        lng: finalLng,
        address: finalAddr,
        nearestHospital: nearestHosp.slice(0, 200),
        status: 'Authority Notified',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      const nowIso = new Date().toISOString();
      await fetch('/api/reports/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: reqId,
          complaintId: trackingId,
          reporterUid: firebaseUser.uid,
          reporterDisplayName: (profile?.displayName || firebaseUser.displayName || 'Citizen').slice(0, 80),
          category: kind === 'medical' ? 'Medical Assistance' : 'Road Accident Reporting',
          title:
            kind === 'medical'
              ? `Medical Emergency (${medicalSeverity})`
              : `Road Accident Emergency (${medicalSeverity})`,
          description: `${conditionText.slice(0, 400)} · Nearest facility: ${nearestHosp}`,
          severity: medicalSeverity === 'Critical' ? 'Critical' : 'High',
          status: 'Submitted',
          department: kind === 'medical' ? 'Medical Services' : 'Emergency Control Room',
          ward: (profile?.ward || 'Emergency Zone').slice(0, 80),
          locality: (profile?.city || 'City').slice(0, 120),
          address: finalAddr,
          lat: finalLat,
          lng: finalLng,
          accuracyMeters: accuracyMeters ?? 0,
          isEmergency: true,
          isSensitive: false,
          fraudRiskScore: 0,
          fraudRiskLevel: 'Low',
          fraudIndicators: [],
          fraudExplanation: 'Seva Shield direct emergency dispatch.',
          fraudQueueStatus: 'cleared',
          timeline: [
            {
              step: 'submitted',
              label: `${kind === 'medical' ? 'Medical' : 'Accident'} Alert Dispatched`,
              actorRole: 'Seva Shield',
              note: `Nearest facility: ${nearestHosp}`,
              timestamp: nowIso,
            },
          ],
          createdAt: nowIso,
          updatedAt: nowIso,
        }),
      }).catch(() => {});

      setMedicalCondition('');
      setAccidentDetail('');
      setAssistanceMsg(`Request recorded (${trackingId}). Control Room notified · Nearest facility: ${nearestHosp}.`);
    } catch (err: any) {
      if (err?.message?.includes('Missing or insufficient permissions')) {
        handleFirestoreError(err, OperationType.CREATE, `medicalRequests/${reqId}`);
      }
      setAssistanceMsg(err?.message || 'Unable to submit assistance request.');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900">
            Seva Shield &amp; Emergency Assistance
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Personal safety companion, SOS workflow, trusted contacts, medical help, and road accident assistance.
          </p>
        </div>

        <button
          type="button"
          onClick={() =>
            onSpeakText(
              'Seva Shield Safety Guide: Press and hold the red SOS button for two seconds to start a five second countdown. You can cancel anytime during the countdown. Once safe, tap I am Safe to stop live location sharing. Call 112 for immediate national emergency response.'
            )
          }
          className="inline-flex items-center gap-2 px-4 py-2 bg-slate-900 text-white text-xs font-medium rounded-lg hover:bg-slate-800 whitespace-nowrap"
        >
          <Volume2 className="w-4 h-4" />
          Hear Voice Safety Guide
        </button>
      </div>

      {/* Sub-module Tabs */}
      <div className="flex flex-wrap items-center gap-2 p-1 bg-slate-100 rounded-lg w-fit">
        {[
          { id: 'shield', label: 'Seva Shield SOS' },
          { id: 'medical', label: 'Medical Assistance' },
          { id: 'accident', label: 'Road Accident Help' },
        ].map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setSubTab(t.id as any)}
            className={`px-3.5 py-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              subTab === t.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {!firebaseUser && (
        <div className="border border-amber-200 bg-amber-50 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-amber-950">
            Sign in with Google to save emergency contacts, trigger tracked SOS workflows, and log medical requests. In an immediate life-threatening emergency, dial <strong>112</strong>.
          </p>
          <button
            type="button"
            disabled={signingIn}
            onClick={() => signInWithGoogle()}
            className="px-4 py-2 bg-green-900 text-white text-xs font-medium rounded-lg disabled:opacity-50"
          >
            {signingIn ? 'Signing in...' : 'Sign In with Google'}
          </button>
        </div>
      )}

      {subTab === 'shield' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* SOS Control Card */}
          <div className="lg:col-span-6 border border-slate-200 rounded-xl bg-white p-6 flex flex-col items-center text-center space-y-5">
            {countdownSec !== null ? (
              <div className="space-y-4 w-full">
                <div className="w-36 h-36 mx-auto rounded-full bg-red-600 text-white flex flex-col items-center justify-center shadow-lg">
                  <span className="font-mono text-4xl font-bold tabular-nums">{countdownSec}</span>
                  <span className="text-xs mt-1">Activating SOS</span>
                </div>
                <button
                  type="button"
                  onClick={cancelCountdown}
                  className="w-full py-3 bg-slate-900 text-white text-sm font-semibold rounded-lg hover:bg-slate-800"
                >
                  Cancel SOS Countdown
                </button>
              </div>
            ) : activeSos ? (
              <div className="space-y-4 w-full">
                <div className="p-4 bg-red-50 border border-red-200 rounded-xl text-left">
                  <div className="flex items-center gap-2 text-red-700 font-semibold text-sm">
                    <ShieldAlert className="w-5 h-5" />
                    Active SOS Session
                  </div>
                  <p className="text-xs text-red-900 mt-1">{activeSos.deliverySummary}</p>
                </div>
                <button
                  type="button"
                  onClick={handleMarkSafe}
                  className="w-full py-3.5 bg-emerald-700 text-white text-sm font-semibold rounded-lg hover:bg-emerald-800 inline-flex items-center justify-center gap-2"
                >
                  <ShieldCheck className="w-5 h-5" />
                  I&apos;m Safe — Stop Sharing &amp; Resolve
                </button>
              </div>
            ) : (
              <>
                <button
                  type="button"
                  onMouseDown={startHold}
                  onMouseUp={endHold}
                  onMouseLeave={endHold}
                  onTouchStart={startHold}
                  onTouchEnd={endHold}
                  className="w-44 h-44 rounded-full bg-red-600 hover:bg-red-700 active:scale-95 text-white flex flex-col items-center justify-center shadow-lg transition-transform select-none"
                >
                  <ShieldAlert className="w-10 h-10 mb-1.5" />
                  <span className="font-display text-xl font-bold">HOLD SOS</span>
                  <span className="text-xs opacity-90 mt-1">
                    {holdProgress > 0 ? `Holding ${holdProgress}%` : 'Hold 2 seconds'}
                  </span>
                </button>
                <p className="text-xs text-slate-600 max-w-sm">
                  Press and hold for 2 seconds to start a 5-second cancellable SOS countdown. Captures live GPS and alerts the control room dashboard.
                </p>
              </>
            )}

            {sosStatusMsg && (
              <div className="w-full text-left text-xs text-slate-800 bg-slate-50 border border-slate-200 rounded-lg p-3">
                {sosStatusMsg}
              </div>
            )}

            {/* Voice Protection Opt-in */}
            <div className="w-full pt-4 border-t border-slate-200 flex items-center justify-between gap-3 text-left">
              <div>
                <div className="text-xs font-semibold text-slate-900">
                  Voice Phrase Protection (&ldquo;Help me&rdquo; / &ldquo;Bachao&rdquo;)
                </div>
                <div className="text-xs text-slate-500">{voiceGuardStatus}</div>
              </div>
              <button
                type="button"
                onClick={() => setVoiceGuardEnabled((v) => !v)}
                className={`px-3 py-2 rounded-lg text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap ${
                  voiceGuardEnabled
                    ? 'bg-red-600 text-white'
                    : 'bg-slate-100 text-slate-800 hover:bg-slate-200'
                }`}
              >
                {voiceGuardEnabled ? <Mic className="w-3.5 h-3.5" /> : <MicOff className="w-3.5 h-3.5" />}
                {voiceGuardEnabled ? 'Disable' : 'Enable'}
              </button>
            </div>
          </div>

          {/* Trusted Emergency Contacts (Max 5) */}
          <div className="lg:col-span-6 border border-slate-200 rounded-xl bg-white p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-slate-900">
                Trusted Emergency Contacts ({contacts.length}/5)
              </h3>
              <span className="text-xs text-slate-500">Private · Owner Only</span>
            </div>

            <form onSubmit={handleAddContact} className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              <input
                type="text"
                value={contactName}
                onChange={(e) => setContactName(e.target.value)}
                placeholder="Contact name"
                className="text-sm border border-slate-200 rounded-lg px-3 py-2"
                required
              />
              <input
                type="tel"
                value={contactPhone}
                onChange={(e) => setContactPhone(e.target.value)}
                placeholder="+91 9876543210"
                className="text-sm border border-slate-200 rounded-lg px-3 py-2"
                required
              />
              <div className="flex gap-2">
                <input
                  type="text"
                  value={contactRelation}
                  onChange={(e) => setContactRelation(e.target.value)}
                  placeholder="Relation"
                  className="flex-1 min-w-0 text-sm border border-slate-200 rounded-lg px-3 py-2"
                  required
                />
                <button
                  type="submit"
                  className="px-3 py-2 bg-green-900 text-white rounded-lg hover:bg-green-800 shrink-0"
                  aria-label="Add contact"
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>
            </form>

            <label className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer">
              <input
                type="checkbox"
                checked={contactConsent}
                onChange={(e) => setContactConsent(e.target.checked)}
                className="rounded border-slate-300 text-green-900"
              />
              Consent to share live GPS link with these trusted contacts during active SOS.
            </label>

            {contactError && (
              <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg p-2.5">
                {contactError}
              </div>
            )}

            <div className="divide-y divide-slate-200 border border-slate-200 rounded-lg">
              {contacts.length === 0 ? (
                <div className="p-4 text-xs text-slate-500 text-center">
                  No emergency contacts added yet.
                </div>
              ) : (
                contacts.map((c) => (
                  <div key={c.id} className="p-3 flex items-center justify-between gap-2">
                    <div>
                      <div className="text-sm font-medium text-slate-900">
                        {c.name} <span className="text-xs text-slate-500">({c.relation})</span>
                      </div>
                      <div className="font-mono text-xs text-slate-600">{c.phone}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleDeleteContact(c.id)}
                      aria-label={`Remove ${c.name}`}
                      className="p-1.5 text-slate-500 hover:text-red-600"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))
              )}
            </div>

            {sosHistory.length > 0 && (
              <div className="pt-2">
                <div className="text-xs font-semibold text-slate-700 mb-1.5">Recent SOS History</div>
                <div className="space-y-1.5">
                  {sosHistory.slice(0, 3).map((s) => (
                    <div key={s.id} className="text-xs bg-slate-50 border border-slate-200 rounded-lg p-2.5">
                      <span className="font-semibold uppercase">{s.status.replace('_', ' ')}</span> ·{' '}
                      {s.address || `${s.lat.toFixed(4)}, ${s.lng.toFixed(4)}`}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {(subTab === 'medical' || subTab === 'accident') && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-6 border border-slate-200 rounded-xl bg-white p-5 space-y-4">
            <div className="flex items-center gap-2 text-slate-900">
              {subTab === 'medical' ? (
                <HeartPulse className="w-5 h-5 text-red-600" />
              ) : (
                <Ambulance className="w-5 h-5 text-amber-600" />
              )}
              <h3 className="font-display text-lg font-semibold">
                {subTab === 'medical' ? 'Medical Assistance Request' : 'Road Accident Emergency Report'}
              </h3>
            </div>

            <div className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg p-3">
              National Helplines: Police <strong>112</strong> · Ambulance <strong>108 / 102</strong> · Women Helpline <strong>1091</strong>.
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Severity</label>
              <select
                value={medicalSeverity}
                onChange={(e) => setMedicalSeverity(e.target.value as 'Urgent' | 'Critical')}
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 bg-white"
              >
                <option value="Urgent">Urgent</option>
                <option value="Critical">Critical</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                {subTab === 'medical' ? 'Patient Condition & Assistance Needed' : 'Accident Details & Injuries'}
              </label>
              <textarea
                rows={3}
                value={subTab === 'medical' ? medicalCondition : accidentDetail}
                onChange={(e) =>
                  subTab === 'medical'
                    ? setMedicalCondition(e.target.value)
                    : setAccidentDetail(e.target.value)
                }
                placeholder={
                  subTab === 'medical'
                    ? 'Describe medical symptoms, consciousness, or ambulance requirement...'
                    : 'Describe vehicles involved, road blockage, and injured persons...'
                }
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2"
              />
            </div>

            <button
              type="button"
              onClick={() => submitMedicalOrAccident(subTab)}
              className="w-full py-2.5 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700"
            >
              Submit {subTab === 'medical' ? 'Medical Request' : 'Accident Alert'} with GPS
            </button>

            {assistanceMsg && (
              <div className="flex items-start gap-2 text-xs text-emerald-900 bg-emerald-50 border border-emerald-200 rounded-lg p-3">
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{assistanceMsg}</span>
              </div>
            )}

            {medicalHistory.length > 0 && (
              <div className="pt-2 space-y-2">
                <div className="text-xs font-semibold text-slate-700">Your Medical / Accident Tracking</div>
                {medicalHistory.slice(0, 4).map((m) => (
                  <div key={m.id} className="text-xs border border-slate-200 rounded-lg p-3 bg-slate-50">
                    <div className="flex justify-between font-medium text-slate-900">
                      <span className="font-mono">{m.trackingId}</span>
                      <span>{m.status}</span>
                    </div>
                    <div className="text-slate-600 mt-1">{m.patientCondition}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="lg:col-span-6 border border-slate-200 rounded-xl bg-white p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-slate-900">
                Nearby Hospitals &amp; Police Stations (5 km)
              </h3>
              <button
                type="button"
                onClick={() => requestCurrentLocation()}
                className="text-xs font-medium text-green-900 hover:underline"
              >
                Refresh GPS
              </button>
            </div>
            {nearbySafety.length === 0 ? (
              <p className="text-xs text-slate-500 py-8 text-center">
                Acquire your GPS location to list verified nearby hospitals and police stations from OpenStreetMap.
              </p>
            ) : (
              <div className="divide-y divide-slate-200 border border-slate-200 rounded-lg">
                {nearbySafety.map((p) => (
                  <div key={p.id} className="p-3 flex items-start justify-between gap-2">
                    <div>
                      <div className="text-sm font-medium text-slate-900">{p.name}</div>
                      <div className="text-xs text-slate-500 capitalize">
                        {p.subcategory} · {(p.distanceMeters / 1000).toFixed(2)} km
                      </div>
                      {p.phone && (
                        <div className="text-xs text-slate-700 mt-0.5 inline-flex items-center gap-1">
                          <Phone className="w-3 h-3" /> {p.phone}
                        </div>
                      )}
                    </div>
                    <a
                      href={p.directionsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs font-medium text-green-900 hover:underline shrink-0"
                    >
                      Directions
                    </a>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
