import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  Ambulance,
  Camera,
  CheckCircle2,
  ExternalLink,
  Loader2,
  MapPin,
  Navigation,
  Phone,
  PhoneCall,
  Search,
  Volume2,
} from 'lucide-react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { useAuth } from '../contexts/AuthContext';
import { useLocationEngine } from '../contexts/LocationContext';
import { db } from '../lib/firebase';
import {
  AccidentRequestRecord,
  EmergencyContact,
  NearbyPlace,
  SmsLogEntry,
  UploadedFileRef,
} from '../types/seva';
import { LeafletMap } from './LeafletMap';

const RADIUS_OPTIONS = [
  { label: '1 km', meters: 1000 },
  { label: '2 km', meters: 2000 },
  { label: '5 km', meters: 5000 },
  { label: '10 km', meters: 10000 },
  { label: '15 km', meters: 15000 },
];

interface RoadAccidentViewProps {
  onSpeakText: (text: string) => void;
}

export const RoadAccidentView: React.FC<RoadAccidentViewProps> = ({ onSpeakText }) => {
  const { firebaseUser, profile, signingIn, signInWithGoogle } = useAuth();
  const {
    lat,
    lng,
    accuracyMeters,
    address,
    gpsState,
    gpsError,
    requestCurrentLocation,
    setManualLocation,
  } = useLocationEngine();

  const [radiusMeters, setRadiusMeters] = useState(5000);
  const [places, setPlaces] = useState<NearbyPlace[]>([]);
  const [placesLoading, setPlacesLoading] = useState(false);
  const [manualSearchText, setManualSearchText] = useState('');
  const [searchingLoc, setSearchingLoc] = useState(false);

  const [contacts, setContacts] = useState<EmergencyContact[]>([]);
  const [severity, setSeverity] = useState<'Moderate' | 'Severe' | 'Critical'>('Severe');
  const [peopleAffected, setPeopleAffected] = useState(1);
  const [description, setDescription] = useState('');
  const [locationLabel, setLocationLabel] = useState('');
  const [uploadedPhotos, setUploadedPhotos] = useState<UploadedFileRef[]>([]);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    trackingId: string;
    smsSummary: string;
    smsLogs: SmsLogEntry[];
  } | null>(null);
  const [history, setHistory] = useState<AccidentRequestRecord[]>([]);

  useEffect(() => {
    if (address && !locationLabel) setLocationLabel(address);
  }, [address]);

  const loadHistory = useCallback(async () => {
    if (!firebaseUser) {
      setHistory([]);
      return;
    }
    try {
      const res = await fetch(`/api/citizen/accident/${encodeURIComponent(firebaseUser.uid)}`);
      const data = await res.json();
      if (Array.isArray(data.requests)) setHistory(data.requests);
    } catch {}
  }, [firebaseUser]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    if (!firebaseUser) {
      setContacts([]);
      return;
    }
    const q = query(collection(db, 'emergencyContacts'), where('uid', '==', firebaseUser.uid));
    return onSnapshot(q, (snap) => {
      setContacts(snap.docs.map((d) => ({ id: d.id, ...d.data() } as EmergencyContact)));
    });
  }, [firebaseUser]);

  useEffect(() => {
    if (!firebaseUser) return;
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}/ws`);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'subscribe', topic: `citizen:${firebaseUser.uid}` }));
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.event === 'accident:updated') loadHistory();
      } catch {}
    };
    return () => ws.close();
  }, [firebaseUser, loadHistory]);

  useEffect(() => {
    if (lat === null || lng === null) return;
    setPlacesLoading(true);
    fetch(
      `/api/places/nearby?lat=${lat}&lng=${lng}&radius=${radiusMeters}&categories=healthcare,public_safety&strictMedicalSafety=true`
    )
      .then((r) => r.json())
      .then((d) => setPlaces(d.places || []))
      .catch(() => {})
      .finally(() => setPlacesLoading(false));
  }, [lat, lng, radiusMeters]);

  const handleManualSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (manualSearchText.trim().length < 3) return;
    setSearchingLoc(true);
    try {
      const res = await fetch(`/api/places/search?q=${encodeURIComponent(manualSearchText.trim())}`);
      const data = await res.json();
      if (res.ok) {
        await setManualLocation(data.lat, data.lng, data.address);
        setLocationLabel(data.address);
      }
    } finally {
      setSearchingLoc(false);
    }
  };

  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploadingPhoto(true);
    setSubmitError(null);
    try {
      const form = new FormData();
      Array.from(files).forEach((f) => form.append('files', f));
      const res = await fetch('/api/uploads', { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Photo upload failed.');
      setUploadedPhotos((prev) => [...prev, ...(data.files || [])]);
    } catch (err: any) {
      setSubmitError(err?.message || 'Unable to upload photo.');
    } finally {
      setUploadingPhoto(false);
    }
  };

  const handleSubmitAccident = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(null);
    setFeedback(null);
    if (!firebaseUser) {
      setSubmitError('Please sign in with Google first to submit a tracked road accident alert.');
      return;
    }
    if (description.trim().length < 5) {
      setSubmitError('Please describe the road accident, vehicles involved, and injuries.');
      return;
    }
    const loc = lat !== null && lng !== null ? { lat, lng, address: locationLabel || address } : await requestCurrentLocation();
    if (!loc) {
      setSubmitError('Coordinates required. Acquire live GPS or search your location manually.');
      return;
    }

    setSubmitting(true);
    try {
      const nearestHospital = places.find((p) => p.subcategory === 'hospital')?.name;
      const nearestPolice = places.find((p) => p.subcategory === 'police')?.name;
      const consented = contacts.filter((c) => c.consentGiven).map((c) => ({ name: c.name, phone: c.phone }));

      const res = await fetch('/api/accident/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uid: firebaseUser.uid,
          citizenName: profile?.displayName || firebaseUser.displayName || 'Citizen',
          citizenEmail: firebaseUser.email,
          description: description.trim(),
          severity,
          peopleAffected,
          lat: loc.lat,
          lng: loc.lng,
          accuracyMeters: accuracyMeters ?? undefined,
          address: (locationLabel || loc.address).slice(0, 300),
          photoUrls: uploadedPhotos,
          nearestHospital,
          nearestPolice,
          caregiverContacts: consented,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Accident alert submission failed.');
      setDescription('');
      setUploadedPhotos([]);
      setFeedback({
        trackingId: data.accidentRequest.trackingId,
        smsSummary: data.smsDispatch?.summaryText || data.accidentRequest.smsStatus,
        smsLogs: data.smsDispatch?.logs || [],
      });
      await loadHistory();
    } catch (err: any) {
      setSubmitError(err?.message || 'Unable to submit road accident alert.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-700 mb-1">
            <Ambulance className="w-4 h-4" />
            Dedicated Road Accident Help Module
          </div>
          <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900">
            Road Accident Help &amp; Trauma Response
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Immediate 112/108 emergency call shortcuts, scene photo evidence upload, people affected count, caregiver SMS alerts, and nearby trauma hospitals &amp; traffic police.
          </p>
        </div>

        <button
          type="button"
          onClick={() =>
            onSpeakText(
              'Road Accident Help module. Dial 112 for police and emergency response or 108 for ambulance. Enter the accident severity, number of people affected, attach a photo if safe to do so, and submit to notify authorities and caregivers with your exact GPS location.'
            )
          }
          className="inline-flex items-center gap-2 px-4 py-2 bg-slate-900 text-white text-xs font-medium rounded-lg hover:bg-slate-800 whitespace-nowrap"
        >
          <Volume2 className="w-4 h-4" />
          Voice Guidance
        </button>
      </div>

      {/* Real Call Helplines Bar */}
      <div className="border border-amber-300 bg-amber-50 rounded-xl p-4 flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="text-sm font-bold text-amber-950">Emergency Crash Helplines (Real Phone Dialer)</div>
          <p className="text-xs text-amber-900">
            Clicking opens your device&apos;s phone dialer to reach Police (112) or Trauma Ambulance (108).
          </p>
        </div>
        <div className="flex flex-wrap gap-2.5">
          <a
            href="tel:112"
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-red-600 text-white text-xs font-semibold rounded-lg hover:bg-red-700"
          >
            <PhoneCall className="w-4 h-4" />
            Call Police / ERSS (112)
          </a>
          <a
            href="tel:108"
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-slate-900 text-white text-xs font-semibold rounded-lg hover:bg-slate-800"
          >
            <Phone className="w-4 h-4" />
            Call Ambulance (108)
          </a>
        </div>
      </div>

      {/* Live GPS & Manual Search Fallback */}
      <div className="border border-slate-200 rounded-xl bg-slate-50 p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-start gap-2 text-xs">
            <MapPin className="w-4 h-4 text-green-900 shrink-0 mt-0.5" />
            <div>
              <span className="font-semibold text-slate-900">Crash Scene Location ({gpsState}): </span>
              {lat !== null && lng !== null ? (
                <span>
                  {address || 'GPS Ready'} ({lat.toFixed(5)}, {lng.toFixed(5)})
                </span>
              ) : (
                <span>Acquire GPS or search crash landmark below.</span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={() => requestCurrentLocation()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-green-900 text-white text-xs font-medium rounded-lg"
          >
            <Navigation className="w-3.5 h-3.5" />
            Refresh GPS
          </button>
        </div>
        {(gpsError || lat === null) && (
          <form onSubmit={handleManualSearch} className="flex flex-wrap gap-2 pt-2 border-t border-slate-200">
            <input
              type="text"
              value={manualSearchText}
              onChange={(e) => setManualSearchText(e.target.value)}
              placeholder="Search highway, crossing, or landmark manually..."
              className="flex-1 min-w-[200px] text-xs bg-white border border-slate-200 rounded-lg px-3 py-2"
            />
            <button
              type="submit"
              disabled={searchingLoc}
              className="inline-flex items-center gap-1.5 px-3 py-2 bg-slate-900 text-white text-xs font-medium rounded-lg"
            >
              <Search className="w-3.5 h-3.5" />
              {searchingLoc ? 'Searching...' : 'Locate'}
            </button>
          </form>
        )}
      </div>

      {!firebaseUser && (
        <div className="border border-amber-200 bg-amber-50 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-amber-950">
            Sign in with Google to submit a tracked road accident alert with scene photos and caregiver notifications.
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
        <div className="lg:col-span-6 space-y-5">
          <form onSubmit={handleSubmitAccident} className="border border-slate-200 rounded-xl bg-white p-5 space-y-4">
            <h2 className="font-display text-lg font-bold text-slate-900">Report Road Accident Scene</h2>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Accident Severity</label>
                <select
                  value={severity}
                  onChange={(e) => setSeverity(e.target.value as any)}
                  className="w-full text-xs border border-slate-200 rounded-lg px-3 py-2 bg-white"
                >
                  <option value="Moderate">Moderate (No critical injuries)</option>
                  <option value="Severe">Severe (Injured / Road Blocked)</option>
                  <option value="Critical">Critical (Multi-vehicle / Urgent Trauma)</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">People Affected</label>
                <input
                  type="number"
                  min={1}
                  max={200}
                  value={peopleAffected}
                  onChange={(e) => setPeopleAffected(Math.max(1, Number(e.target.value) || 1))}
                  className="w-full text-xs border border-slate-200 rounded-lg px-3 py-2"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Exact Landmark / Highway / Crossing</label>
              <input
                type="text"
                value={locationLabel}
                onChange={(e) => setLocationLabel(e.target.value)}
                placeholder="Auto-filled from GPS or enter landmark..."
                className="w-full text-xs border border-slate-200 rounded-lg px-3 py-2"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Incident Details</label>
              <textarea
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Vehicles involved, trapped passengers, bleeding, fuel leak, or traffic obstruction..."
                className="w-full text-xs border border-slate-200 rounded-lg px-3 py-2"
                required
              />
            </div>

            <div className="space-y-2">
              <label className="border border-dashed border-slate-300 rounded-lg p-3 flex items-center gap-3 cursor-pointer hover:bg-slate-50">
                <Camera className="w-5 h-5 text-green-900 shrink-0" />
                <div className="text-xs">
                  <div className="font-semibold text-slate-800">
                    {uploadingPhoto ? 'Uploading Scene Photo(s)...' : 'Attach Scene Photo(s) (Optional)'}
                  </div>
                  <div className="text-slate-500">Saved persistently for Traffic Police &amp; Medical dispatch</div>
                </div>
                <input type="file" accept="image/*" multiple onChange={handlePhotoUpload} className="hidden" />
              </label>

              {uploadedPhotos.length > 0 && (
                <div className="grid grid-cols-3 gap-2">
                  {uploadedPhotos.map((p) => (
                    <img
                      key={p.id}
                      src={p.url}
                      alt={p.originalName}
                      className="w-full h-20 object-cover rounded-lg border border-slate-200"
                    />
                  ))}
                </div>
              )}
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="w-full py-2.5 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 disabled:opacity-50 inline-flex items-center justify-center gap-2"
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Ambulance className="w-4 h-4" />}
              Alert Control Room &amp; Caregivers
            </button>

            {submitError && (
              <div className="flex items-start gap-2 text-xs text-red-800 bg-red-50 border border-red-200 rounded-lg p-3">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{submitError}</span>
              </div>
            )}

            {feedback && (
              <div className="text-xs bg-emerald-50 border border-emerald-200 rounded-lg p-3.5 space-y-2">
                <div className="flex items-center gap-1.5 font-semibold text-emerald-950">
                  <CheckCircle2 className="w-4 h-4" />
                  Accident Alert Sent ({feedback.trackingId})
                </div>
                <p>{feedback.smsSummary}</p>
                {feedback.smsLogs.map((l) => (
                  <div key={l.id} className="text-[11px] text-slate-700">
                    {l.recipientName} ({l.recipientPhone}): <span className="font-mono uppercase">{l.status}</span>
                    {l.error ? ` — ${l.error}` : ''}
                  </div>
                ))}
              </div>
            )}
          </form>

          {history.length > 0 && (
            <div className="border border-slate-200 rounded-xl bg-white p-5 space-y-3">
              <h3 className="font-display text-sm font-semibold text-slate-900">
                Your Road Accident Reports ({history.length})
              </h3>
              <div className="space-y-2">
                {history.map((a) => (
                  <div key={a.id} className="text-xs border border-slate-200 rounded-lg p-3 bg-slate-50 space-y-1">
                    <div className="flex justify-between font-semibold text-slate-900">
                      <span className="font-mono">{a.trackingId}</span>
                      <span className="text-green-900">{a.status}</span>
                    </div>
                    <div className="text-slate-700">{a.description}</div>
                    <div className="text-slate-500">
                      {a.severity} · {a.peopleAffected} affected · {a.address}
                    </div>
                    {a.assignedResponder && (
                      <div className="text-emerald-900 font-medium">Responder: {a.assignedResponder}</div>
                    )}
                    <div className="text-[11px] text-slate-500">SMS: {a.smsStatus}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right: Map + Nearby Trauma Hospitals & Police */}
        <div className="lg:col-span-6 border border-slate-200 rounded-xl bg-white p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-display text-base font-bold text-slate-900">
              Nearby Hospitals &amp; Police Stations
            </h2>
            <div className="flex gap-1">
              {RADIUS_OPTIONS.map((r) => (
                <button
                  key={r.meters}
                  type="button"
                  onClick={() => setRadiusMeters(r.meters)}
                  className={`px-2 py-1 text-xs font-medium rounded ${
                    radiusMeters === r.meters ? 'bg-green-900 text-white' : 'bg-slate-100 text-slate-700'
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>

          {lat !== null && lng !== null && (
            <LeafletMap
              centerLat={lat}
              centerLng={lng}
              zoom={13}
              userLat={lat}
              userLng={lng}
              searchRadiusMeters={radiusMeters}
              markers={places.map((p) => ({
                id: p.id,
                lat: p.lat,
                lng: p.lng,
                title: p.name,
                subtitle: `${p.subcategory} · ${(p.distanceMeters / 1000).toFixed(2)} km`,
                color: p.subcategory === 'hospital' ? '#DC2626' : '#1D4ED8',
                directionsUrl: p.directionsUrl,
              }))}
              heightClass="h-[240px]"
            />
          )}

          {placesLoading ? (
            <div className="py-8 text-center text-xs text-slate-500">
              <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2 text-green-900" />
              Fetching nearby hospitals &amp; police stations...
            </div>
          ) : (
            <div className="divide-y divide-slate-200 border border-slate-200 rounded-lg max-h-72 overflow-y-auto">
              {places.length === 0 ? (
                <div className="p-4 text-xs text-slate-500 text-center">
                  Acquire GPS or expand radius to locate nearest hospitals and police.
                </div>
              ) : (
                places.map((p) => (
                  <div key={p.id} className="p-3 flex items-start justify-between gap-2 text-xs">
                    <div>
                      <div className="font-semibold text-slate-900">{p.name}</div>
                      <div className="text-slate-500 capitalize">
                        {p.subcategory} · {(p.distanceMeters / 1000).toFixed(2)} km
                      </div>
                      {p.phone && (
                        <a href={`tel:${p.phone}`} className="inline-flex items-center gap-1 text-red-700 mt-0.5">
                          <Phone className="w-3 h-3" /> {p.phone}
                        </a>
                      )}
                    </div>
                    <a
                      href={p.directionsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-green-900 font-medium hover:underline shrink-0"
                    >
                      Directions <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
