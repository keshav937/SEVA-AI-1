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

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
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

function deduplicatePlaces(candidates: NearbyPlaceResult[]): NearbyPlaceResult[] {
  // Sort nearest-first first, or prefer richer metadata among nearby duplicates
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
      // Merge useful metadata without overwriting nearer coordinates
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

async function fetchViaNominatim(params: {
  lat: number;
  lng: number;
  radius: number;
  cats: NearbyCategoryKey[];
  mode: NearbySearchMode;
}): Promise<{ places: NearbyPlaceResult[]; ok: boolean }> {
  const latDelta = params.radius / 111320;
  const lngDelta = params.radius / (111320 * Math.max(0.2, Math.cos((params.lat * Math.PI) / 180)));
  const viewbox = `${(params.lng - lngDelta).toFixed(5)},${(params.lat + latDelta).toFixed(5)},${(
    params.lng + lngDelta
  ).toFixed(5)},${(params.lat - latDelta).toFixed(5)}`;

  const tasks: Array<{ cat: NearbyCategoryKey; query: string; subcategory: string }> = [];
  if (params.mode === 'medical_facilities') {
    tasks.push({ cat: 'healthcare', query: '[amenity=hospital]', subcategory: 'hospital' });
    tasks.push({ cat: 'healthcare', query: '[amenity=clinic]', subcategory: 'clinic' });
    tasks.push({ cat: 'healthcare', query: '[amenity=doctors]', subcategory: 'medical centre' });
  } else if (params.mode === 'police_only') {
    tasks.push({ cat: 'public_safety', query: '[amenity=police]', subcategory: 'police station' });
  } else if (params.mode === 'strict_medical_safety') {
    tasks.push({ cat: 'healthcare', query: '[amenity=hospital]', subcategory: 'hospital' });
    tasks.push({ cat: 'healthcare', query: '[amenity=clinic]', subcategory: 'clinic' });
    tasks.push({ cat: 'public_safety', query: '[amenity=police]', subcategory: 'police station' });
  } else {
    for (const cat of params.cats.slice(0, 4)) {
      const terms = NOMINATIM_TERMS_BY_CATEGORY[cat] || [{ query: '[amenity=community_centre]', subcategory: 'civic' }];
      for (const item of terms.slice(0, params.cats.length > 1 ? 1 : 2)) {
        tasks.push({ cat, query: item.query, subcategory: item.subcategory });
      }
    }
  }

  let anyOk = false;
  const results = await Promise.all(
    tasks.map(async ({ cat, query, subcategory }) => {
      const found: NearbyPlaceResult[] = [];
      try {
        const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(
          query
        )}&viewbox=${viewbox}&bounded=1&limit=40&addressdetails=1&extratags=1&accept-language=en`;
        const res = await fetch(url, {
          headers: {
            'User-Agent': 'SEVA-AI-SmartCity-Platform/1.0',
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(5500),
        });
        if (!res.ok) return found;
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
          if (
            params.mode === 'police_only' &&
            item.category !== 'amenity' &&
            item.type !== 'police'
          ) {
            continue;
          }
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
          if (params.mode === 'police_only' && rawType !== 'police' && rawType !== 'police station') {
            continue;
          }
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

          found.push({
            id: `nom-${item.osm_type || 'N'}-${item.osm_id || item.place_id || found.length}`,
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
      } catch {
        // Ignore single query timeout
      }
      return found;
    })
  );

  return {
    places: deduplicatePlaces(results.flat()).slice(0, 120),
    ok: anyOk,
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
      Accept: 'application/json',
      'User-Agent': 'SEVA-AI-SmartCity-Platform/1.0',
    },
    body: `data=${encodeURIComponent(overpassQuery)}`,
    signal: AbortSignal.timeout(3200),
  });

  if (!response.ok) {
    throw new Error(`Overpass mirror returned HTTP ${response.status}`);
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

  const overpassQuery = `[out:json][timeout:3];(\n${queryClauses.join('\n')}\n);out center tags 200;`;

  let elements: Array<{
    type: string;
    id: number;
    lat?: number;
    lon?: number;
    center?: { lat: number; lon: number };
    tags?: Record<string, string>;
  }> | null = null;
  let lastError = 'Overpass API unavailable';

  // Run Overpass and Nominatim concurrently so slow/502 Overpass mirrors never stall results
  const nomPromise = fetchViaNominatim({
    lat: params.lat,
    lng: params.lng,
    radius,
    cats,
    mode,
  });

  try {
    elements = await Promise.any(OVERPASS_ENDPOINTS.map((ep) => queryOverpassEndpoint(ep, overpassQuery)));
  } catch (err: any) {
    lastError = err?.errors?.[0]?.message || err?.message || 'Overpass mirrors unavailable';
  }

  if (elements !== null) {
    const candidates: NearbyPlaceResult[] = [];
    for (const el of elements) {
      const tags = el.tags || {};
      const pLat = el.lat ?? el.center?.lat;
      const pLng = el.lon ?? el.center?.lon;
      if (typeof pLat !== 'number' || typeof pLng !== 'number') continue;

      const classified = classifyElement(tags, cats, mode);
      if (!classified) continue;

      const distanceMeters = Math.round(haversineMeters(params.lat, params.lng, pLat, pLng));
      if (distanceMeters > radius) continue;

      const rawName = (tags.name || tags['name:en'] || tags.operator || '').trim();
      if (!rawName && !tags['addr:street']) continue;
      const fallbackSub =
        classified.subcategory.charAt(0).toUpperCase() + classified.subcategory.slice(1);
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
        directionsUrl: buildGoogleMapsDirectionsUrl(params.lat, params.lng, pLat, pLng),
      });
    }

    const deduped = deduplicatePlaces(candidates).slice(0, 120);
    nearbyCache.set(cacheKey, {
      expiresAt: Date.now() + 5 * 60 * 1000,
      places: deduped,
      provider: 'OpenStreetMap Overpass API',
    });

    return {
      places: deduped,
      provider: 'OpenStreetMap Overpass API',
      cached: false,
      radiusMeters: radius,
    };
  }

  const nomRes = await nomPromise;
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

  throw new Error(lastError);
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
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'SEVA-AI-SmartCity-Platform/1.0',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(7000),
    });
    if (!res.ok) return null;
    const arr = (await res.json()) as Array<{ lat?: string; lon?: string; display_name?: string }>;
    const first = arr[0];
    if (!first) return null;
    const lat = Number(first.lat);
    const lng = Number(first.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return {
      lat,
      lng,
      address: first.display_name || clean,
    };
  } catch {
    return null;
  }
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

    const res = await fetch(url, {
      headers: {
        'User-Agent': 'SEVA-AI-SmartCity-Platform/1.0',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(7000),
    });

    if (!res.ok) {
      throw new Error(`Nominatim ${res.status}`);
    }

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
  } catch {
    return {
      address: `GPS Coordinates (${lat.toFixed(5)}, ${lng.toFixed(5)})`,
      city: '',
      ward: '',
    };
  }
}
