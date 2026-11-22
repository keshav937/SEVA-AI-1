import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Clock,
  ExternalLink,
  Loader2,
  MapPin,
  Navigation,
  Phone,
  RefreshCw,
} from 'lucide-react';
import { useLocationEngine } from '../contexts/LocationContext';
import { NearbyPlace } from '../types/seva';
import { LeafletMap, MapMarkerItem } from './LeafletMap';

const NEARBY_CATEGORIES = [
  { key: 'healthcare', label: 'Healthcare', color: '#DC2626' },
  { key: 'public_safety', label: 'Public Safety', color: '#1D4ED8' },
  { key: 'education', label: 'Education', color: '#7C3AED' },
  { key: 'food', label: 'Food & Restaurants', color: '#D97706' },
  { key: 'public_places', label: 'Public Places', color: '#059669' },
  { key: 'transport', label: 'Transport', color: '#0284C7' },
  { key: 'shopping', label: 'Shopping', color: '#DB2777' },
  { key: 'government', label: 'Government Services', color: '#14532D' },
  { key: 'other', label: 'Banks, ATMs & Other', color: '#475569' },
];

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

export const ExploreCityView: React.FC = () => {
  const { lat, lng, address, accuracyMeters, gpsState, gpsError, requestCurrentLocation, setManualLocation } =
    useLocationEngine();

  const [selectedCategories, setSelectedCategories] = useState<string[]>(['healthcare', 'public_safety', 'public_places']);
  const [radiusMeters, setRadiusMeters] = useState<number>(2000);
  const [customKm, setCustomKm] = useState<string>('');
  const [customRadiusError, setCustomRadiusError] = useState<string | null>(null);
  const [places, setPlaces] = useState<NearbyPlace[]>([]);
  const [providerName, setProviderName] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [selectedPlaceId, setSelectedPlaceId] = useState<string | null>(null);
  const [searchText, setSearchText] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  // Auto-request live GPS on mount if idle
  useEffect(() => {
    if (lat === null && lng === null && gpsState === 'idle') {
      requestCurrentLocation();
    }
  }, [lat, lng, gpsState, requestCurrentLocation]);

  const loadPlaces = useCallback(
    async (forceRefresh = false) => {
      if (lat === null || lng === null || selectedCategories.length === 0) return;
      if (abortRef.current) abortRef.current.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setLoading(true);
      setFetchError(null);
      try {
        const qs = new URLSearchParams({
          lat: String(lat),
          lng: String(lng),
          radius: String(radiusMeters),
          categories: selectedCategories.join(','),
          ...(forceRefresh ? { refresh: 'true' } : {}),
        });
        const res = await fetch(`/api/places/nearby?${qs.toString()}`, {
          signal: controller.signal,
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || 'Failed to retrieve nearby places.');
        }
        const list: NearbyPlace[] = Array.isArray(data.places) ? data.places : [];
        const strictlyBounded = list
          .filter((p) => p.distanceMeters <= radiusMeters)
          .sort((a, b) => a.distanceMeters - b.distanceMeters);
        setPlaces(strictlyBounded);
        setProviderName(data.provider || 'OpenStreetMap Overpass API');
      } catch (err: any) {
        if (err?.name === 'AbortError') return;
        setFetchError(err?.message || 'Unable to query nearby places right now.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [lat, lng, radiusMeters, selectedCategories]
  );

  useEffect(() => {
    if (lat !== null && lng !== null) {
      loadPlaces(false);
    }
    return () => abortRef.current?.abort();
  }, [lat, lng, radiusMeters, selectedCategories, loadPlaces]);

  const toggleCategory = (key: string) => {
    setSelectedCategories((prev) =>
      prev.includes(key) ? (prev.length > 1 ? prev.filter((k) => k !== key) : prev) : [...prev, key]
    );
  };

  const applyCustomRadius = (e: React.FormEvent) => {
    e.preventDefault();
    setCustomRadiusError(null);
    const km = Number(customKm);
    if (!Number.isFinite(km) || km < 0.2 || km > 50) {
      setCustomRadiusError('Enter a custom radius between 0.2 and 50 km.');
      return;
    }
    setRadiusMeters(Math.round(km * 1000));
  };

  const filteredPlaces = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    if (!q) return places;
    return places.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.subcategory.toLowerCase().includes(q) ||
        p.address.toLowerCase().includes(q)
    );
  }, [places, searchText]);

  const markers: MapMarkerItem[] = useMemo(() => {
    return filteredPlaces.map((p) => {
      const catMeta = NEARBY_CATEGORIES.find((c) => c.key === p.category);
      return {
        id: p.id,
        lat: p.lat,
        lng: p.lng,
        title: p.name,
        subtitle: `${p.subcategory} · ${
          p.distanceMeters >= 1000
            ? `${(p.distanceMeters / 1000).toFixed(2)} km`
            : `${p.distanceMeters} m`
        }`,
        color: catMeta?.color || '#059669',
        directionsUrl: buildGoogleMapsNavUrl(lat, lng, p.lat, p.lng, p.directionsUrl),
      };
    });
  }, [filteredPlaces, lat, lng]);

  const isGpsBusy = gpsState === 'requesting' || gpsState === 'acquiring' || gpsState === 'improving';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900">
            Explore My City
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Real-time discovery of civic services, healthcare, safety centres, transport, and public spaces around your live GPS coordinates.
          </p>
        </div>

        <button
          type="button"
          disabled={isGpsBusy}
          onClick={() => requestCurrentLocation()}
          className="inline-flex items-center gap-2 px-4 py-2.5 bg-green-900 text-white text-sm font-medium rounded-lg hover:bg-green-800 transition-colors whitespace-nowrap disabled:opacity-60"
        >
          {isGpsBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Navigation className="w-4 h-4" />}
          {isGpsBusy ? 'Detecting GPS...' : lat !== null ? 'Refresh Live GPS' : 'Use Live GPS'}
        </button>
      </div>

      {/* Location Status Strip */}
      <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-start gap-2.5 text-sm text-slate-700">
          <MapPin className="w-4 h-4 text-green-900 shrink-0 mt-0.5" />
          <div>
            {lat !== null && lng !== null ? (
              <>
                <span className="font-medium text-slate-900">{address || 'Current Location'}</span>
                <span className="text-xs text-slate-500 ml-2 font-mono tabular-nums">
                  ({lat.toFixed(5)}, {lng.toFixed(5)}
                  {accuracyMeters ? ` · ±${accuracyMeters}m` : ''})
                </span>
              </>
            ) : (
              <span>
                {isGpsBusy
                  ? 'Requesting browser permission and acquiring your live GPS coordinates...'
                  : 'GPS coordinates not yet acquired. Click Use Live GPS or click anywhere on a map to sense nearby services.'}
              </span>
            )}
          </div>
        </div>
        {providerName && (
          <div className="text-xs text-slate-500">
            Data: {providerName} · {filteredPlaces.length} results within {formatRadiusLabel(radiusMeters)}
          </div>
        )}
      </div>

      {gpsError && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
          <div className="flex items-start gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{gpsError}</span>
          </div>
          <button
            type="button"
            onClick={() => requestCurrentLocation()}
            className="px-2.5 py-1 bg-amber-900 text-white rounded font-semibold shrink-0 hover:bg-amber-800"
          >
            Retry Location
          </button>
        </div>
      )}

      {/* Category Multi-Select & Radius Controls */}
      <div className="border border-slate-200 rounded-xl bg-white p-4 space-y-4">
        <div>
          <div className="text-xs font-semibold text-slate-700 mb-2">
            Categories (Select one or more)
          </div>
          <div className="flex flex-wrap gap-2">
            {NEARBY_CATEGORIES.map((cat) => {
              const active = selectedCategories.includes(cat.key);
              return (
                <button
                  key={cat.key}
                  type="button"
                  onClick={() => toggleCategory(cat.key)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap ${
                    active
                      ? 'bg-green-900 text-white border-green-900'
                      : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  {cat.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="pt-3 border-t border-slate-200 flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-semibold text-slate-700 mr-1">
              Radius ({formatRadiusLabel(radiusMeters)}):
            </span>
            {RADIUS_PRESETS.map((r) => (
              <button
                key={r.meters}
                type="button"
                onClick={() => {
                  setCustomRadiusError(null);
                  setRadiusMeters(r.meters);
                }}
                className={`px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap tabular-nums ${
                  radiusMeters === r.meters
                    ? 'bg-emerald-700 text-white'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>

          <div className="flex flex-col items-end gap-1">
            <form onSubmit={applyCustomRadius} className="flex items-center gap-2">
              <input
                type="number"
                step="0.5"
                min="0.2"
                max="50"
                value={customKm}
                onChange={(e) => setCustomKm(e.target.value)}
                placeholder="Custom km"
                aria-label="Custom search radius in km"
                className="w-28 text-xs border border-slate-200 rounded-md px-2.5 py-1.5 text-slate-900"
              />
              <button
                type="submit"
                className="px-3 py-1.5 text-xs font-medium bg-slate-900 text-white rounded-md hover:bg-slate-800"
              >
                Set Custom
              </button>
            </form>
            {customRadiusError && <span className="text-[11px] text-red-700">{customRadiusError}</span>}
          </div>
        </div>
      </div>

      {/* Main Split: Interactive Map + Results List */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-7 space-y-2">
          {lat !== null && lng !== null ? (
            <LeafletMap
              centerLat={lat}
              centerLng={lng}
              zoom={
                radiusMeters <= 1500
                  ? 15
                  : radiusMeters <= 3000
                  ? 14
                  : radiusMeters <= 7000
                  ? 13
                  : radiusMeters <= 16000
                  ? 12
                  : 11
              }
              userLat={lat}
              userLng={lng}
              userAccuracyMeters={accuracyMeters}
              searchRadiusMeters={radiusMeters}
              markers={markers}
              selectedMarkerId={selectedPlaceId}
              onMapClick={(clickLat, clickLng) => setManualLocation(clickLat, clickLng)}
              heightClass="h-[460px]"
            />
          ) : (
            <div className="h-[460px] rounded-xl border border-slate-200 bg-slate-50 flex flex-col items-center justify-center p-6 text-center">
              <MapPin className="w-8 h-8 text-green-900 mb-3" />
              <p className="text-base font-semibold text-slate-900">
                Acquire Your GPS Location to Explore Nearby Services
              </p>
              <p className="text-sm text-slate-600 mt-1 max-w-md mb-4">
                SEVA AI never guesses or hardcodes your city. Allow location sensing to discover real hospitals, police stations, parks, schools, and transit stops near you.
              </p>
              <button
                type="button"
                onClick={() => requestCurrentLocation()}
                className="px-4 py-2.5 bg-green-900 text-white text-sm font-medium rounded-lg hover:bg-green-800"
              >
                Sense My Location Now
              </button>
            </div>
          )}
          <p className="text-xs text-slate-500">
            Tip: Click anywhere on the map if GPS is unavailable to inspect nearby places around that point.
          </p>
        </div>

        <div className="lg:col-span-5 space-y-3">
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="Filter retrieved places by name or street..."
              className="flex-1 text-sm border border-slate-200 rounded-lg px-3 py-2 bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-green-800"
            />
            <button
              type="button"
              onClick={() => loadPlaces(true)}
              disabled={loading || lat === null}
              aria-label="Refresh nearby places"
              className="p-2.5 border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 text-slate-700 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {fetchError && (
            <div className="text-xs text-red-800 bg-red-50 border border-red-200 rounded-lg p-3 flex items-center justify-between gap-2">
              <span>{fetchError}</span>
              <button type="button" onClick={() => loadPlaces(true)} className="font-semibold underline shrink-0">
                Retry
              </button>
            </div>
          )}

          {loading ? (
            <div className="border border-slate-200 rounded-xl p-8 flex flex-col items-center justify-center text-slate-600">
              <Loader2 className="w-6 h-6 animate-spin text-green-900 mb-2" />
              <p className="text-sm">Querying OpenStreetMap Overpass within {formatRadiusLabel(radiusMeters)}...</p>
            </div>
          ) : filteredPlaces.length === 0 ? (
            <div className="border border-slate-200 rounded-xl p-8 text-center text-sm text-slate-600 bg-slate-50">
              {lat === null
                ? 'Waiting for GPS coordinates.'
                : `No matching places found within ${formatRadiusLabel(radiusMeters)}. Try expanding the radius or selecting additional categories.`}
            </div>
          ) : (
            <div className="space-y-2.5 max-h-[410px] overflow-y-auto pr-1">
              {filteredPlaces.map((place) => {
                const navUrl = buildGoogleMapsNavUrl(lat, lng, place.lat, place.lng, place.directionsUrl);
                return (
                  <div
                    key={place.id}
                    className={`border rounded-xl p-3.5 transition-colors bg-white ${
                      selectedPlaceId === place.id ? 'border-green-900 bg-emerald-50/30' : 'border-slate-200'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <h4 className="font-display text-sm font-semibold text-slate-900">{place.name}</h4>
                        <div className="text-xs text-slate-500 capitalize mt-0.5">
                          {place.subcategory} ·{' '}
                          <span className="font-mono tabular-nums text-green-900 font-medium">
                            {place.distanceMeters >= 1000
                              ? `${(place.distanceMeters / 1000).toFixed(2)} km`
                              : `${place.distanceMeters} m`}
                          </span>
                        </div>
                      </div>
                    </div>

                    <p className="text-xs text-slate-600 mt-1.5">{place.address}</p>

                    {(place.phone || place.openingHours) && (
                      <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-600">
                        {place.phone && (
                          <a href={`tel:${place.phone}`} className="inline-flex items-center gap-1 hover:underline">
                            <Phone className="w-3 h-3" />
                            {place.phone}
                          </a>
                        )}
                        {place.openingHours && (
                          <span className="inline-flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {place.openingHours}
                          </span>
                        )}
                      </div>
                    )}

                    <div className="mt-2.5 pt-2 border-t border-slate-100 flex items-center gap-4 text-xs font-medium">
                      <button
                        type="button"
                        onClick={() => setSelectedPlaceId(place.id)}
                        className="text-green-900 hover:underline"
                      >
                        View on Map
                      </button>
                      <a
                        href={navUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-slate-700 hover:text-slate-900 hover:underline"
                      >
                        Navigate (Google Maps)
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
