import React, { useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
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
import { EmergencyContact, SmsLogEntry, SosEvent } from '../types/seva';

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

  const [contacts, setContacts] = useState<EmergencyContact[]>([]);
  const [sosHistory, setSosHistory] = useState<SosEvent[]>([]);

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
  const [latestSmsLogs, setLatestSmsLogs] = useState<SmsLogEntry[]>([]);

  // Opt-in Voice Protection ("Help me" / "Bachao")
  const [voiceGuardEnabled, setVoiceGuardEnabled] = useState(false);
  const [voiceGuardStatus, setVoiceGuardStatus] = useState<string>('Off');

  const holdTimerRef = useRef<number | null>(null);
  const countdownTimerRef = useRef<number | null>(null);
  const recognitionRef = useRef<any>(null);

  // Load user's contacts and SOS history
  useEffect(() => {
    if (!firebaseUser) {
      setContacts([]);
      setSosHistory([]);
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

    return () => {
      unsubContacts();
      unsubSos();
    };
  }, [firebaseUser]);

  const executeSosActivation = async (triggerMethod: 'button_hold' | 'voice_phrase') => {
    if (!firebaseUser) {
      setSosStatusMsg('Please sign in first to record and dispatch an SOS event.');
      return;
    }

    const loc = lat !== null && lng !== null ? { lat, lng, address } : await requestCurrentLocation();
    const finalLat = loc?.lat ?? 0;
    const finalLng = loc?.lng ?? 0;
    const finalAddr = loc?.address || 'GPS location unavailable (permission pending or denied)';

    const shareToken = await startLiveTracking(true);
    const sosId = `sos_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const consentedContacts = contacts.filter((c) => c.consentGiven);
    const baseDeliverySummary = `Recorded active SOS · ${consentedContacts.length} trusted contact(s) registered · Control Room portal alerted via WebSocket${
      shareToken ? ' · Live GPS link active' : ''
    }.`.slice(0, 290);

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
        deliverySummary: baseDeliverySummary,
        trackingSessionId: shareToken || '',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      const syncRes = await fetch('/api/sos/sync', {
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
          deliverySummary: baseDeliverySummary,
          trackingShareToken: shareToken || undefined,
          contacts: consentedContacts.map((c) => ({ name: c.name, phone: c.phone })),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      });
      const syncData = await syncRes.json().catch(() => ({}));
      const smsSummary = syncData?.sos?.smsSummary || '';
      const logs = Array.isArray(syncData?.sos?.smsLogs) ? syncData.sos.smsLogs : [];
      setLatestSmsLogs(logs);
      setSosStatusMsg(smsSummary ? `${baseDeliverySummary} ${smsSummary}` : baseDeliverySummary);
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
          skipSms: true,
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

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="inline-flex items-center gap-1.5 text-xs font-semibold text-red-700 mb-1">
            <ShieldAlert className="w-4 h-4" />
            Dedicated Personal Safety &amp; SOS Module
          </div>
          <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900">
            Seva Shield SOS &amp; Women Safety
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            2-second hold SOS trigger, 5-second cancellation window, opt-in distress voice phrase guard, trusted contacts, and real-time caregiver SMS dispatch. (Medical Assistance &amp; Road Accident Help are separate dedicated sections.)
          </p>
        </div>

        <button
          type="button"
          onClick={() =>
            onSpeakText(
              'Seva Shield Safety Guide: Press and hold the red SOS button for two seconds to start a five second countdown. You can cancel anytime during the countdown. Once safe, tap I am Safe to stop live location sharing. Call 112 for immediate police or national emergency response, or 1091 for Women Helpline.'
            )
          }
          className="inline-flex items-center gap-2 px-4 py-2 bg-slate-900 text-white text-xs font-medium rounded-lg hover:bg-slate-800 whitespace-nowrap"
        >
          <Volume2 className="w-4 h-4" />
          Hear Voice Safety Guide
        </button>
      </div>

      {/* Direct Telephone Helplines */}
      <div className="border border-red-200 bg-red-50 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="text-xs text-red-950">
          <strong>Immediate Personal Safety Helplines:</strong> Tapping initiates a direct call from your device&apos;s phone dialer.
        </div>
        <div className="flex flex-wrap gap-2">
          <a
            href="tel:112"
            className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-red-600 text-white text-xs font-semibold rounded-lg hover:bg-red-700"
          >
            <Phone className="w-3.5 h-3.5" />
            Call 112 (Emergency / Police)
          </a>
          <a
            href="tel:1091"
            className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-slate-900 text-white text-xs font-semibold rounded-lg hover:bg-slate-800"
          >
            <Phone className="w-3.5 h-3.5" />
            Call 1091 (Women Helpline)
          </a>
        </div>
      </div>

      {!firebaseUser && (
        <div className="border border-amber-200 bg-amber-50 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-amber-950">
            Sign in with Google to save trusted contacts and trigger tracked SOS workflows. Direct 112 / 1091 dialing always works without sign-in.
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
                Press and hold for 2 seconds to start a 5-second cancellable SOS countdown. Captures live GPS, notifies trusted caregivers via SMS gateway, and alerts the Control Room.
              </p>
            </>
          )}

          {sosStatusMsg && (
            <div className="w-full text-left text-xs text-slate-800 bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-1.5">
              <div className="flex items-center gap-1.5 font-semibold text-slate-900">
                <CheckCircle2 className="w-3.5 h-3.5 text-green-900" />
                SOS Dispatch Status
              </div>
              <p>{sosStatusMsg}</p>
              {latestSmsLogs.length > 0 && (
                <div className="pt-1.5 border-t border-slate-200 space-y-1">
                  {latestSmsLogs.map((l) => (
                    <div key={l.id} className="text-[11px] text-slate-700">
                      {l.recipientName} ({l.recipientPhone}):{' '}
                      <span className="font-mono font-semibold uppercase">{l.status}</span>
                      {l.error ? ` — ${l.error}` : ''}
                    </div>
                  ))}
                </div>
              )}
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
              Trusted Caregiver Contacts ({contacts.length}/5)
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
            Consent to send SMS &amp; live GPS tracking link to these trusted contacts during SOS, Medical, or Accident emergencies.
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
                {sosHistory.slice(0, 4).map((s) => (
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
    </div>
  );
};
