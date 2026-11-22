import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  ExternalLink,
  HeartPulse,
  Loader2,
  MapPin,
  Navigation,
  Phone,
  PhoneCall,
  RefreshCw,
  Search,
  Volume2,
} from 'lucide-react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { useAuth } from '../contexts/AuthContext';
import { useLocationEngine } from '../contexts/LocationContext';
import { db } from '../lib/firebase';
import { EmergencyContact, MedicalRequestRecord, NearbyPlace, SmsLogEntry } from '../types/seva';
import { LeafletMap } from './LeafletMap';

const RADIUS_PRESETS = [
  { label: '1 km', meters: 1000 },
  { label: '2 km', meters: 2000 },
  { label: '5 km', meters: 5000 },
  { label: '10 km', meters: 10000 },
  { label: '15 km', meters: 15000 },
  { label: '25 km', meters: 25000 },
];

function formatRadiusLabel(meters: number): string {
  const km = meters / 1000;
  return Number.isInteger(km) ? `${km} km` : `${km.toFixed(1)} km`;
}

function formatDistanceLabel(meters: number): string {
  return meters >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${meters} m`;
}

function buildGoogleMapsNavUrl(
  originLat: number | null,
  originLng: number | null,
  destLat: number,
  destLng: number,
  fallbackUrl: string
): string {
  if (originLat === null || originLng === null) return fallbackUrl;
  return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(
    `${originLat},${originLng}`
  )}&destination=${encodeURIComponent(`${destLat},${destLng}`)}&travelmode=driving`;
}

interface MedicalAssistanceViewProps {
  onSpeakText: (text: string) => void;
}

export const MedicalAssistanceView: React.FC<MedicalAssistanceViewProps> = ({ onSpeakText }) => {
  const { firebaseUser, profile, signingIn, signInWithGoogle } = useAuth();
  const {
    lat,
    lng,
    accuracyMeters,
    address,
    lastUpdated,
    gpsState,
    gpsError,
    isManualOverride,
    requestCurrentLocation,
    setManualLocation,
  } = useLocationEngine();

  // Independent state for Nearby Hospitals & Medical Facilities
  const [hospitalRadiusMeters, setHospitalRadiusMeters] = useState(5000);
  const [hospitalCustomOpen, setHospitalCustomOpen] = useState(false);
  const [hospitalCustomKm, setHospitalCustomKm] = useState('');
  const [hospitalCustomError, setHospitalCustomError] = useState<string | null>(null);
  const [hospitals, setHospitals] = useState<NearbyPlace[]>([]);
  const [hospitalsLoading, setHospitalsLoading] = useState(false);
  const [hospitalsError, setHospitalsError] = useState<string | null>(null);
  const [hospitalsProvider, setHospitalsProvider] = useState<string>('');
  const hospitalAbortRef = useRef<AbortController | null>(null);

  // Independent state for Nearby Police Stations
  const [policeRadiusMeters, setPoliceRadiusMeters] = useState(5000);
  const [policeCustomOpen, setPoliceCustomOpen] = useState(false);
  const [policeCustomKm, setPoliceCustomKm] = useState('');
  const [policeCustomError, setPoliceCustomError] = useState<string | null>(null);
  const [policeStations, setPoliceStations] = useState<NearbyPlace[]>([]);
  const [policeLoading, setPoliceLoading] = useState(false);
  const [policeError, setPoliceError] = useState<string | null>(null);
  const [policeProvider, setPoliceProvider] = useState<string>('');
  const policeAbortRef = useRef<AbortController | null>(null);

  const [manualSearchText, setManualSearchText] = useState('');
  const [searchingLocation, setSearchingLocation] = useState(false);
  const [manualSearchError, setManualSearchError] = useState<string | null>(null);

  const [contacts, setContacts] = useState<EmergencyContact[]>([]);
  const [backendCaregivers, setBackendCaregivers] = useState<EmergencyContact[]>([]);
  const [selectedCaregiverId, setSelectedCaregiverId] = useState('');
  const [caregiverCallMsg, setCaregiverCallMsg] = useState<string | null>(null);
  const [condition, setCondition] = useState('');
  const [severity, setSeverity] = useState<'Urgent' | 'Critical'>('Urgent');
  const [citizenPhone, setCitizenPhone] = useState(profile?.phone || '');
  const [submitting, setSubmitting] = useState(false);
  const [submitFeedback, setSubmitFeedback] = useState<{
    trackingId: string;
    smsSummary: string;
    smsLogs: SmsLogEntry[];
  } | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [history, setHistory] = useState<MedicalRequestRecord[]>([]);

  // Automatically request live GPS on mount if location is not yet acquired
  useEffect(() => {
    if (lat === null && lng === null && gpsState === 'idle') {
      requestCurrentLocation();
    }
  }, [lat, lng, gpsState, requestCurrentLocation]);

  useEffect(() => {
    if (profile?.phone && !citizenPhone) setCitizenPhone(profile.phone);
  }, [profile?.phone]);

  const loadHistory = useCallback(async () => {
    if (!firebaseUser) {
      setHistory([]);
      return;
    }
    try {
      const res = await fetch(`/api/citizen/medical/${encodeURIComponent(firebaseUser.uid)}`);
      const data = await res.json();
      if (Array.isArray(data.requests)) setHistory(data.requests);
    } catch {
      // ignore
    }
  }, [firebaseUser]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    if (!firebaseUser) {
      setContacts([]);
      setBackendCaregivers([]);
      return;
    }
    fetch(`/api/caregivers/${encodeURIComponent(firebaseUser.uid)}`)
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d.caregivers)) setBackendCaregivers(d.caregivers);
      })
      .catch(() => {});

    const q = query(collection(db, 'emergencyContacts'), where('uid', '==', firebaseUser.uid));
    return onSnapshot(q, (snap) => {
      setContacts(snap.docs.map((d) => ({ id: d.id, ...d.data() } as EmergencyContact)));
    });
  }, [firebaseUser]);

  const mergedContacts = useMemo(() => {
    const map = new Map<string, EmergencyContact>();
    for (const c of contacts) map.set(c.phone, c);
    for (const b of backendCaregivers) {
      if (!map.has(b.phone)) map.set(b.phone, b);
    }
    return Array.from(map.values());
  }, [contacts, backendCaregivers]);

  useEffect(() => {
    if (!selectedCaregiverId && mergedContacts.length > 0) {
      setSelectedCaregiverId(mergedContacts[0].id);
    } else if (selectedCaregiverId && !mergedContacts.some((c) => c.id === selectedCaregiverId)) {
      setSelectedCaregiverId(mergedContacts[0]?.id || '');
    }
  }, [mergedContacts, selectedCaregiverId]);

  useEffect(() => {
    if (!firebaseUser) return;
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}/ws`);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'subscribe', topic: `citizen:${firebaseUser.uid}` }));
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.event === 'medical:updated') loadHistory();
      } catch {}
    };
    return () => ws.close();
  }, [firebaseUser, loadHistory]);

  // Fetch Nearby Hospitals, Clinics, Medical Centres & Emergency Medical Facilities
  const fetchNearbyHospitals = useCallback(
    async (forceRefresh = false) => {
      if (lat === null || lng === null) return;
      if (hospitalAbortRef.current) hospitalAbortRef.current.abort();
      const controller = new AbortController();
      hospitalAbortRef.current = controller;

      setHospitalsLoading(true);
      setHospitalsError(null);
      try {
        const qs = new URLSearchParams({
          lat: String(lat),
          lng: String(lng),
          radius: String(hospitalRadiusMeters),
          categories: 'healthcare',
          mode: 'medical_facilities',
          ...(forceRefresh ? { refresh: 'true' } : {}),
        });
        const res = await fetch(`/api/places/nearby?${qs.toString()}`, {
          signal: controller.signal,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Unable to load nearby hospitals and medical facilities.');
        const list: NearbyPlace[] = Array.isArray(data.places) ? data.places : [];
        const strictlyBounded = list
          .filter((p) => p.distanceMeters <= hospitalRadiusMeters)
          .sort((a, b) => a.distanceMeters - b.distanceMeters);
        setHospitals(strictlyBounded);
        setHospitalsProvider(data.provider || 'OpenStreetMap Overpass API');
      } catch (err: any) {
        if (err?.name === 'AbortError') return;
        setHospitalsError(err?.message || 'Unable to query nearby hospitals right now.');
      } finally {
        if (!controller.signal.aborted) setHospitalsLoading(false);
      }
    },
    [lat, lng, hospitalRadiusMeters]
  );

  // Fetch Nearby Police Stations independently
  const fetchNearbyPolice = useCallback(
    async (forceRefresh = false) => {
      if (lat === null || lng === null) return;
      if (policeAbortRef.current) policeAbortRef.current.abort();
      const controller = new AbortController();
      policeAbortRef.current = controller;

      setPoliceLoading(true);
      setPoliceError(null);
      try {
        const qs = new URLSearchParams({
          lat: String(lat),
          lng: String(lng),
          radius: String(policeRadiusMeters),
          categories: 'public_safety',
          mode: 'police_only',
          ...(forceRefresh ? { refresh: 'true' } : {}),
        });
        const res = await fetch(`/api/places/nearby?${qs.toString()}`, {
          signal: controller.signal,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Unable to load nearby police stations.');
        const list: NearbyPlace[] = Array.isArray(data.places) ? data.places : [];
        const strictlyBounded = list
          .filter((p) => p.distanceMeters <= policeRadiusMeters)
          .sort((a, b) => a.distanceMeters - b.distanceMeters);
        setPoliceStations(strictlyBounded);
        setPoliceProvider(data.provider || 'OpenStreetMap Overpass API');
      } catch (err: any) {
        if (err?.name === 'AbortError') return;
        setPoliceError(err?.message || 'Unable to query nearby police stations right now.');
      } finally {
        if (!controller.signal.aborted) setPoliceLoading(false);
      }
    },
    [lat, lng, policeRadiusMeters]
  );

  useEffect(() => {
    fetchNearbyHospitals(false);
    return () => hospitalAbortRef.current?.abort();
  }, [fetchNearbyHospitals]);

  useEffect(() => {
    fetchNearbyPolice(false);
    return () => policeAbortRef.current?.abort();
  }, [fetchNearbyPolice]);

  const handleRefreshAllFromGps = async () => {
    const loc = await requestCurrentLocation();
    if (loc) {
      fetchNearbyHospitals(true);
      fetchNearbyPolice(true);
    }
  };

  const applyHospitalCustomRadius = (e: React.FormEvent) => {
    e.preventDefault();
    setHospitalCustomError(null);
    const km = Number(hospitalCustomKm);
    if (!Number.isFinite(km) || km < 0.2 || km > 50) {
      setHospitalCustomError('Enter a radius between 0.2 and 50 km.');
      return;
    }
    setHospitalRadiusMeters(Math.round(km * 1000));
  };

  const applyPoliceCustomRadius = (e: React.FormEvent) => {
    e.preventDefault();
    setPoliceCustomError(null);
    const km = Number(policeCustomKm);
    if (!Number.isFinite(km) || km < 0.2 || km > 50) {
      setPoliceCustomError('Enter a radius between 0.2 and 50 km.');
      return;
    }
    setPoliceRadiusMeters(Math.round(km * 1000));
  };

  const handleManualAddressSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (manualSearchText.trim().length < 3) return;
    setSearchingLocation(true);
    setManualSearchError(null);
    try {
      const res = await fetch(`/api/places/search?q=${encodeURIComponent(manualSearchText.trim())}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Location not found.');
      await setManualLocation(data.lat, data.lng, data.address);
    } catch (err: any) {
      setManualSearchError(err?.message || 'Unable to locate address.');
    } finally {
      setSearchingLocation(false);
    }
  };

  const handleSubmitMedical = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(null);
    setSubmitFeedback(null);
    if (!firebaseUser) {
      setSubmitError('Please sign in with Google first so medical authorities and caregivers can verify your request.');
      return;
    }
    if (condition.trim().length < 3) {
      setSubmitError('Please describe the medical condition or symptoms (at least 3 characters).');
      return;
    }
    const loc = lat !== null && lng !== null ? { lat, lng, address } : await requestCurrentLocation();
    if (!loc) {
      setSubmitError('GPS location could not be acquired. Please search your area manually below or enable location permissions.');
      return;
    }

    setSubmitting(true);
    try {
      const nearestHospital = hospitals[0]?.name;
      const consented = mergedContacts.filter((c) => c.consentGiven).map((c) => ({ name: c.name, phone: c.phone }));
      const res = await fetch('/api/medical/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uid: firebaseUser.uid,
          citizenName: profile?.displayName || firebaseUser.displayName || 'Citizen',
          citizenEmail: firebaseUser.email,
          citizenPhone,
          condition: condition.trim(),
          severity,
          lat: loc.lat,
          lng: loc.lng,
          accuracyMeters: accuracyMeters ?? undefined,
          address: loc.address,
          nearestHospital,
          caregiverContacts: consented,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to submit medical assistance request.');
      setCondition('');
      setSubmitFeedback({
        trackingId: data.medicalRequest.trackingId,
        smsSummary: data.smsDispatch?.summaryText || data.medicalRequest.smsStatus,
        smsLogs: data.smsDispatch?.logs || [],
      });
      await loadHistory();
    } catch (err: any) {
      setSubmitError(err?.message || 'Unable to dispatch medical request.');
    } finally {
      setSubmitting(false);
    }
  };

  const selectedCaregiver = mergedContacts.find((c) => c.id === selectedCaregiverId) || mergedContacts[0];
  const selectedCaregiverTel =
    selectedCaregiver && /^(\+[1-9][0-9]{7,14}|[6-9][0-9]{9})$/.test(selectedCaregiver.phone.replace(/[\s()-]/g, ''))
      ? `tel:${selectedCaregiver.phone.replace(/[\s()-]/g, '')}`
      : undefined;

  const handleCaregiverCall = async (e: React.MouseEvent) => {
    setCaregiverCallMsg(null);
    if (!selectedCaregiver || !selectedCaregiverTel) {
      e.preventDefault();
      setCaregiverCallMsg('Select a caregiver with a valid phone number in Seva Shield before calling.');
      return;
    }
    if (firebaseUser) {
      fetch('/api/calls/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uid: firebaseUser.uid,
          caregiverId: selectedCaregiver.id,
          caregiverName: selectedCaregiver.name,
          caregiverPhone: selectedCaregiver.phone,
          source: 'medical_assistance',
        }),
      }).catch(() => {});
    }
    setCaregiverCallMsg(
      `Phone dialer opened for ${selectedCaregiver.name} (${selectedCaregiver.phone}) — verify call connection on your device.`
    );
  };

  const mapMarkers = useMemo(() => {
    const medMarkers = hospitals.map((p) => ({
      id: `med-${p.id}`,
      lat: p.lat,
      lng: p.lng,
      title: p.name,
      subtitle: `${p.subcategory} · ${formatDistanceLabel(p.distanceMeters)}`,
      color: '#DC2626',
      directionsUrl: buildGoogleMapsNavUrl(lat, lng, p.lat, p.lng, p.directionsUrl),
    }));
    const polMarkers = policeStations.map((p) => ({
      id: `pol-${p.id}`,
      lat: p.lat,
      lng: p.lng,
      title: p.name,
      subtitle: `Police Station · ${formatDistanceLabel(p.distanceMeters)}`,
      color: '#1D4ED8',
      directionsUrl: buildGoogleMapsNavUrl(lat, lng, p.lat, p.lng, p.directionsUrl),
    }));
    return [...medMarkers, ...polMarkers];
  }, [hospitals, policeStations, lat, lng]);

  const maxRadius = Math.max(hospitalRadiusMeters, policeRadiusMeters);
  const mapZoom =
    maxRadius <= 1500
      ? 15
      : maxRadius <= 3000
      ? 14
      : maxRadius <= 7000
      ? 13
      : maxRadius <= 16000
      ? 12
      : 11;

  const isGpsBusy = gpsState === 'requesting' || gpsState === 'acquiring' || gpsState === 'improving';
  const gpsStatusLabel =
    gpsState === 'acquired'
      ? isManualOverride
        ? 'Manual Location Set'
        : 'Live GPS Active'
      : gpsState === 'improving'
      ? 'Refining GPS...'
      : gpsState === 'weak'
      ? 'Acquired (Low Accuracy)'
      : gpsState === 'requesting'
      ? 'Requesting Permission...'
      : gpsState === 'acquiring'
      ? 'Acquiring GPS...'
      : gpsState === 'denied'
      ? 'Permission Denied'
      : gpsState === 'timeout'
      ? 'Timed Out'
      : gpsState === 'unavailable'
      ? 'Unavailable'
      : gpsState === 'offline'
      ? 'Offline'
      : 'Idle';

  return (
    <div className="space-y-6">
      {/* Header & Direct Emergency Helplines */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="inline-flex items-center gap-1.5 text-xs font-semibold text-red-700 mb-1">
            <HeartPulse className="w-4 h-4" />
            Dedicated Medical Emergency Module
          </div>
          <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900">
            Medical Assistance &amp; Nearby Hospitals
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Direct 112 / 108 emergency call access, direct caregiver calling, live GPS hospital &amp; police finder, caregiver SMS alerts, and real-time Medical Services dispatch.
          </p>
        </div>

        <button
          type="button"
          onClick={() =>
            onSpeakText(
              'Medical Assistance module. Use Call 108 for ambulance or Call 112 for national emergency services on your phone. Below you can refresh your live GPS location, view nearby hospitals, clinics, medical centres, and police stations with independent radius controls, or dispatch a tracked medical alert to authorities and caregivers.'
            )
          }
          className="inline-flex items-center gap-2 px-4 py-2 bg-slate-900 text-white text-xs font-medium rounded-lg hover:bg-slate-800 whitespace-nowrap"
        >
          <Volume2 className="w-4 h-4" />
          Voice Guidance
        </button>
      </div>

      {/* Real Call Helplines & Direct Caregiver Call Bar */}
      <div className="border border-red-200 bg-red-50 rounded-xl p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="text-sm font-bold text-red-950">Direct Emergency &amp; Caregiver Call Services</div>
            <p className="text-xs text-red-900">
              Tapping a call button opens your device&apos;s native phone dialer. Verify the call connection directly on your phone.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            <a
              href="tel:108"
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-red-600 text-white text-xs font-semibold rounded-lg hover:bg-red-700"
            >
              <PhoneCall className="w-4 h-4" />
              Call Ambulance (108)
            </a>
            <a
              href="tel:112"
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-slate-900 text-white text-xs font-semibold rounded-lg hover:bg-slate-800"
            >
              <Phone className="w-4 h-4" />
              Call Emergency (112)
            </a>
          </div>
        </div>

        <div className="pt-3 border-t border-red-200/80 flex flex-wrap items-center gap-2.5">
          <span className="text-xs font-semibold text-red-950">Caregiver Quick Call:</span>
          {mergedContacts.length === 0 ? (
            <span className="text-xs text-red-900">No saved caregivers yet (add trusted contacts in Seva Shield SOS).</span>
          ) : (
            <>
              <select
                value={selectedCaregiver?.id || ''}
                onChange={(e) => setSelectedCaregiverId(e.target.value)}
                aria-label="Select caregiver to call from Medical Assistance"
                className="text-xs bg-white border border-red-200 rounded-lg px-2.5 py-2 text-slate-900"
              >
                {mergedContacts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.relation}) · {c.phone}
                  </option>
                ))}
              </select>
              <a
                href={selectedCaregiverTel || '#call-caregiver'}
                onClick={handleCaregiverCall}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-green-900 text-white text-xs font-semibold rounded-lg hover:bg-green-800"
              >
                <PhoneCall className="w-3.5 h-3.5" />
                Call Caregiver
              </a>
            </>
          )}
          {caregiverCallMsg && (
            <span className="text-xs text-slate-900 bg-white border border-red-200 rounded px-2.5 py-1">
              {caregiverCallMsg}
            </span>
          )}
        </div>
      </div>

      {/* Live GPS Telemetry + Manual Search Fallback */}
      <div className="border border-slate-200 rounded-xl bg-slate-50 p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-2.5 text-xs">
            <MapPin className="w-4 h-4 text-green-900 shrink-0 mt-0.5" />
            <div className="space-y-0.5">
              <div className="font-semibold text-slate-900">
                Live Location Status:{' '}
                <span
                  className={`uppercase font-mono ${
                    gpsState === 'denied' || gpsState === 'unavailable' || gpsState === 'timeout' || gpsState === 'offline'
                      ? 'text-red-700'
                      : 'text-green-900'
                  }`}
                >
                  {gpsStatusLabel}
                </span>
              </div>
              {lat !== null && lng !== null ? (
                <div className="text-slate-700">
                  {address || 'Resolving address...'} ·{' '}
                  <span className="font-mono">
                    {lat.toFixed(5)}, {lng.toFixed(5)}
                  </span>
                  {accuracyMeters !== null ? ` (±${accuracyMeters}m)` : ' (Manual Location)'}
                  {lastUpdated ? ` · Updated ${new Date(lastUpdated).toLocaleTimeString()}` : ''}
                </div>
              ) : (
                <div className="text-slate-600">
                  {isGpsBusy
                    ? 'Detecting your live device GPS coordinates and reverse-geocoding street address...'
                    : 'Allow location permission or enter your locality/city below to search nearby hospitals and police stations.'}
                </div>
              )}
            </div>
          </div>

          <button
            type="button"
            disabled={isGpsBusy}
            onClick={handleRefreshAllFromGps}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-green-900 text-white text-xs font-medium rounded-lg hover:bg-green-800 disabled:opacity-60"
          >
            {isGpsBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Navigation className="w-3.5 h-3.5" />}
            {isGpsBusy
              ? 'Detecting GPS...'
              : gpsState === 'denied' || gpsState === 'timeout' || gpsState === 'unavailable'
              ? 'Retry Live GPS'
              : lat !== null
              ? 'Refresh Live GPS'
              : 'Detect Live GPS'}
          </button>
        </div>

        {gpsError && (
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-amber-950 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5">
            <div className="flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-amber-800" />
              <span>{gpsError}</span>
            </div>
            <button
              type="button"
              onClick={handleRefreshAllFromGps}
              className="px-2.5 py-1 bg-amber-900 text-white rounded font-semibold shrink-0 hover:bg-amber-800"
            >
              Retry Location
            </button>
          </div>
        )}

        {(gpsError || lat === null || isManualOverride) && (
          <form onSubmit={handleManualAddressSearch} className="flex flex-wrap gap-2 pt-2 border-t border-slate-200">
            <input
              type="text"
              value={manualSearchText}
              onChange={(e) => setManualSearchText(e.target.value)}
              placeholder="GPS unavailable or testing another city? Enter city, locality, or street address..."
              className="flex-1 min-w-[220px] text-xs bg-white border border-slate-200 rounded-lg px-3 py-2"
            />
            <button
              type="submit"
              disabled={searchingLocation}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-slate-900 text-white text-xs font-medium rounded-lg disabled:opacity-50"
            >
              <Search className="w-3.5 h-3.5" />
              {searchingLocation ? 'Searching...' : 'Set Location Manually'}
            </button>
          </form>
        )}
        {manualSearchError && <div className="text-xs text-red-700">{manualSearchError}</div>}
      </div>

      {!firebaseUser && (
        <div className="border border-amber-200 bg-amber-50 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-amber-950">
            Sign in with Google to dispatch a tracked medical alert to Medical Services and notify your saved caregiver contacts. Direct 108/112 call buttons and hospital search work without sign-in.
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

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left: Request Form + History */}
        <div className="lg:col-span-5 space-y-5">
          <form onSubmit={handleSubmitMedical} className="border border-slate-200 rounded-xl bg-white p-5 space-y-4">
            <h2 className="font-display text-lg font-bold text-slate-900">
              Request Medical Assistance
            </h2>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Severity</label>
                <select
                  value={severity}
                  onChange={(e) => setSeverity(e.target.value as 'Urgent' | 'Critical')}
                  className="w-full text-xs border border-slate-200 rounded-lg px-3 py-2 bg-white"
                >
                  <option value="Urgent">Urgent</option>
                  <option value="Critical">Critical (Life-Threatening)</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Callback Phone</label>
                <input
                  type="tel"
                  value={citizenPhone}
                  onChange={(e) => setCitizenPhone(e.target.value)}
                  placeholder="+91 9876543210"
                  className="w-full text-xs border border-slate-200 rounded-lg px-3 py-2"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Patient Condition &amp; Assistance Needed
              </label>
              <textarea
                rows={3}
                value={condition}
                onChange={(e) => setCondition(e.target.value)}
                placeholder="Describe symptoms, consciousness, bleeding, oxygen/ambulance need..."
                className="w-full text-xs border border-slate-200 rounded-lg px-3 py-2"
                required
              />
            </div>

            <div className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg p-3">
              <strong>Caregiver SMS Alert:</strong>{' '}
              {mergedContacts.filter((c) => c.consentGiven).length > 0
                ? `${mergedContacts.filter((c) => c.consentGiven).length} consented trusted contact(s) will be notified.`
                : 'No consented trusted contacts saved yet (manage contacts inside Seva Shield).'}
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="w-full py-2.5 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 disabled:opacity-50 inline-flex items-center justify-center gap-2"
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <HeartPulse className="w-4 h-4" />}
              Dispatch Medical Alert &amp; Notify Caregivers
            </button>

            {submitError && (
              <div className="flex items-start gap-2 text-xs text-red-800 bg-red-50 border border-red-200 rounded-lg p-3">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{submitError}</span>
              </div>
            )}

            {submitFeedback && (
              <div className="text-xs bg-emerald-50 border border-emerald-200 rounded-lg p-3.5 space-y-2">
                <div className="flex items-center gap-1.5 font-semibold text-emerald-950">
                  <CheckCircle2 className="w-4 h-4" />
                  Medical Request Dispatched ({submitFeedback.trackingId})
                </div>
                <p className="text-slate-800">{submitFeedback.smsSummary}</p>
                {submitFeedback.smsLogs.length > 0 && (
                  <div className="space-y-1 pt-1 border-t border-emerald-200">
                    {submitFeedback.smsLogs.map((log) => (
                      <div key={log.id} className="text-[11px] text-slate-700">
                        {log.recipientName} ({log.recipientPhone}):{' '}
                        <span className="font-mono font-semibold uppercase">{log.status}</span>
                        {log.error ? ` — ${log.error}` : ''}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </form>

          {history.length > 0 && (
            <div className="border border-slate-200 rounded-xl bg-white p-5 space-y-3">
              <h3 className="font-display text-sm font-semibold text-slate-900">
                Your Medical Assistance History ({history.length})
              </h3>
              <div className="space-y-2.5">
                {history.map((m) => (
                  <div key={m.id} className="text-xs border border-slate-200 rounded-lg p-3 bg-slate-50 space-y-1">
                    <div className="flex items-center justify-between font-semibold text-slate-900">
                      <span className="font-mono">{m.trackingId}</span>
                      <span className="text-green-900">{m.status}</span>
                    </div>
                    <div className="text-slate-700">{m.condition}</div>
                    <div className="text-slate-500">
                      {m.severity} · {m.address}
                    </div>
                    {m.assignedResponder && (
                      <div className="text-emerald-900 font-medium">Responder: {m.assignedResponder}</div>
                    )}
                    {m.responseNotes && <div className="text-slate-700">Notes: {m.responseNotes}</div>}
                    <div className="text-[11px] text-slate-500">SMS: {m.smsStatus}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right: Nearby Hospitals / Medical Facilities & Police Stations with Independent Radii + Map */}
        <div className="lg:col-span-7 border border-slate-200 rounded-xl bg-white p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="font-display text-base font-bold text-slate-900">
                Nearby Hospitals, Medical Facilities &amp; Police Stations
              </h2>
              <p className="text-xs text-slate-500">
                Real-time geographical search sorted nearest-first with independent search radii and Google Maps navigation.
              </p>
            </div>
            <div className="text-[11px] text-slate-500 font-mono">
              {hospitalsProvider || policeProvider || 'OpenStreetMap Live'}
            </div>
          </div>

          {lat !== null && lng !== null ? (
            <LeafletMap
              centerLat={lat}
              centerLng={lng}
              zoom={mapZoom}
              userLat={lat}
              userLng={lng}
              userAccuracyMeters={accuracyMeters}
              searchRadiusMeters={hospitalRadiusMeters}
              primaryRadiusColor="#DC2626"
              secondaryRadiusMeters={policeRadiusMeters}
              secondaryRadiusColor="#1D4ED8"
              markers={mapMarkers}
              onMapClick={(cLat, cLng) => setManualLocation(cLat, cLng)}
              heightClass="h-[250px]"
            />
          ) : (
            <div className="py-8 text-center text-xs text-slate-500 border border-dashed border-slate-200 rounded-xl bg-slate-50">
              {isGpsBusy
                ? 'Waiting for live GPS coordinates to map nearby hospitals and police stations...'
                : 'Enable browser location permission or search your location manually above to view nearby hospitals and police stations.'}
            </div>
          )}

          {lat !== null && lng !== null && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Independent Hospitals & Medical Facilities Column */}
              <div className="space-y-3 border border-slate-200 rounded-xl p-3.5 bg-slate-50/50">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="text-xs font-bold text-red-700 uppercase tracking-wide">
                      Hospitals &amp; Medical ({hospitals.length})
                    </div>
                    <div className="text-[11px] text-slate-600 font-mono">
                      Selected radius: {formatRadiusLabel(hospitalRadiusMeters)}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => fetchNearbyHospitals(true)}
                    disabled={hospitalsLoading}
                    aria-label="Refresh nearby hospitals and medical facilities"
                    className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium bg-white border border-slate-200 rounded-md hover:bg-slate-100 disabled:opacity-50"
                  >
                    <RefreshCw className={`w-3 h-3 ${hospitalsLoading ? 'animate-spin' : ''}`} />
                    Refresh
                  </button>
                </div>

                {/* Hospital Radius Presets + Custom */}
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-1">
                    {RADIUS_PRESETS.map((r) => (
                      <button
                        key={r.meters}
                        type="button"
                        onClick={() => {
                          setHospitalCustomOpen(false);
                          setHospitalCustomError(null);
                          setHospitalRadiusMeters(r.meters);
                        }}
                        className={`px-2 py-1 text-[11px] font-medium rounded tabular-nums ${
                          !hospitalCustomOpen && hospitalRadiusMeters === r.meters
                            ? 'bg-red-700 text-white'
                            : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-100'
                        }`}
                      >
                        {r.label}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => setHospitalCustomOpen((v) => !v)}
                      className={`px-2 py-1 text-[11px] font-medium rounded ${
                        hospitalCustomOpen || !RADIUS_PRESETS.some((r) => r.meters === hospitalRadiusMeters)
                          ? 'bg-slate-900 text-white'
                          : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-100'
                      }`}
                    >
                      Custom
                    </button>
                  </div>

                  {hospitalCustomOpen && (
                    <form onSubmit={applyHospitalCustomRadius} className="flex items-center gap-1.5">
                      <input
                        type="number"
                        step="0.5"
                        min="0.2"
                        max="50"
                        value={hospitalCustomKm}
                        onChange={(e) => setHospitalCustomKm(e.target.value)}
                        placeholder="Radius (km)"
                        aria-label="Custom hospital search radius in km"
                        className="w-24 text-xs bg-white border border-slate-300 rounded px-2 py-1 text-slate-900"
                      />
                      <button
                        type="submit"
                        className="px-2.5 py-1 text-[11px] font-semibold bg-red-700 text-white rounded hover:bg-red-800"
                      >
                        Apply km
                      </button>
                    </form>
                  )}
                  {hospitalCustomError && <div className="text-[11px] text-red-700">{hospitalCustomError}</div>}
                </div>

                {hospitalsError && (
                  <div className="text-xs text-red-800 bg-red-50 border border-red-200 rounded-lg p-2.5">
                    {hospitalsError}
                  </div>
                )}

                {hospitalsLoading ? (
                  <div className="py-8 text-center text-xs text-slate-600 flex flex-col items-center">
                    <Loader2 className="w-5 h-5 animate-spin text-red-700 mb-2" />
                    Searching hospitals, clinics &amp; medical centres within {formatRadiusLabel(hospitalRadiusMeters)}...
                  </div>
                ) : hospitals.length === 0 ? (
                  <p className="text-xs text-slate-500 bg-white border border-slate-200 rounded-lg p-3">
                    No hospitals or medical facilities found within {formatRadiusLabel(hospitalRadiusMeters)}. Try selecting 10 km, 15 km, 25 km, or a larger custom radius.
                  </p>
                ) : (
                  <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                    {hospitals.map((p) => {
                      const navUrl = buildGoogleMapsNavUrl(lat, lng, p.lat, p.lng, p.directionsUrl);
                      return (
                        <div key={p.id} className="bg-white border border-slate-200 rounded-lg p-3 text-xs space-y-1">
                          <div className="font-semibold text-slate-900">{p.name}</div>
                          <div className="text-slate-500 capitalize">
                            {p.subcategory} ·{' '}
                            <span className="font-mono text-red-700 font-semibold">
                              {formatDistanceLabel(p.distanceMeters)}
                            </span>
                          </div>
                          <div className="text-slate-600">{p.address}</div>
                          {p.openingHours && (
                            <div className="text-[11px] text-slate-500 inline-flex items-center gap-1">
                              <Clock className="w-3 h-3" /> {p.openingHours}
                            </div>
                          )}
                          <div className="flex flex-wrap gap-3 pt-1">
                            <a
                              href={navUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 font-medium text-green-900 hover:underline"
                            >
                              Navigate (Google Maps) <ExternalLink className="w-3 h-3" />
                            </a>
                            {p.phone && (
                              <a
                                href={`tel:${p.phone}`}
                                className="inline-flex items-center gap-1 font-medium text-red-700 hover:underline"
                              >
                                <Phone className="w-3 h-3" /> {p.phone}
                              </a>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Independent Police Stations Column */}
              <div className="space-y-3 border border-slate-200 rounded-xl p-3.5 bg-slate-50/50">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="text-xs font-bold text-blue-800 uppercase tracking-wide">
                      Nearby Police Stations ({policeStations.length})
                    </div>
                    <div className="text-[11px] text-slate-600 font-mono">
                      Selected radius: {formatRadiusLabel(policeRadiusMeters)}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => fetchNearbyPolice(true)}
                    disabled={policeLoading}
                    aria-label="Refresh nearby police stations"
                    className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium bg-white border border-slate-200 rounded-md hover:bg-slate-100 disabled:opacity-50"
                  >
                    <RefreshCw className={`w-3 h-3 ${policeLoading ? 'animate-spin' : ''}`} />
                    Refresh
                  </button>
                </div>

                {/* Police Radius Presets + Custom */}
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-1">
                    {RADIUS_PRESETS.map((r) => (
                      <button
                        key={r.meters}
                        type="button"
                        onClick={() => {
                          setPoliceCustomOpen(false);
                          setPoliceCustomError(null);
                          setPoliceRadiusMeters(r.meters);
                        }}
                        className={`px-2 py-1 text-[11px] font-medium rounded tabular-nums ${
                          !policeCustomOpen && policeRadiusMeters === r.meters
                            ? 'bg-blue-700 text-white'
                            : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-100'
                        }`}
                      >
                        {r.label}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => setPoliceCustomOpen((v) => !v)}
                      className={`px-2 py-1 text-[11px] font-medium rounded ${
                        policeCustomOpen || !RADIUS_PRESETS.some((r) => r.meters === policeRadiusMeters)
                          ? 'bg-slate-900 text-white'
                          : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-100'
                      }`}
                    >
                      Custom
                    </button>
                  </div>

                  {policeCustomOpen && (
                    <form onSubmit={applyPoliceCustomRadius} className="flex items-center gap-1.5">
                      <input
                        type="number"
                        step="0.5"
                        min="0.2"
                        max="50"
                        value={policeCustomKm}
                        onChange={(e) => setPoliceCustomKm(e.target.value)}
                        placeholder="Radius (km)"
                        aria-label="Custom police station search radius in km"
                        className="w-24 text-xs bg-white border border-slate-300 rounded px-2 py-1 text-slate-900"
                      />
                      <button
                        type="submit"
                        className="px-2.5 py-1 text-[11px] font-semibold bg-blue-700 text-white rounded hover:bg-blue-800"
                      >
                        Apply km
                      </button>
                    </form>
                  )}
                  {policeCustomError && <div className="text-[11px] text-red-700">{policeCustomError}</div>}
                </div>

                {policeError && (
                  <div className="text-xs text-red-800 bg-red-50 border border-red-200 rounded-lg p-2.5">
                    {policeError}
                  </div>
                )}

                {policeLoading ? (
                  <div className="py-8 text-center text-xs text-slate-600 flex flex-col items-center">
                    <Loader2 className="w-5 h-5 animate-spin text-blue-700 mb-2" />
                    Searching police stations within {formatRadiusLabel(policeRadiusMeters)}...
                  </div>
                ) : policeStations.length === 0 ? (
                  <p className="text-xs text-slate-500 bg-white border border-slate-200 rounded-lg p-3">
                    No police stations found within {formatRadiusLabel(policeRadiusMeters)}. Try expanding to 10 km, 15 km, 25 km, or a larger custom radius.
                  </p>
                ) : (
                  <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                    {policeStations.map((p) => {
                      const navUrl = buildGoogleMapsNavUrl(lat, lng, p.lat, p.lng, p.directionsUrl);
                      return (
                        <div key={p.id} className="bg-white border border-slate-200 rounded-lg p-3 text-xs space-y-1">
                          <div className="font-semibold text-slate-900">{p.name}</div>
                          <div className="text-slate-500">
                            Police Station ·{' '}
                            <span className="font-mono text-blue-800 font-semibold">
                              {formatDistanceLabel(p.distanceMeters)}
                            </span>
                          </div>
                          <div className="text-slate-600">{p.address}</div>
                          {p.openingHours && (
                            <div className="text-[11px] text-slate-500 inline-flex items-center gap-1">
                              <Clock className="w-3 h-3" /> {p.openingHours}
                            </div>
                          )}
                          <div className="flex flex-wrap gap-3 pt-1">
                            <a
                              href={navUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 font-medium text-green-900 hover:underline"
                            >
                              Navigate (Google Maps) <ExternalLink className="w-3 h-3" />
                            </a>
                            {p.phone && (
                              <a
                                href={`tel:${p.phone}`}
                                className="inline-flex items-center gap-1 font-medium text-blue-800 hover:underline"
                              >
                                <Phone className="w-3 h-3" /> {p.phone}
                              </a>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
