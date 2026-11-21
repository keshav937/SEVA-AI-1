import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { doc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { OperationType, buildFirestoreErrorInfo, db } from '../lib/firebase';
import { useAuth } from './AuthContext';

export type GpsState =
  | 'idle'
  | 'requesting'
  | 'acquiring'
  | 'acquired'
  | 'improving'
  | 'weak'
  | 'denied'
  | 'unavailable'
  | 'offline';

export type TrackingState = 'idle' | 'active' | 'paused' | 'stopped';

export interface TrackingHistoryPoint {
  lat: number;
  lng: number;
  accuracyMeters: number;
  address: string;
  timestamp: string;
}

interface LocationContextValue {
  lat: number | null;
  lng: number | null;
  accuracyMeters: number | null;
  address: string;
  city: string;
  ward: string;
  lastUpdated: string | null;
  gpsState: GpsState;
  gpsError: string | null;
  isManualOverride: boolean;
  trackingState: TrackingState;
  shareToken: string | null;
  shareExpiresAt: string | null;
  trackingHistory: TrackingHistoryPoint[];
  requestCurrentLocation: () => Promise<{ lat: number; lng: number; address: string } | null>;
  setManualLocation: (lat: number, lng: number, label?: string) => Promise<void>;
  startLiveTracking: (createShare?: boolean) => Promise<string | null>;
  pauseLiveTracking: () => void;
  resumeLiveTracking: () => void;
  stopLiveTracking: () => Promise<void>;
  revokeShareLink: () => Promise<void>;
}

const LocationContext = createContext<LocationContextValue | null>(null);

function haversineMeters(aLat: number, aLng: number, bLat: number, bLng: number) {
  const R = 6371000;
  const toRad = (v: number) => (v * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLng - aLng);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function LocationProvider({ children }: { children: React.ReactNode }) {
  const { firebaseUser, profile } = useAuth();

  const [lat, setLat] = useState<number | null>(null);
  const [lng, setLng] = useState<number | null>(null);
  const [accuracyMeters, setAccuracyMeters] = useState<number | null>(null);
  const [address, setAddress] = useState('');
  const [city, setCity] = useState('');
  const [ward, setWard] = useState('');
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [gpsState, setGpsState] = useState<GpsState>('idle');
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [isManualOverride, setIsManualOverride] = useState(false);

  const [trackingState, setTrackingState] = useState<TrackingState>('idle');
  const [shareToken, setShareToken] = useState<string | null>(null);
  const [shareExpiresAt, setShareExpiresAt] = useState<string | null>(null);
  const [trackingHistory, setTrackingHistory] = useState<TrackingHistoryPoint[]>([]);

  const watchIdRef = useRef<number | null>(null);
  const lastGeocodedRef = useRef<{ lat: number; lng: number } | null>(null);
  const shareTokenRef = useRef<string | null>(null);
  const trackingStateRef = useRef<TrackingState>('idle');
  const lastPushRef = useRef<number>(0);

  shareTokenRef.current = shareToken;
  trackingStateRef.current = trackingState;

  useEffect(() => {
    const handleOffline = () => setGpsState('offline');
    const handleOnline = () => {
      if (lat !== null && lng !== null) setGpsState('acquired');
    };
    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);
    return () => {
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
    };
  }, [lat, lng]);

  const reverseLookup = useCallback(async (newLat: number, newLng: number, force = false): Promise<string> => {
    if (!force && lastGeocodedRef.current) {
      const moved = haversineMeters(
        lastGeocodedRef.current.lat,
        lastGeocodedRef.current.lng,
        newLat,
        newLng
      );
      if (moved < 35 && address) return address;
    }

    try {
      const res = await fetch(`/api/places/reverse?lat=${newLat}&lng=${newLng}`);
      if (!res.ok) throw new Error('Reverse geocode unavailable');
      const data = (await res.json()) as { address: string; city: string; ward: string };
      lastGeocodedRef.current = { lat: newLat, lng: newLng };
      setAddress(data.address);
      if (data.city) setCity(data.city);
      if (data.ward) setWard(data.ward);
      return data.address;
    } catch {
      const fallback = `GPS (${newLat.toFixed(5)}, ${newLng.toFixed(5)})`;
      setAddress(fallback);
      return fallback;
    }
  }, [address]);

  const pushTrackingUpdate = useCallback(
    async (
      token: string,
      status: 'active' | 'paused' | 'stopped' | 'revoked',
      uLat: number,
      uLng: number,
      uAcc: number,
      uAddr: string
    ) => {
      const nowIso = new Date().toISOString();
      try {
        await fetch('/api/tracking/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            shareToken: token,
            ownerUid: firebaseUser?.uid || 'citizen',
            ownerDisplayName: profile?.displayName || firebaseUser?.displayName || 'SEVA Citizen',
            status,
            lat: uLat,
            lng: uLng,
            accuracyMeters: uAcc,
            address: uAddr,
          }),
        });
      } catch {
        // Ignore transient tracking relay errors
      }

      if (firebaseUser) {
        const sessionRef = doc(db, 'trackingSessions', token);
        try {
          await updateDoc(sessionRef, {
            status,
            lat: uLat,
            lng: uLng,
            accuracyMeters: uAcc,
            address: uAddr.slice(0, 300),
            updatedAt: serverTimestamp(),
          });
        } catch {
          // Document might not exist yet if started before auth settled
        }
      }

      if (status === 'active') {
        setTrackingHistory((prev) => [
          ...prev.slice(-49),
          { lat: uLat, lng: uLng, accuracyMeters: uAcc, address: uAddr, timestamp: nowIso },
        ]);
      }
    },
    [firebaseUser, profile?.displayName]
  );

  const requestCurrentLocation = useCallback(async () => {
    if (!navigator.onLine) {
      setGpsState('offline');
      setGpsError('Network is disconnected. Please reconnect to resolve address details.');
    }
    if (!('geolocation' in navigator)) {
      setGpsState('unavailable');
      setGpsError('Browser geolocation is unavailable on this device.');
      return null;
    }

    setGpsState('requesting');
    setGpsError(null);

    return new Promise<{ lat: number; lng: number; address: string } | null>((resolve) => {
      setGpsState('acquiring');
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          const { latitude, longitude, accuracy } = pos.coords;
          setIsManualOverride(false);
          setLat(latitude);
          setLng(longitude);
          setAccuracyMeters(Math.round(accuracy));
          setLastUpdated(new Date().toISOString());
          setGpsState(accuracy > 150 ? 'weak' : 'acquired');

          const resolvedAddr = await reverseLookup(latitude, longitude, true);
          resolve({ lat: latitude, lng: longitude, address: resolvedAddr });
        },
        (err) => {
          if (err.code === err.PERMISSION_DENIED) {
            setGpsState('denied');
            setGpsError('Location permission was denied. Enable browser location permission or select a point manually on the map.');
          } else if (err.code === err.POSITION_UNAVAILABLE) {
            setGpsState('unavailable');
            setGpsError('GPS position is currently unavailable. Move near an open window or select location manually.');
          } else {
            setGpsState('weak');
            setGpsError('GPS request timed out. Please retry or select a point on the map.');
          }
          resolve(null);
        },
        {
          enableHighAccuracy: true,
          timeout: 15000,
          maximumAge: 10000,
        }
      );
    });
  }, [reverseLookup]);

  const setManualLocation = useCallback(
    async (newLat: number, newLng: number, label?: string) => {
      setIsManualOverride(true);
      setLat(newLat);
      setLng(newLng);
      setAccuracyMeters(null);
      setLastUpdated(new Date().toISOString());
      setGpsState('acquired');
      setGpsError(null);
      if (label) {
        setAddress(label);
      } else {
        await reverseLookup(newLat, newLng, true);
      }
    },
    [reverseLookup]
  );

  const clearWatch = () => {
    if (watchIdRef.current !== null && 'geolocation' in navigator) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
  };

  const beginWatcher = useCallback(
    (token: string) => {
      clearWatch();
      if (!('geolocation' in navigator)) return;

      watchIdRef.current = navigator.geolocation.watchPosition(
        async (pos) => {
          if (trackingStateRef.current !== 'active') return;
          const now = Date.now();
          if (now - lastPushRef.current < 3000) return;
          lastPushRef.current = now;

          const { latitude, longitude, accuracy } = pos.coords;
          setIsManualOverride(false);
          setLat(latitude);
          setLng(longitude);
          setAccuracyMeters(Math.round(accuracy));
          setLastUpdated(new Date().toISOString());
          setGpsState(accuracy > 150 ? 'weak' : accuracy > 45 ? 'improving' : 'acquired');

          const resolvedAddr = await reverseLookup(latitude, longitude);
          await pushTrackingUpdate(token, 'active', latitude, longitude, Math.round(accuracy), resolvedAddr);
        },
        (err) => {
          if (err.code === err.PERMISSION_DENIED) {
            setGpsState('denied');
            setGpsError('Location permission denied during live tracking.');
          } else {
            setGpsState('weak');
          }
        },
        {
          enableHighAccuracy: true,
          timeout: 15000,
          maximumAge: 3000,
        }
      );
    },
    [pushTrackingUpdate, reverseLookup]
  );

  const startLiveTracking = useCallback(
    async (_createShare = true): Promise<string | null> => {
      const current = lat !== null && lng !== null ? { lat, lng, address } : await requestCurrentLocation();
      if (!current) return null;

      const token = `trk_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      const expiresIso = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

      setShareToken(token);
      setShareExpiresAt(expiresIso);
      setTrackingState('active');
      trackingStateRef.current = 'active';
      shareTokenRef.current = token;

      if (firebaseUser) {
        try {
          await setDoc(doc(db, 'trackingSessions', token), {
            uid: firebaseUser.uid,
            shareToken: token,
            status: 'active',
            lat: current.lat,
            lng: current.lng,
            accuracyMeters: accuracyMeters || 25,
            address: (current.address || '').slice(0, 300),
            expiresAt: expiresIso,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          buildFirestoreErrorInfo(err, OperationType.CREATE, `trackingSessions/${token}`);
        }
      }

      await pushTrackingUpdate(
        token,
        'active',
        current.lat,
        current.lng,
        accuracyMeters || 25,
        current.address
      );
      beginWatcher(token);
      return token;
    },
    [accuracyMeters, address, beginWatcher, firebaseUser, lat, lng, pushTrackingUpdate, requestCurrentLocation]
  );

  const pauseLiveTracking = useCallback(() => {
    setTrackingState('paused');
    trackingStateRef.current = 'paused';
    clearWatch();
    if (shareTokenRef.current && lat !== null && lng !== null) {
      pushTrackingUpdate(shareTokenRef.current, 'paused', lat, lng, accuracyMeters || 0, address);
    }
  }, [accuracyMeters, address, lat, lng, pushTrackingUpdate]);

  const resumeLiveTracking = useCallback(() => {
    if (!shareTokenRef.current) return;
    setTrackingState('active');
    trackingStateRef.current = 'active';
    beginWatcher(shareTokenRef.current);
  }, [beginWatcher]);

  const stopLiveTracking = useCallback(async () => {
    clearWatch();
    setTrackingState('stopped');
    trackingStateRef.current = 'stopped';
    if (shareTokenRef.current && lat !== null && lng !== null) {
      await pushTrackingUpdate(shareTokenRef.current, 'stopped', lat, lng, accuracyMeters || 0, address);
    }
  }, [accuracyMeters, address, lat, lng, pushTrackingUpdate]);

  const revokeShareLink = useCallback(async () => {
    clearWatch();
    setTrackingState('idle');
    trackingStateRef.current = 'idle';
    if (shareTokenRef.current && lat !== null && lng !== null) {
      await pushTrackingUpdate(shareTokenRef.current, 'revoked', lat, lng, accuracyMeters || 0, address);
    }
    setShareToken(null);
    setShareExpiresAt(null);
  }, [accuracyMeters, address, lat, lng, pushTrackingUpdate]);

  useEffect(() => {
    return () => clearWatch();
  }, []);

  return (
    <LocationContext.Provider
      value={{
        lat,
        lng,
        accuracyMeters,
        address,
        city,
        ward,
        lastUpdated,
        gpsState,
        gpsError,
        isManualOverride,
        trackingState,
        shareToken,
        shareExpiresAt,
        trackingHistory,
        requestCurrentLocation,
        setManualLocation,
        startLiveTracking,
        pauseLiveTracking,
        resumeLiveTracking,
        stopLiveTracking,
        revokeShareLink,
      }}
    >
      {children}
    </LocationContext.Provider>
  );
}

export function useLocationEngine() {
  const ctx = useContext(LocationContext);
  if (!ctx) throw new Error('useLocationEngine must be used inside LocationProvider');
  return ctx;
}
