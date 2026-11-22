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
  | 'timeout'
  | 'unavailable'
  | 'offline';

export type PermissionStateValue = 'granted' | 'prompt' | 'denied' | 'unknown';

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
  permissionState: PermissionStateValue;
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

function isValidCoord(val: number): boolean {
  return typeof val === 'number' && Number.isFinite(val);
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
  const [permissionState, setPermissionState] = useState<PermissionStateValue>('unknown');
  const [isManualOverride, setIsManualOverride] = useState(false);

  const [trackingState, setTrackingState] = useState<TrackingState>('idle');
  const [shareToken, setShareToken] = useState<string | null>(null);
  const [shareExpiresAt, setShareExpiresAt] = useState<string | null>(null);
  const [trackingHistory, setTrackingHistory] = useState<TrackingHistoryPoint[]>([]);

  const watchIdRef = useRef<number | null>(null);
  const passiveWatchIdRef = useRef<number | null>(null);
  const lastGeocodedRef = useRef<{ lat: number; lng: number } | null>(null);
  const lastPositionRef = useRef<{ lat: number; lng: number; accuracy: number } | null>(null);
  const addressRef = useRef<string>('');
  const shareTokenRef = useRef<string | null>(null);
  const trackingStateRef = useRef<TrackingState>('idle');
  const isManualOverrideRef = useRef<boolean>(false);
  const lastPushRef = useRef<number>(0);
  const inFlightLocationRef = useRef<Promise<{ lat: number; lng: number; address: string } | null> | null>(null);

  shareTokenRef.current = shareToken;
  trackingStateRef.current = trackingState;
  isManualOverrideRef.current = isManualOverride;
  addressRef.current = address;

  useEffect(() => {
    const handleOffline = () => {
      setGpsState('offline');
      setGpsError('Network connection lost. Address reverse geocoding and nearby search require connectivity.');
    };
    const handleOnline = () => {
      setGpsError((prev) =>
        prev && prev.includes('Network connection lost') ? null : prev
      );
      if (lat !== null && lng !== null) {
        setGpsState(accuracyMeters && accuracyMeters > 150 ? 'weak' : 'acquired');
      } else {
        setGpsState((prev) => (prev === 'offline' ? 'idle' : prev));
      }
    };
    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);
    return () => {
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
    };
  }, [accuracyMeters, lat, lng]);

  const reverseLookup = useCallback(async (newLat: number, newLng: number, force = false): Promise<string> => {
    if (!force && lastGeocodedRef.current && addressRef.current) {
      const moved = haversineMeters(
        lastGeocodedRef.current.lat,
        lastGeocodedRef.current.lng,
        newLat,
        newLng
      );
      if (moved < 35) return addressRef.current;
    }

    try {
      const res = await fetch(`/api/places/reverse?lat=${encodeURIComponent(newLat)}&lng=${encodeURIComponent(newLng)}`);
      if (!res.ok) throw new Error('Reverse geocode unavailable');
      const data = (await res.json()) as { address: string; city: string; ward: string };
      lastGeocodedRef.current = { lat: newLat, lng: newLng };
      setAddress(data.address);
      setCity(data.city || '');
      setWard(data.ward || '');
      return data.address;
    } catch {
      const fallback = `GPS Coordinates (${newLat.toFixed(5)}, ${newLng.toFixed(5)})`;
      setAddress(fallback);
      return fallback;
    }
  }, []);

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

  const applyGpsCoordinates = useCallback(
    async (latitude: number, longitude: number, accuracy: number, forceReverse = false) => {
      const roundedAcc = Math.round(accuracy);
      setIsManualOverride(false);
      isManualOverrideRef.current = false;
      setLat(latitude);
      setLng(longitude);
      setAccuracyMeters(roundedAcc);
      setLastUpdated(new Date().toISOString());
      setGpsError(null);
      setGpsState(roundedAcc > 150 ? 'weak' : 'acquired');
      lastPositionRef.current = { lat: latitude, lng: longitude, accuracy: roundedAcc };
      const resolvedAddr = await reverseLookup(latitude, longitude, forceReverse);
      return { lat: latitude, lng: longitude, address: resolvedAddr };
    },
    [reverseLookup]
  );

  const requestCurrentLocation = useCallback(async () => {
    if (inFlightLocationRef.current) {
      return inFlightLocationRef.current;
    }

    if (!('geolocation' in navigator)) {
      setGpsState('unavailable');
      setGpsError('Browser geolocation is not supported on this device. Use manual locality search below.');
      return null;
    }

    setGpsState('requesting');
    setGpsError(null);

    const runRequest = async (): Promise<{ lat: number; lng: number; address: string } | null> => {
      setGpsState('acquiring');

      const getPosition = (options: PositionOptions) =>
        new Promise<GeolocationPosition>((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, options);
        });

      try {
        // First try strict high-accuracy GPS fix with maximumAge: 0 (no stale cached location)
        const pos = await getPosition({
          enableHighAccuracy: true,
          timeout: 15000,
          maximumAge: 0,
        });
        const { latitude, longitude, accuracy } = pos.coords;
        if (!isValidCoord(latitude) || !isValidCoord(longitude)) {
          throw { code: 2, message: 'Invalid GPS coordinates returned by browser.' };
        }
        setPermissionState('granted');
        return await applyGpsCoordinates(latitude, longitude, accuracy, true);
      } catch (err: any) {
        if (err?.code === 1) {
          setPermissionState('denied');
          setGpsState('denied');
          setGpsError(
            'Location permission was denied. Enable browser/device location access for SEVA AI and click Retry, or enter your locality manually.'
          );
          return null;
        }

        if (err?.code === 3) {
          // High-accuracy hardware GPS timed out (common indoors on desktops/mobile) — try standard accuracy once
          setGpsState('improving');
          try {
            const fallbackPos = await getPosition({
              enableHighAccuracy: false,
              timeout: 10000,
              maximumAge: 0,
            });
            const { latitude, longitude, accuracy } = fallbackPos.coords;
            if (isValidCoord(latitude) && isValidCoord(longitude)) {
              setPermissionState('granted');
              return await applyGpsCoordinates(latitude, longitude, accuracy, true);
            }
          } catch (fallbackErr: any) {
            if (fallbackErr?.code === 1) {
              setPermissionState('denied');
              setGpsState('denied');
              setGpsError(
                'Location permission was denied. Enable browser location access and click Retry.'
              );
              return null;
            }
          }
          setGpsState('timeout');
          setGpsError(
            'GPS signal request timed out. Ensure device Location Services are turned on and click Retry Location.'
          );
          return null;
        }

        if (!navigator.onLine) {
          setGpsState('offline');
          setGpsError('Network is disconnected and device GPS position could not be resolved.');
          return null;
        }

        setGpsState('unavailable');
        setGpsError(
          'Unable to detect device GPS coordinates right now. Check device Location Services and click Retry, or search your area manually.'
        );
        return null;
      }
    };

    const promise = runRequest().finally(() => {
      inFlightLocationRef.current = null;
    });
    inFlightLocationRef.current = promise;
    return promise;
  }, [applyGpsCoordinates]);

  // Monitor browser geolocation permission state & react to permission changes
  useEffect(() => {
    let mounted = true;
    let statusObj: PermissionStatus | null = null;

    if ('permissions' in navigator && typeof navigator.permissions.query === 'function') {
      navigator.permissions
        .query({ name: 'geolocation' })
        .then((perm) => {
          if (!mounted) return;
          statusObj = perm;
          setPermissionState(perm.state);
          if (perm.state === 'denied') {
            setGpsState('denied');
            setGpsError(
              'Location permission is currently blocked in your browser. Allow location access in site settings and click Retry.'
            );
          }
          perm.onchange = () => {
            if (!mounted) return;
            setPermissionState(perm.state);
            if (perm.state === 'granted') {
              setGpsError(null);
              requestCurrentLocation();
            } else if (perm.state === 'denied') {
              if (passiveWatchIdRef.current !== null && 'geolocation' in navigator) {
                navigator.geolocation.clearWatch(passiveWatchIdRef.current);
                passiveWatchIdRef.current = null;
              }
              setGpsState('denied');
              setGpsError(
                'Location permission was revoked. Re-enable location access in browser settings to resume live GPS sensing.'
              );
            }
          };
        })
        .catch(() => {
          // Permissions API unsupported or blocked in browser
        });
    }

    return () => {
      mounted = false;
      if (statusObj) statusObj.onchange = null;
    };
  }, [requestCurrentLocation]);

  // Passive live movement watcher once GPS is acquired (when not manually overridden or actively share-tracking)
  useEffect(() => {
    const clearPassive = () => {
      if (passiveWatchIdRef.current !== null && 'geolocation' in navigator) {
        navigator.geolocation.clearWatch(passiveWatchIdRef.current);
        passiveWatchIdRef.current = null;
      }
    };

    const gpsReady =
      lat !== null &&
      lng !== null &&
      !isManualOverride &&
      trackingState !== 'active' &&
      permissionState !== 'denied' &&
      'geolocation' in navigator;

    if (!gpsReady) {
      clearPassive();
      return;
    }

    passiveWatchIdRef.current = navigator.geolocation.watchPosition(
      async (pos) => {
        if (isManualOverrideRef.current || trackingStateRef.current === 'active') return;
        const { latitude, longitude, accuracy } = pos.coords;
        if (!isValidCoord(latitude) || !isValidCoord(longitude)) return;

        const roundedAcc = Math.round(accuracy);
        const prev = lastPositionRef.current;
        if (prev) {
          const moved = haversineMeters(prev.lat, prev.lng, latitude, longitude);
          const accImproved = prev.accuracy - roundedAcc >= 25 && roundedAcc <= 150;
          if (moved < 40 && !accImproved) return;
          await applyGpsCoordinates(latitude, longitude, roundedAcc, moved >= 40);
        } else {
          await applyGpsCoordinates(latitude, longitude, roundedAcc, true);
        }
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          setPermissionState('denied');
          setGpsState('denied');
          setGpsError('Location permission denied. Enable location access to update live position.');
        }
      },
      {
        enableHighAccuracy: true,
        timeout: 20000,
        maximumAge: 5000,
      }
    );

    return clearPassive;
  }, [applyGpsCoordinates, isManualOverride, lat, lng, permissionState, trackingState]);

  const setManualLocation = useCallback(
    async (newLat: number, newLng: number, label?: string) => {
      setIsManualOverride(true);
      isManualOverrideRef.current = true;
      setLat(newLat);
      setLng(newLng);
      setAccuracyMeters(null);
      setLastUpdated(new Date().toISOString());
      setGpsState('acquired');
      setGpsError(null);
      if (label) {
        setAddress(label);
        lastGeocodedRef.current = { lat: newLat, lng: newLng };
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
          const roundedAcc = Math.round(accuracy);
          setIsManualOverride(false);
          setLat(latitude);
          setLng(longitude);
          setAccuracyMeters(roundedAcc);
          setLastUpdated(new Date().toISOString());
          setGpsState(roundedAcc > 150 ? 'weak' : roundedAcc > 45 ? 'improving' : 'acquired');
          lastPositionRef.current = { lat: latitude, lng: longitude, accuracy: roundedAcc };

          const resolvedAddr = await reverseLookup(latitude, longitude);
          await pushTrackingUpdate(token, 'active', latitude, longitude, roundedAcc, resolvedAddr);
        },
        (err) => {
          if (err.code === err.PERMISSION_DENIED) {
            setPermissionState('denied');
            setGpsState('denied');
            setGpsError('Location permission denied during live tracking.');
          } else if (err.code === err.TIMEOUT) {
            setGpsState('timeout');
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
    return () => {
      clearWatch();
      if (passiveWatchIdRef.current !== null && 'geolocation' in navigator) {
        navigator.geolocation.clearWatch(passiveWatchIdRef.current);
      }
    };
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
        permissionState,
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
