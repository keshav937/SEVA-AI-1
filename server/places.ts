export type NearbyCategoryKey =
  | 'healthcare'
  | 'public_safety'
  | 'education'
  | 'food'
  | 'public_places'
  | 'transport'
  | 'shopping'
  | 'government'
  | 'other';

export type NearbySearchMode =
  | 'general'
  | 'medical_facilities'
  | 'police_only'
  | 'strict_medical_safety';

export interface NearbyPlaceResult {
  id: string;
  name: string;
  category: NearbyCategoryKey;
  subcategory: string;
  address: string;
  lat: number;
  lng: number;
  distanceMeters: number;
  phone?: string;
  openingHours?: string;
  website?: string;
  directionsUrl: string;
}

export class PlacesProviderError extends Error {
  code: 'NETWORK_TIMEOUT' | 'UPSTREAM_FETCH_FAILED';
  httpStatus: number;

  constructor(
    message: string,
    code: 'NETWORK_TIMEOUT' | 'UPSTREAM_FETCH_FAILED' = 'UPSTREAM_FETCH_FAILED',
    httpStatus = 502
  ) {
    super(message);
    this.name = 'PlacesProviderError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
];

const CATEGORY_FILTERS: Record<NearbyCategoryKey, Array<[string, string]>> = {
  healthcare: [
    ['amenity', 'hospital'],
    ['healthcare', 'hospital'],
    ['amenity', 'clinic'],
    ['healthcare', 'clinic'],
    ['healthcare', 'centre'],
    ['amenity', 'doctors'],
    ['emergency', 'ambulance_station'],
    ['amenity', 'pharmacy'],
    ['healthcare', 'diagnostic'],
  ],
  public_safety: [
    ['amenity', 'police'],
    ['amenity', 'fire_station'],
    ['emergency', 'ambulance_station'],
  ],
  education: [
    ['amenity', 'school'],
    ['amenity', 'college'],
    ['amenity', 'university'],
    ['amenity', 'library'],
  ],
  food: [
    ['amenity', 'restaurant'],
    ['amenity', 'cafe'],
    ['amenity', 'fast_food'],
    ['shop', 'bakery'],
    ['tourism', 'hotel'],
  ],
  public_places: [
    ['leisure', 'park'],
    ['leisure', 'garden'],
    ['leisure', 'playground'],
    ['amenity', 'toilets'],
    ['amenity', 'community_centre'],
  ],
  transport: [
    ['amenity', 'bus_station'],
    ['highway', 'bus_stop'],
    ['railway', 'station'],
    ['railway', 'subway_entrance'],
    ['amenity', 'taxi'],
    ['amenity', 'parking'],
    ['aeroway', 'aerodrome'],
  ],
  shopping: [
    ['shop', 'mall'],
    ['shop', 'supermarket'],
    ['amenity', 'marketplace'],
    ['shop', 'convenience'],
    ['shop', 'department_store'],
  ],
  government: [
    ['amenity', 'townhall'],
    ['amenity', 'courthouse'],
    ['amenity', 'post_office'],
    ['office', 'government'],
  ],
  other: [
    ['amenity', 'bank'],
    ['amenity', 'atm'],
    ['amenity', 'fuel'],
    ['amenity', 'place_of_worship'],
    ['leisure', 'sports_centre'],
    ['tourism', 'attraction'],
  ],
};

const MEDICAL_FACILITY_FILTERS: Array<[string, string]> = [
  ['amenity', 'hospital'],
  ['healthcare', 'hospital'],
  ['amenity', 'clinic'],
  ['healthcare', 'clinic'],
  ['healthcare', 'centre'],
  ['amenity', 'doctors'],
  ['emergency', 'ambulance_station'],
];

const POLICE_FILTERS: Array<[string, string]> = [['amenity', 'police']];

export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function buildGoogleMapsDirectionsUrl(
  originLat: number,
  originLng: number,
  destLat: number,
  destLng: number
): string {
  return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(
    `${originLat},${originLng}`
  )}&destination=${encodeURIComponent(`${destLat},${destLng}`)}&travelmode=driving`;
}

function normalizePlaceName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isTimeoutError(err: any): boolean {
  const name = String(err?.name || '');
  const msg = String(err?.message || '').toLowerCase();
  return (
    name === 'TimeoutError' ||
    name === 'AbortError' ||
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('aborted')
  );
}

function classifyMedicalSubcategory(tags: Record<string, string>): string | null {
  if (tags.amenity === 'hospital' || tags.healthcare === 'hospital') return 'hospital';
  if (tags.emergency === 'ambulance_station') return 'emergency medical';
  if (tags.amenity === 'clinic' || tags.healthcare === 'clinic') return 'clinic';
  if (tags.healthcare === 'centre' || tags.healthcare === 'center') return 'medical centre';
  if (tags.amenity === 'doctors' || tags.healthcare === 'doctor') return 'medical centre';
  if (tags.healthcare === 'diagnostic') return 'diagnostic centre';
  return null;
}

function classifyElement(
  tags: Record<string, string>,
  requested: NearbyCategoryKey[],
  mode: NearbySearchMode
): {
  category: NearbyCategoryKey;
  subcategory: string;
} | null {
  if (mode === 'police_only') {
    if (tags.amenity === 'police') {
      return { category: 'public_safety', subcategory: 'police station' };
    }
    return null;
  }

  if (mode === 'medical_facilities') {
    const medSub = classifyMedicalSubcategory(tags);
    if (!medSub) return null;
    return { category: 'healthcare', subcategory: medSub };
  }

  if (mode === 'strict_medical_safety') {
    if (tags.amenity === 'police') {
      return { category: 'public_safety', subcategory: 'police station' };
    }
    const medSub = classifyMedicalSubcategory(tags);
    if (medSub) return { category: 'healthcare', subcategory: medSub };
    return null;
  }

  for (const cat of requested) {
    const pairs = CATEGORY_FILTERS[cat];
    for (const [k, v] of pairs) {
      if (tags[k] === v) {
        if (v === 'police') return { category: cat, subcategory: 'police station' };
        if (v === 'centre') return { category: cat, subcategory: 'medical centre' };
        if (v === 'ambulance_station') return { category: cat, subcategory: 'emergency medical' };
        return { category: cat, subcategory: v.replace(/_/g, ' ') };
      }
    }
  }
  const sub =
    tags.amenity ||
    tags.shop ||
    tags.leisure ||
    tags.railway ||
    tags.tourism ||
    tags.office ||
    tags.healthcare ||
    'civic place';
  return { category: requested[0] || 'other', subcategory: sub.replace(/_/g, ' ') };
}

function formatOsmAddress(tags: Record<string, string>): string {
  if (tags['addr:full'] && tags['addr:full'].trim()) return tags['addr:full'].trim();
  const streetPart = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ').trim();
  const parts = [
    tags['addr:housename'],
    streetPart,
    tags['addr:suburb'] || tags['addr:neighbourhood'] || tags['addr:locality'],
    tags['addr:city'] || tags['addr:town'] || tags['addr:village'] || tags['addr:district'],
    tags['addr:state'],
    tags['addr:postcode'],
  ].filter((p) => Boolean(p && p.trim()));
  if (parts.length > 0) return parts.join(', ');
  return 'Address not listed in OpenStreetMap';
}

function formatNominatimAddress(item: {
  display_name?: string;
  address?: Record<string, string>;
}): string {
  const a = item.address || {};
  const parts = [
    a.house_number && a.road ? `${a.house_number} ${a.road}` : a.road,
    a.suburb || a.neighbourhood || a.quarter || a.city_district,
    a.city || a.town || a.village || a.state_district,
    a.state,
    a.postcode,
  ].filter((v) => Boolean(v && v.trim()));
  if (parts.length >= 2) return parts.join(', ');
  if (item.display_name) return item.display_name;
  return 'Address not listed in OpenStreetMap';
}

function formatPhotonAddress(p: Record<string, any>): string {
  const streetPart = [p.housenumber, p.street].filter(Boolean).join(' ').trim();
  const parts = [
    streetPart,
    p.locality || p.district,
    p.city || p.town || p.village || p.county,
    p.state,
    p.postcode,
  ].filter((v) => typeof v === 'string' && v.trim().length > 0);
  if (parts.length > 0) return parts.join(', ');
  if (typeof p.country === 'string' && p.country.trim()) return p.country.trim();
  return 'Address not listed in OpenStreetMap';
}

function deduplicatePlaces(candidates: NearbyPlaceResult[]): NearbyPlaceResult[] {
  const sorted = [...candidates].sort((a, b) => a.distanceMeters - b.distanceMeters);
  const accepted: NearbyPlaceResult[] = [];

  for (const item of sorted) {
    const normName = normalizePlaceName(item.name);
    const existingIdx = accepted.findIndex((prev) => {
      if (prev.category !== item.category) return false;
      const distBetween = haversineMeters(prev.lat, prev.lng, item.lat, item.lng);
      const prevNorm = normalizePlaceName(prev.name);
      if (prevNorm === normName && distBetween <= 180) return true;
      if (
        normName.length >= 6 &&
        prevNorm.length >= 6 &&
        (prevNorm.includes(normName) || normName.includes(prevNorm)) &&
        distBetween <= 120
      ) {
        return true;
      }
      if (distBetween <= 25 && prev.subcategory === item.subcategory) return true;
      return false;
    });

    if (existingIdx === -1) {
      accepted.push(item);
    } else {
      const prev = accepted[existingIdx];
      const hasBetterAddr =
        prev.address.startsWith('Address not listed') && !item.address.startsWith('Address not listed');
      accepted[existingIdx] = {
        ...prev,
        address: hasBetterAddr ? item.address : prev.address,
        phone: prev.phone || item.phone,
        openingHours: prev.openingHours || item.openingHours,
        website: prev.website || item.website,
      };
    }
  }

  return accepted.sort((a, b) => a.distanceMeters - b.distanceMeters);
}

interface CacheEntry {
  expiresAt: number;
  places: NearbyPlaceResult[];
  provider: string;
}

const nearbyCache = new Map<string, CacheEntry>();
const reverseCache = new Map<
  string,
  { expiresAt: number; address: string; city?: string; ward?: string; state?: string; postcode?: string }
>();

const PHOTON_TASKS_BY_CATEGORY: Record<
  NearbyCategoryKey,
  Array<{ q: string; tags: string[]; subcategory: string }>
> = {
  healthcare: [
    { q: 'hospital', tags: ['amenity:hospital', 'healthcare:hospital'], subcategory: 'hospital' },
    {
      q: 'clinic',
      tags: ['amenity:clinic', 'healthcare:clinic', 'healthcare:centre', 'amenity:doctors'],
      subcategory: 'clinic',
    },
    { q: 'pharmacy', tags: ['amenity:pharmacy'], subcategory: 'pharmacy' },
  ],
  public_safety: [
    { q: 'police', tags: ['amenity:police'], subcategory: 'police station' },
    { q: 'fire station', tags: ['amenity:fire_station'], subcategory: 'fire station' },
  ],
  education: [
    { q: 'school', tags: ['amenity:school', 'amenity:college', 'amenity:university'], subcategory: 'school' },
    { q: 'library', tags: ['amenity:library'], subcategory: 'library' },
  ],
  food: [
    { q: 'restaurant', tags: ['amenity:restaurant', 'amenity:cafe', 'amenity:fast_food'], subcategory: 'restaurant' },
  ],
  public_places: [
    { q: 'park', tags: ['leisure:park', 'leisure:garden', 'amenity:community_centre'], subcategory: 'park' },
  ],
  transport: [
    { q: 'station', tags: ['railway:station', 'amenity:bus_station', 'highway:bus_stop'], subcategory: 'station' },
  ],
  shopping: [
    { q: 'market', tags: ['shop:supermarket', 'shop:mall', 'amenity:marketplace'], subcategory: 'supermarket' },
  ],
  government: [
    {
      q: 'post office',
      tags: ['amenity:post_office', 'amenity:townhall', 'amenity:courthouse', 'office:government'],
      subcategory: 'government service',
    },
  ],
  other: [
    { q: 'bank', tags: ['amenity:bank', 'amenity:atm', 'amenity:fuel'], subcategory: 'bank' },
  ],
};

async function fetchViaPhoton(params: {
  lat: number;
  lng: number;
  radius: number;
  cats: NearbyCategoryKey[];
  mode: NearbySearchMode;
}): Promise<{ places: NearbyPlaceResult[]; ok: boolean; timedOut: boolean }> {
  const latDelta = params.radius / 111320;
  const lngDelta = params.radius / (111320 * Math.max(0.2, Math.cos((params.lat * Math.PI) / 180)));
  // Photon bbox order: minLon,minLat,maxLon,maxLat
  const bbox = `${(params.lng - lngDelta).toFixed(5)},${(params.lat - latDelta).toFixed(5)},${(
    params.lng + lngDelta
  ).toFixed(5)},${(params.lat + latDelta).toFixed(5)}`;

  const tasks: Array<{ cat: NearbyCategoryKey; q: string; tags: string[]; subcategory: string }> = [];
  if (params.mode === 'medical_facilities') {
    tasks.push({
      cat: 'healthcare',
      q: 'hospital',
      tags: ['amenity:hospital', 'healthcare:hospital'],
      subcategory: 'hospital',
    });
    tasks.push({
      cat: 'healthcare',
      q: 'clinic',
      tags: ['amenity:clinic', 'healthcare:clinic', 'healthcare:centre', 'amenity:doctors'],
      subcategory: 'clinic',
    });
    tasks.push({
      cat: 'healthcare',
      q: 'medical',
      tags: ['amenity:hospital', 'amenity:clinic', 'healthcare:centre', 'amenity:doctors', 'emergency:ambulance_station'],
      subcategory: 'medical centre',
    });
  } else if (params.mode === 'police_only') {
    tasks.push({
      cat: 'public_safety',
      q: 'police',
      tags: ['amenity:police'],
      subcategory: 'police station',
    });
    tasks.push({
      cat: 'public_safety',
      q: 'thana',
      tags: ['amenity:police'],
      subcategory: 'police station',
    });
  } else if (params.mode === 'strict_medical_safety') {
    tasks.push({
      cat: 'healthcare',
      q: 'hospital',
      tags: ['amenity:hospital', 'healthcare:hospital', 'amenity:clinic'],
      subcategory: 'hospital',
    });
    tasks.push({
      cat: 'public_safety',
      q: 'police',
      tags: ['amenity:police'],
      subcategory: 'police station',
    });
  } else {
    for (const cat of params.cats.slice(0, 5)) {
      const defs = PHOTON_TASKS_BY_CATEGORY[cat] || [];
      for (const d of defs.slice(0, params.cats.length > 2 ? 1 : 2)) {
        tasks.push({ cat, ...d });
      }
    }
  }

  let anyOk = false;
  let allTimedOut = tasks.length > 0;

  const taskResults = await Promise.all(
    tasks.map(async (t) => {
      const found: NearbyPlaceResult[] = [];
      try {
        const qs = new URLSearchParams({
          q: t.q,
          lat: params.lat.toFixed(5),
          lon: params.lng.toFixed(5),
          bbox,
          limit: '40',
          lang: 'en',
        });
        for (const tag of t.tags) {
          qs.append('osm_tag', tag);
        }

        const res = await fetch(`https://photon.komoot.io/api/?${qs.toString()}`, {
          headers: {
            Accept: 'application/json',
            'User-Agent': 'SEVA-AI-SmartCity-Platform/1.0',
          },
          signal: AbortSignal.timeout(5500),
        });
        allTimedOut = false;
        if (!res.ok) return found;
        anyOk = true;

        const data = (await res.json()) as {
          features?: Array<{
            geometry?: { coordinates?: [number, number] };
            properties?: Record<string, any>;
          }>;
        };

        for (const f of data.features || []) {
          const coords = f.geometry?.coordinates;
          const props = f.properties || {};
          if (!coords || coords.length < 2) continue;
          const pLng = Number(coords[0]);
          const pLat = Number(coords[1]);
          if (!Number.isFinite(pLat) || !Number.isFinite(pLng)) continue;

          const distanceMeters = Math.round(haversineMeters(params.lat, params.lng, pLat, pLng));
          if (distanceMeters > params.radius) continue;

          const osmKey = String(props.osm_key || '');
          const osmVal = String(props.osm_value || '');
          const pseudoTags: Record<string, string> = osmKey && osmVal ? { [osmKey]: osmVal } : {};
          const classified = classifyElement(pseudoTags, [t.cat], params.mode);
          if (!classified) continue;

          const rawName = String(props.name || '').trim();
          const fallbackLabel =
            classified.subcategory.charAt(0).toUpperCase() + classified.subcategory.slice(1);

          found.push({
            id: `ph-${props.osm_type || 'N'}-${props.osm_id || found.length}`,
            name: rawName || fallbackLabel,
            category: classified.category,
            subcategory: classified.subcategory,
            address: formatPhotonAddress(props),
            lat: pLat,
            lng: pLng,
            distanceMeters,
            directionsUrl: buildGoogleMapsDirectionsUrl(params.lat, params.lng, pLat, pLng),
          });
        }
      } catch (err) {
        if (!isTimeoutError(err)) allTimedOut = false;
      }
      return found;
    })
  );

  return {
    places: deduplicatePlaces(taskResults.flat()).slice(0, 120),
    ok: anyOk,
    timedOut: !anyOk && allTimedOut,
  };
}

const NOMINATIM_TERMS_BY_CATEGORY: Record<NearbyCategoryKey, Array<{ query: string; subcategory: string }>> = {
  healthcare: [
    { query: '[amenity=hospital]', subcategory: 'hospital' },
    { query: '[amenity=clinic]', subcategory: 'clinic' },
    { query: '[healthcare=centre]', subcategory: 'medical centre' },
  ],
  public_safety: [
    { query: '[amenity=police]', subcategory: 'police station' },
    { query: '[amenity=fire_station]', subcategory: 'fire station' },
  ],
  education: [
    { query: '[amenity=school]', subcategory: 'school' },
    { query: '[amenity=college]', subcategory: 'college' },
    { query: '[amenity=library]', subcategory: 'library' },
  ],
  food: [
    { query: '[amenity=restaurant]', subcategory: 'restaurant' },
    { query: '[amenity=cafe]', subcategory: 'cafe' },
  ],
  public_places: [
    { query: '[leisure=park]', subcategory: 'park' },
    { query: '[amenity=community_centre]', subcategory: 'community centre' },
  ],
  transport: [
    { query: '[railway=station]', subcategory: 'station' },
    { query: '[amenity=bus_station]', subcategory: 'bus station' },
  ],
  shopping: [
    { query: '[shop=supermarket]', subcategory: 'supermarket' },
    { query: '[shop=mall]', subcategory: 'mall' },
  ],
  government: [
    { query: '[amenity=townhall]', subcategory: 'town hall' },
    { query: '[amenity=post_office]', subcategory: 'post office' },
  ],
  other: [
    { query: '[amenity=bank]', subcategory: 'bank' },
    { query: '[amenity=fuel]', subcategory: 'fuel station' },
  ],
};

// Polite sequential queue helper so Nominatim never gets slammed by simultaneous bursts from one server IP
let nominatimQueueTail: Promise<unknown> = Promise.resolve();
function runSerializedNominatim<T>(fn: () => Promise<T>): Promise<T> {
  const next = nominatimQueueTail.then(async () => {
    const out = await fn();
    await new Promise((r) => setTimeout(r, 250));
    return out;
  });
  nominatimQueueTail = next.catch(() => {});
  return next;
}

async function fetchViaNominatim(params: {
  lat: number;
  lng: number;
  radius: number;
  cats: NearbyCategoryKey[];
  mode: NearbySearchMode;
}): Promise<{ places: NearbyPlaceResult[]; ok: boolean; timedOut: boolean }> {
  const latDelta = params.radius / 111320;
  const lngDelta = params.radius / (111320 * Math.max(0.2, Math.cos((params.lat * Math.PI) / 180)));
  const viewbox = `${(params.lng - lngDelta).toFixed(5)},${(params.lat + latDelta).toFixed(5)},${(
    params.lng + lngDelta
  ).toFixed(5)},${(params.lat - latDelta).toFixed(5)}`;

  const tasks: Array<{ cat: NearbyCategoryKey; query: string; subcategory: string }> = [];
  if (params.mode === 'medical_facilities') {
    tasks.push({ cat: 'healthcare', query: '[amenity=hospital]', subcategory: 'hospital' });
    tasks.push({ cat: 'healthcare', query: '[amenity=clinic]', subcategory: 'clinic' });
  } else if (params.mode === 'police_only') {
    tasks.push({ cat: 'public_safety', query: '[amenity=police]', subcategory: 'police station' });
  } else if (params.mode === 'strict_medical_safety') {
    tasks.push({ cat: 'healthcare', query: '[amenity=hospital]', subcategory: 'hospital' });
    tasks.push({ cat: 'public_safety', query: '[amenity=police]', subcategory: 'police station' });
  } else {
    for (const cat of params.cats.slice(0, 3)) {
      const terms = NOMINATIM_TERMS_BY_CATEGORY[cat] || [{ query: '[amenity=community_centre]', subcategory: 'civic' }];
      tasks.push({ cat, query: terms[0].query, subcategory: terms[0].subcategory });
    }
  }

  let anyOk = false;
  let allTimedOut = tasks.length > 0;
  const collected: NearbyPlaceResult[] = [];

  for (const { cat, query, subcategory } of tasks) {
    try {
      const res = await runSerializedNominatim(() =>
        fetch(
          `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(
            query
          )}&viewbox=${viewbox}&bounded=1&limit=40&addressdetails=1&extratags=1&accept-language=en`,
          {
            headers: {
              'User-Agent': 'SEVA-AI-SmartCity-Platform/1.0',
              Accept: 'application/json',
            },
            signal: AbortSignal.timeout(5500),
          }
        )
      );
      allTimedOut = false;
      if (!res.ok) continue;
      anyOk = true;

      const items = (await res.json()) as Array<{
        place_id?: number;
        osm_type?: string;
        osm_id?: number;
        lat?: string;
        lon?: string;
        name?: string;
        display_name?: string;
        type?: string;
        category?: string;
        address?: Record<string, string>;
        extratags?: Record<string, string>;
      }>;

      for (const item of items) {
        if (item.category === 'highway' && subcategory !== 'bus station') continue;
        if (item.category === 'office' && cat !== 'government') continue;
        if (params.mode === 'police_only' && item.category !== 'amenity' && item.type !== 'police') continue;
        if (
          params.mode === 'medical_facilities' &&
          item.category &&
          !['amenity', 'healthcare', 'emergency'].includes(item.category)
        ) {
          continue;
        }

        const pLat = Number(item.lat);
        const pLng = Number(item.lon);
        if (!Number.isFinite(pLat) || !Number.isFinite(pLng)) continue;

        const distanceMeters = Math.round(haversineMeters(params.lat, params.lng, pLat, pLng));
        if (distanceMeters > params.radius) continue;

        const rawType = (item.type || subcategory).replace(/_/g, ' ').toLowerCase();
        if (params.mode === 'police_only' && rawType !== 'police' && rawType !== 'police station') continue;
        if (
          params.mode === 'medical_facilities' &&
          !['hospital', 'clinic', 'doctors', 'centre', 'medical centre', 'ambulance station'].includes(rawType)
        ) {
          continue;
        }

        const niceSub =
          rawType === 'police'
            ? 'police station'
            : rawType === 'doctors' || rawType === 'centre'
            ? 'medical centre'
            : rawType;
        const fallbackLabel = niceSub.charAt(0).toUpperCase() + niceSub.slice(1);
        const rawFirstPart = item.display_name?.split(',')[0]?.trim();
        const name = (item.name || rawFirstPart || fallbackLabel).trim();
        const extra = item.extratags || {};

        collected.push({
          id: `nom-${item.osm_type || 'N'}-${item.osm_id || item.place_id || collected.length}`,
          name,
          category: cat,
          subcategory: niceSub,
          address: formatNominatimAddress(item),
          lat: pLat,
          lng: pLng,
          distanceMeters,
          phone: extra.phone || extra['contact:phone'] || extra['emergency:phone'] || undefined,
          openingHours: extra.opening_hours || undefined,
          website: extra.website || extra['contact:website'] || undefined,
          directionsUrl: buildGoogleMapsDirectionsUrl(params.lat, params.lng, pLat, pLng),
        });
      }
    } catch (err) {
      if (!isTimeoutError(err)) allTimedOut = false;
    }
  }

  return {
    places: deduplicatePlaces(collected).slice(0, 120),
    ok: anyOk,
    timedOut: !anyOk && allTimedOut,
  };
}

async function queryOverpassEndpoint(
  endpoint: string,
  overpassQuery: string
): Promise<
  Array<{
    type: string;
    id: number;
    lat?: number;
    lon?: number;
    center?: { lat: number; lon: number };
    tags?: Record<string, string>;
  }>
> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Accept: '*/*',
      'User-Agent': 'SEVA-AI-SmartCity-Platform/1.0',
    },
    body: `data=${encodeURIComponent(overpassQuery)}`,
    signal: AbortSignal.timeout(4800),
  });

  if (!response.ok) {
    throw new Error(`Overpass mirror HTTP ${response.status}`);
  }

  const contentType = response.headers.get('content-type') || '';
  const rawText = await response.text();
  if (!contentType.includes('json') && rawText.trim().startsWith('<')) {
    throw new Error('Overpass mirror returned non-JSON response');
  }

  const data = JSON.parse(rawText) as {
    elements?: Array<{
      type: string;
      id: number;
      lat?: number;
      lon?: number;
      center?: { lat: number; lon: number };
      tags?: Record<string, string>;
    }>;
  };
  return data.elements || [];
}

function mapOverpassElements(
  elements: Array<{
    type: string;
    id: number;
    lat?: number;
    lon?: number;
    center?: { lat: number; lon: number };
    tags?: Record<string, string>;
  }>,
  lat: number,
  lng: number,
  radius: number,
  cats: NearbyCategoryKey[],
  mode: NearbySearchMode
): NearbyPlaceResult[] {
  const candidates: NearbyPlaceResult[] = [];
  for (const el of elements) {
    const tags = el.tags || {};
    const pLat = el.lat ?? el.center?.lat;
    const pLng = el.lon ?? el.center?.lon;
    if (typeof pLat !== 'number' || typeof pLng !== 'number') continue;

    const classified = classifyElement(tags, cats, mode);
    if (!classified) continue;

    const distanceMeters = Math.round(haversineMeters(lat, lng, pLat, pLng));
    if (distanceMeters > radius) continue;

    const rawName = (tags.name || tags['name:en'] || tags.operator || '').trim();
    if (!rawName && !tags['addr:street']) continue;
    const fallbackSub = classified.subcategory.charAt(0).toUpperCase() + classified.subcategory.slice(1);
    const finalName = rawName || fallbackSub;

    candidates.push({
      id: `${el.type}-${el.id}`,
      name: finalName,
      category: classified.category,
      subcategory: classified.subcategory,
      address: formatOsmAddress(tags),
      lat: pLat,
      lng: pLng,
      distanceMeters,
      phone: tags.phone || tags['contact:phone'] || tags['emergency:phone'] || undefined,
      openingHours: tags.opening_hours || undefined,
      website: tags.website || tags['contact:website'] || undefined,
      directionsUrl: buildGoogleMapsDirectionsUrl(lat, lng, pLat, pLng),
    });
  }
  return deduplicatePlaces(candidates).slice(0, 120);
}

export async function fetchNearbyPlaces(params: {
  lat: number;
  lng: number;
  radiusMeters: number;
  categories: NearbyCategoryKey[];
  strictMedicalSafety?: boolean;
  mode?: NearbySearchMode;
  forceRefresh?: boolean;
}): Promise<{ places: NearbyPlaceResult[]; provider: string; cached: boolean; radiusMeters: number }> {
  const radius = Math.max(200, Math.min(50000, Math.round(params.radiusMeters)));
  const mode: NearbySearchMode = params.mode
    ? params.mode
    : params.strictMedicalSafety
    ? 'strict_medical_safety'
    : 'general';

  const cats: NearbyCategoryKey[] =
    mode === 'medical_facilities'
      ? ['healthcare']
      : mode === 'police_only'
      ? ['public_safety']
      : mode === 'strict_medical_safety'
      ? ['healthcare', 'public_safety']
      : params.categories.length > 0
      ? params.categories
      : ['healthcare', 'public_safety'];

  const cacheKey = `${params.lat.toFixed(4)}:${params.lng.toFixed(4)}:${radius}:${mode}:${cats
    .slice()
    .sort()
    .join(',')}`;

  if (!params.forceRefresh) {
    const hit = nearbyCache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) {
      return { places: hit.places, provider: hit.provider, cached: true, radiusMeters: radius };
    }
  }

  const queryClauses: string[] = [];
  if (mode === 'medical_facilities') {
    for (const [k, v] of MEDICAL_FACILITY_FILTERS) {
      queryClauses.push(`nwr(around:${radius},${params.lat},${params.lng})["${k}"="${v}"];`);
    }
  } else if (mode === 'police_only') {
    for (const [k, v] of POLICE_FILTERS) {
      queryClauses.push(`nwr(around:${radius},${params.lat},${params.lng})["${k}"="${v}"];`);
    }
  } else if (mode === 'strict_medical_safety') {
    for (const [k, v] of [...MEDICAL_FACILITY_FILTERS, ...POLICE_FILTERS]) {
      queryClauses.push(`nwr(around:${radius},${params.lat},${params.lng})["${k}"="${v}"];`);
    }
  } else {
    for (const cat of cats) {
      const pairs = CATEGORY_FILTERS[cat] || [];
      for (const [k, v] of pairs) {
        queryClauses.push(`node(around:${radius},${params.lat},${params.lng})["${k}"="${v}"];`);
        if (cats.length <= 3) {
          queryClauses.push(`way(around:${radius},${params.lat},${params.lng})["${k}"="${v}"];`);
        }
      }
    }
  }

  const overpassQuery = `[out:json][timeout:4];(\n${queryClauses.join('\n')}\n);out center tags 200;`;

  // Run global Overpass mirrors AND Photon OSM search in parallel so Overpass slowness/blocks never stall live results
  const photonPromise = fetchViaPhoton({
    lat: params.lat,
    lng: params.lng,
    radius,
    cats,
    mode,
  });

  let elements: Array<{
    type: string;
    id: number;
    lat?: number;
    lon?: number;
    center?: { lat: number; lon: number };
    tags?: Record<string, string>;
  }> | null = null;
  let overpassTimedOut = false;

  try {
    elements = await Promise.any(OVERPASS_ENDPOINTS.map((ep) => queryOverpassEndpoint(ep, overpassQuery)));
  } catch (err: any) {
    const errors: any[] = Array.isArray(err?.errors) ? err.errors : [err];
    overpassTimedOut = errors.length > 0 && errors.every((e) => isTimeoutError(e));
  }

  if (elements !== null) {
    const mapped = mapOverpassElements(elements, params.lat, params.lng, radius, cats, mode);
    if (mapped.length > 0) {
      nearbyCache.set(cacheKey, {
        expiresAt: Date.now() + 5 * 60 * 1000,
        places: mapped,
        provider: 'OpenStreetMap Overpass API',
      });
      return {
        places: mapped,
        provider: 'OpenStreetMap Overpass API',
        cached: false,
        radiusMeters: radius,
      };
    }

    // Overpass returned 0 items — check Photon before concluding empty
    const photonRes = await photonPromise;
    if (photonRes.ok && photonRes.places.length > 0) {
      nearbyCache.set(cacheKey, {
        expiresAt: Date.now() + 5 * 60 * 1000,
        places: photonRes.places,
        provider: 'OpenStreetMap Photon API',
      });
      return {
        places: photonRes.places,
        provider: 'OpenStreetMap Photon API',
        cached: false,
        radiusMeters: radius,
      };
    }

    nearbyCache.set(cacheKey, {
      expiresAt: Date.now() + 2 * 60 * 1000,
      places: [],
      provider: 'OpenStreetMap Overpass API',
    });
    return {
      places: [],
      provider: 'OpenStreetMap Overpass API',
      cached: false,
      radiusMeters: radius,
    };
  }

  // Overpass mirrors failed — use Photon OSM API result if healthy
  const photonRes = await photonPromise;
  if (photonRes.ok) {
    nearbyCache.set(cacheKey, {
      expiresAt: Date.now() + 5 * 60 * 1000,
      places: photonRes.places,
      provider: 'OpenStreetMap Photon API',
    });
    return {
      places: photonRes.places,
      provider: 'OpenStreetMap Photon API',
      cached: false,
      radiusMeters: radius,
    };
  }

  // Tier 3 fallback: serialized polite Nominatim lookup
  const nomRes = await fetchViaNominatim({
    lat: params.lat,
    lng: params.lng,
    radius,
    cats,
    mode,
  });
  if (nomRes.ok) {
    nearbyCache.set(cacheKey, {
      expiresAt: Date.now() + 5 * 60 * 1000,
      places: nomRes.places,
      provider: 'OpenStreetMap Nominatim API',
    });
    return {
      places: nomRes.places,
      provider: 'OpenStreetMap Nominatim API',
      cached: false,
      radiusMeters: radius,
    };
  }

  const allTimedOut = overpassTimedOut && photonRes.timedOut && nomRes.timedOut;
  if (allTimedOut) {
    throw new PlacesProviderError(
      'Nearby places request timed out while waiting for OpenStreetMap servers. Please retry.',
      'NETWORK_TIMEOUT',
      504
    );
  }
  throw new PlacesProviderError(
    'Unable to reach OpenStreetMap nearby places providers (Overpass, Photon, and Nominatim failed). Please check network connectivity and click Retry.',
    'UPSTREAM_FETCH_FAILED',
    502
  );
}

export async function geocodeLocationQuery(queryText: string): Promise<{
  lat: number;
  lng: number;
  address: string;
} | null> {
  const clean = queryText.trim();
  if (!clean) return null;

  try {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(
      clean
    )}&limit=1&accept-language=en`;
    const res = await runSerializedNominatim(() =>
      fetch(url, {
        headers: {
          'User-Agent': 'SEVA-AI-SmartCity-Platform/1.0',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(6500),
      })
    );
    if (res.ok) {
      const arr = (await res.json()) as Array<{ lat?: string; lon?: string; display_name?: string }>;
      const first = arr[0];
      if (first) {
        const lat = Number(first.lat);
        const lng = Number(first.lon);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          return {
            lat,
            lng,
            address: first.display_name || clean,
          };
        }
      }
    }
  } catch {
    // Fallback to Photon below
  }

  try {
    const pRes = await fetch(
      `https://photon.komoot.io/api/?q=${encodeURIComponent(clean)}&limit=1&lang=en`,
      {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'SEVA-AI-SmartCity-Platform/1.0',
        },
        signal: AbortSignal.timeout(5500),
      }
    );
    if (pRes.ok) {
      const data = (await pRes.json()) as {
        features?: Array<{ geometry?: { coordinates?: [number, number] }; properties?: Record<string, any> }>;
      };
      const first = data.features?.[0];
      const coords = first?.geometry?.coordinates;
      if (coords && coords.length >= 2) {
        const lng = Number(coords[0]);
        const lat = Number(coords[1]);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          const p = first?.properties || {};
          const label = [p.name, formatPhotonAddress(p)].filter(Boolean).join(', ');
          return {
            lat,
            lng,
            address: label || clean,
          };
        }
      }
    }
  } catch {
    // ignore
  }

  return null;
}

export async function reverseGeocode(lat: number, lng: number): Promise<{
  address: string;
  city: string;
  ward: string;
  state?: string;
  postcode?: string;
}> {
  const key = `${lat.toFixed(4)}:${lng.toFixed(4)}`;
  const cached = reverseCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return {
      address: cached.address,
      city: cached.city || '',
      ward: cached.ward || '',
      state: cached.state,
      postcode: cached.postcode,
    };
  }

  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(
      lat
    )}&lon=${encodeURIComponent(lng)}&zoom=18&addressdetails=1&accept-language=en`;

    const res = await runSerializedNominatim(() =>
      fetch(url, {
        headers: {
          'User-Agent': 'SEVA-AI-SmartCity-Platform/1.0',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(6500),
      })
    );

    if (res.ok) {
      const data = (await res.json()) as {
        display_name?: string;
        address?: Record<string, string>;
      };

      const addr = data.address || {};
      const city = addr.city || addr.town || addr.village || addr.state_district || addr.state || '';
      const ward = addr.suburb || addr.neighbourhood || addr.quarter || addr.city_district || addr.road || '';
      const state = addr.state || '';
      const postcode = addr.postcode || '';
      const address = data.display_name || `${lat.toFixed(5)}, ${lng.toFixed(5)}`;

      reverseCache.set(key, {
        expiresAt: Date.now() + 15 * 60 * 1000,
        address,
        city,
        ward,
        state,
        postcode,
      });

      return { address, city, ward, state, postcode };
    }
  } catch {
    // Fallback to Photon reverse below
  }

  try {
    const pRes = await fetch(
      `https://photon.komoot.io/reverse?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}`,
      {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'SEVA-AI-SmartCity-Platform/1.0',
        },
        signal: AbortSignal.timeout(5500),
      }
    );
    if (pRes.ok) {
      const pData = (await pRes.json()) as { features?: Array<{ properties?: Record<string, any> }> };
      const p = pData.features?.[0]?.properties;
      if (p) {
        const city = String(p.city || p.town || p.village || p.county || p.state || '');
        const ward = String(p.locality || p.district || p.street || '');
        const state = String(p.state || '');
        const postcode = String(p.postcode || '');
        const address = [p.name, formatPhotonAddress(p)]
          .filter((v, idx, arr) => typeof v === 'string' && v.trim() && arr.indexOf(v) === idx)
          .join(', ');
        if (address) {
          reverseCache.set(key, {
            expiresAt: Date.now() + 15 * 60 * 1000,
            address,
            city,
            ward,
            state,
            postcode,
          });
          return { address, city, ward, state, postcode };
        }
      }
    }
  } catch {
    // Fallback to coordinates below
  }

  return {
    address: `GPS Coordinates (${lat.toFixed(5)}, ${lng.toFixed(5)})`,
    city: '',
    ward: '',
  };
}
