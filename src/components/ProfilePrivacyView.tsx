import React, { useEffect, useState } from 'react';
import { Bell, CheckCircle2, Lock, LogOut, ShieldCheck } from 'lucide-react';
import {
  collection,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { useAuth } from '../contexts/AuthContext';
import { OperationType, buildFirestoreErrorInfo, db } from '../lib/firebase';
import { UserNotification } from '../types/seva';
import { LiveTrackingPanel } from './LiveTrackingPanel';

export const ProfilePrivacyView: React.FC = () => {
  const { firebaseUser, profile, signingIn, signInWithGoogle, logout, updateCitizenProfile } = useAuth();

  const [fullName, setFullName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [phone, setPhone] = useState('');
  const [city, setCity] = useState('');
  const [ward, setWard] = useState('');
  const [dpdpConsent, setDpdpConsent] = useState(true);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<UserNotification[]>([]);

  useEffect(() => {
    if (!profile) return;
    setFullName(profile.fullName || '');
    setDisplayName(profile.displayName || '');
    setPhone(profile.phone || '');
    setCity(profile.city || 'New Delhi');
    setWard(profile.ward || 'Central Ward');
    setDpdpConsent(profile.dpdpConsent ?? true);
  }, [profile]);

  useEffect(() => {
    if (!firebaseUser) {
      setNotifications([]);
      return;
    }
    const q = query(collection(db, 'notifications'), where('uid', '==', firebaseUser.uid));
    return onSnapshot(
      q,
      (snap) => {
        setNotifications(snap.docs.map((d) => ({ id: d.id, ...d.data() } as UserNotification)));
      },
      (err) => {
        buildFirestoreErrorInfo(err, OperationType.LIST, 'notifications');
      }
    );
  }, [firebaseUser]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaveMsg(null);
    setSaveError(null);
    if (!firebaseUser) return;
    try {
      await updateCitizenProfile({ fullName, displayName, phone, city, ward, dpdpConsent });
      const cId = `con_${Date.now()}`;
      await setDoc(doc(db, 'consentRecords', cId), {
        uid: firebaseUser.uid,
        consentType: 'dpdp_account',
        granted: dpdpConsent,
        purpose: 'Civic issue reporting, GPS location sensing, and Seva Samman portfolio.',
        createdAt: serverTimestamp(),
      });
      setSaveMsg('Profile & DPDP consent preferences saved.');
    } catch (err: any) {
      setSaveError(err?.message || 'Unable to save profile preferences.');
    }
  };

  const markRead = async (id: string) => {
    try {
      await updateDoc(doc(db, 'notifications', id), { read: true });
    } catch (err) {
      buildFirestoreErrorInfo(err, OperationType.UPDATE, `notifications/${id}`);
    }
  };

  if (!firebaseUser) {
    return (
      <div className="border border-slate-200 rounded-xl bg-slate-50 p-8 text-center space-y-4">
        <h2 className="font-display text-xl font-semibold text-slate-900">
          Citizen Profile &amp; DPDP Privacy Hub
        </h2>
        <p className="text-sm text-slate-600 max-w-md mx-auto">
          Sign in with Google to manage your civic profile, privacy-preserving leaderboard name, notifications, and DPDP data consents.
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
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900">
            Profile, Privacy &amp; Notifications
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Signed in as {firebaseUser.email}
          </p>
        </div>
        <button
          type="button"
          onClick={() => logout()}
          className="inline-flex items-center gap-2 px-4 py-2 border border-slate-200 text-slate-800 text-xs font-medium rounded-lg hover:bg-slate-50"
        >
          <LogOut className="w-4 h-4" />
          Sign Out
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <form onSubmit={handleSave} className="lg:col-span-6 border border-slate-200 rounded-xl bg-white p-5 space-y-4">
          <div className="flex items-center gap-2 text-slate-900 font-display text-base font-semibold">
            <ShieldCheck className="w-5 h-5 text-green-900" />
            Account &amp; DPDP Consent Settings
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Full Name</label>
              <input
                type="text"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Public Leaderboard Alias
              </label>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2"
                required
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Mobile (Private)</label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+91..."
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">City</label>
              <input
                type="text"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Ward</label>
              <input
                type="text"
                value={ward}
                onChange={(e) => setWard(e.target.value)}
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2"
              />
            </div>
          </div>

          <label className="flex items-start gap-2.5 text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded-lg p-3 cursor-pointer">
            <input
              type="checkbox"
              checked={dpdpConsent}
              onChange={(e) => setDpdpConsent(e.target.checked)}
              className="mt-0.5 rounded border-slate-300 text-green-900"
            />
            <span>
              <strong>DPDP Act Consent:</strong> I consent to SEVA AI processing my civic reports and optional location data solely for municipal resolution and public safety. My phone number and email are never exposed publicly.
            </span>
          </label>

          <button
            type="submit"
            className="px-5 py-2.5 bg-green-900 text-white text-sm font-medium rounded-lg hover:bg-green-800"
          >
            Save Preferences
          </button>

          {saveMsg && (
            <div className="flex items-center gap-2 text-xs text-green-900 font-medium">
              <CheckCircle2 className="w-4 h-4" />
              {saveMsg}
            </div>
          )}
          {saveError && (
            <div className="text-xs text-red-800 bg-red-50 border border-red-200 rounded-lg p-2.5">
              {saveError}
            </div>
          )}
        </form>

        <div className="lg:col-span-6 border border-slate-200 rounded-xl bg-white p-5 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 font-display text-base font-semibold text-slate-900">
              <Bell className="w-5 h-5 text-green-900" />
              Notifications ({notifications.filter((n) => !n.read).length} unread)
            </div>
            <Lock className="w-4 h-4 text-slate-400" />
          </div>

          {notifications.length === 0 ? (
            <p className="text-xs text-slate-500 py-8 text-center">No notifications yet.</p>
          ) : (
            <div className="divide-y divide-slate-200 max-h-72 overflow-y-auto">
              {notifications.map((n) => (
                <div key={n.id} className="py-3 flex items-start justify-between gap-3">
                  <div>
                    <div className={`text-sm ${n.read ? 'text-slate-700' : 'font-semibold text-slate-900'}`}>
                      {n.title}
                    </div>
                    <div className="text-xs text-slate-600 mt-0.5">{n.message}</div>
                  </div>
                  {!n.read && (
                    <button
                      type="button"
                      onClick={() => markRead(n.id)}
                      className="text-xs font-medium text-green-900 hover:underline shrink-0"
                    >
                      Mark read
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <LiveTrackingPanel />
    </div>
  );
};
