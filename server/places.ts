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
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
];

const CATEGORY_FILTERS: Record<NearbyCategoryKey, Array<[string, string]>> = {
  healthcare: [
    ['amenity', 'hospital'],
    ['amenity', 'clinic'],
    ['amenity', 'pharmacy'],
    ['amenity', 'doctors'],
    ['healthcare', 'centre'],
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

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function classifyElement(tags: Record<string, string>, requested: NearbyCategoryKey[]): {
  category: NearbyCategoryKey;
  subcategory: string;
} {
  for (const cat of requested) {
    const pairs = CATEGORY_FILTERS[cat];
    for (const [k, v] of pairs) {
      if (tags[k] === v) {
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
  const parts = [
    tags['addr:housename'],
    tags['addr:housenumber'],
    tags['addr:street'],
    tags['addr:suburb'] || tags['addr:neighbourhood'],
    tags['addr:city'] || tags['addr:town'] || tags['addr:district'],
    tags['addr:postcode'],
  ].filter(Boolean);
  if (parts.length > 0) return parts.join(', ');
  if (tags['addr:full']) return tags['addr:full'];
  return 'Address details not listed on OpenStreetMap';
}

interface CacheEntry {
  expiresAt: number;
  places: NearbyPlaceResult[];
  provider: string;
}

const nearbyCache = new Map<string, CacheEntry>();
const reverseCache = new Map<string, { expiresAt: number; address: string; city?: string; ward?: string }>();

const NOMINATIM_TERMS_BY_CATEGORY: Record<NearbyCategoryKey, string[]> = {
  healthcare: ['hospital', 'pharmacy', 'clinic'],
  public_safety: ['police', 'fire station'],
  education: ['school', 'college', 'library'],
  food: ['restaurant', 'cafe'],
  public_places: ['park', 'community centre'],
  transport: ['metro station', 'bus station', 'railway station'],
  shopping: ['market', 'supermarket', 'mall'],
  government: ['government office', 'post office', 'town hall'],
  other: ['bank', 'atm', 'fuel'],
};

async function fetchViaNominatim(params: {
  lat: number;
  lng: number;
  radius: number;
  cats: NearbyCategoryKey[];
}): Promise<NearbyPlaceResult[]> {
  const seen = new Set<string>();
  const places: NearbyPlaceResult[] = [];

  const latDelta = params.radius / 111320;
  const lngDelta = params.radius / (111320 * Math.max(0.2, Math.cos((params.lat * Math.PI) / 180)));
  const viewbox = `${(params.lng - lngDelta).toFixed(5)},${(params.lat + latDelta).toFixed(5)},${(
    params.lng + lngDelta
  ).toFixed(5)},${(params.lat - latDelta).toFixed(5)}`;

  const tasks: Array<{ cat: NearbyCategoryKey; term: string }> = [];
  for (const cat of params.cats.slice(0, 4)) {
    const terms = NOMINATIM_TERMS_BY_CATEGORY[cat] || ['civic'];
    for (const term of terms.slice(0, params.cats.length > 1 ? 1 : 2)) {
      tasks.push({ cat, term });
    }
  }

  for (const { cat, term } of tasks) {
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(
        term
      )}&viewbox=${viewbox}&bounded=1&limit=15&addressdetails=1`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'SEVA-AI-SmartCity-Platform/1.0',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) continue;

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
      }>;

      for (const item of items) {
        if (item.category === 'highway' && term !== 'bus station') continue;
        if (item.category === 'office' && cat !== 'government') continue;
        const pLat = Number(item.lat);
        const pLng = Number(item.lon);
        if (!Number.isFinite(pLat) || !Number.isFinite(pLng)) continue;

        const distanceMeters = Math.round(haversineMeters(params.lat, params.lng, pLat, pLng));
        if (distanceMeters > params.radius + 500) continue;

        const name = (item.name || item.display_name?.split(',')[0] || term).trim();
        const dedupKey = `${name.toLowerCase()}:${pLat.toFixed(4)}:${pLng.toFixed(4)}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);

        places.push({
          id: `nom-${item.osm_type || 'N'}-${item.osm_id || item.place_id || places.length}`,
          name,
          category: cat,
          subcategory: (item.type || term).replace(/_/g, ' '),
          address: item.display_name || 'OpenStreetMap verified location',
          lat: pLat,
          lng: pLng,
          distanceMeters,
          directionsUrl: `https://www.openstreetmap.org/directions?from=${params.lat},${params.lng}&to=${pLat},${pLng}`,
        });
      }
    } catch {
      // Continue collecting remaining categories
    }
  }

  places.sort((a, b) => a.distanceMeters - b.distanceMeters);
  return places.slice(0, 100);
}

export async function fetchNearbyPlaces(params: {
  lat: number;
  lng: number;
  radiusMeters: number;
  categories: NearbyCategoryKey[];
}): Promise<{ places: NearbyPlaceResult[]; provider: string; cached: boolean }> {
  const radius = Math.max(200, Math.min(50000, Math.round(params.radiusMeters)));
  const cats: NearbyCategoryKey[] =
    params.categories.length > 0 ? params.categories : ['healthcare', 'public_safety'];

  const cacheKey = `${params.lat.toFixed(3)}:${params.lng.toFixed(3)}:${radius}:${cats.slice().sort().join(',')}`;
  const hit = nearbyCache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) {
    return { places: hit.places, provider: hit.provider, cached: true };
  }

  const latDelta = radius / 111320;
  const lngDelta = radius / (111320 * Math.max(0.2, Math.cos((params.lat * Math.PI) / 180)));
  const bbox = `${(params.lat - latDelta).toFixed(5)},${(params.lng - lngDelta).toFixed(5)},${(
    params.lat + latDelta
  ).toFixed(5)},${(params.lng + lngDelta).toFixed(5)}`;

  const queryClauses: string[] = [];
  for (const cat of cats) {
    const pairs = CATEGORY_FILTERS[cat] || [];
    for (const [k, v] of pairs) {
      queryClauses.push(`node["${k}"="${v}"];`);
      if (cats.length <= 2) {
        queryClauses.push(`way["${k}"="${v}"];`);
      }
    }
  }

  const overpassQuery = `[out:json][timeout:4][bbox:${bbox}];(\n${queryClauses.join('\n')}\n);out center 100;`;

  let lastError = 'Overpass API unavailable';
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'User-Agent': 'SEVA-AI-SmartCity-Platform/1.0',
        },
        body: `data=${encodeURIComponent(overpassQuery)}`,
        signal: AbortSignal.timeout(4500),
      });

      if (!response.ok) {
        lastError = `Places provider returned HTTP ${response.status}`;
        continue;
      }

      const contentType = response.headers.get('content-type') || '';
      const rawText = await response.text();
      if (!contentType.includes('json') && rawText.trim().startsWith('<')) {
        lastError = 'Overpass mirror busy (HTML response)';
        continue;
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

      const seen = new Set<string>();
      const places: NearbyPlaceResult[] = [];

      for (const el of data.elements || []) {
        const tags = el.tags || {};
        const pLat = el.lat ?? el.center?.lat;
        const pLng = el.lon ?? el.center?.lon;
        if (typeof pLat !== 'number' || typeof pLng !== 'number') continue;

        const name = (tags.name || tags['name:en'] || tags.operator || '').trim();
        const { category, subcategory } = classifyElement(tags, cats);
        const finalName = name || `${subcategory.charAt(0).toUpperCase() + subcategory.slice(1)}`;
        const dedupKey = `${finalName.toLowerCase()}:${pLat.toFixed(4)}:${pLng.toFixed(4)}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);

        const distanceMeters = Math.round(haversineMeters(params.lat, params.lng, pLat, pLng));
        if (distanceMeters > radius + 250) continue;

        places.push({
          id: `${el.type}-${el.id}`,
          name: finalName,
          category,
          subcategory,
          address: formatOsmAddress(tags),
          lat: pLat,
          lng: pLng,
          distanceMeters,
          phone: tags.phone || tags['contact:phone'] || undefined,
          openingHours: tags.opening_hours || undefined,
          website: tags.website || tags['contact:website'] || undefined,
          directionsUrl: `https://www.openstreetmap.org/directions?from=${params.lat},${params.lng}&to=${pLat},${pLng}`,
        });
      }

      places.sort((a, b) => a.distanceMeters - b.distanceMeters);
      const trimmed = places.slice(0, 120);

      nearbyCache.set(cacheKey, {
        expiresAt: Date.now() + 5 * 60 * 1000,
        places: trimmed,
        provider: 'OpenStreetMap Overpass API',
      });

      return {
        places: trimmed,
        provider: 'OpenStreetMap Overpass API',
        cached: false,
      };
    } catch (err: any) {
      lastError = err?.message || 'Overpass network timeout';
    }
  }

  // Fallback to live OpenStreetMap Nominatim bounded search when Overpass mirrors are congested
  const nomPlaces = await fetchViaNominatim({ lat: params.lat, lng: params.lng, radius, cats });
  if (nomPlaces.length > 0) {
    nearbyCache.set(cacheKey, {
      expiresAt: Date.now() + 5 * 60 * 1000,
      places: nomPlaces,
      provider: 'OpenStreetMap Nominatim API',
    });
    return {
      places: nomPlaces,
      provider: 'OpenStreetMap Nominatim API',
      cached: false,
    };
  }

  throw new Error(lastError);
}

export async function reverseGeocode(lat: number, lng: number): Promise<{
  address: string;
  city: string;
  ward: string;
}> {
  const key = `${lat.toFixed(4)}:${lng.toFixed(4)}`;
  const cached = reverseCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return {
      address: cached.address,
      city: cached.city || '',
      ward: cached.ward || '',
    };
  }

  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(
      lat
    )}&lon=${encodeURIComponent(lng)}&zoom=17&addressdetails=1`;

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
    const city = addr.city || addr.town || addr.state_district || addr.state || '';
    const ward = addr.suburb || addr.neighbourhood || addr.city_district || addr.road || '';
    const address = data.display_name || `${lat.toFixed(5)}, ${lng.toFixed(5)}`;

    reverseCache.set(key, {
      expiresAt: Date.now() + 15 * 60 * 1000,
      address,
      city,
      ward,
    });

    return { address, city, ward };
  } catch {
    return {
      address: `GPS (${lat.toFixed(5)}, ${lng.toFixed(5)})`,
      city: '',
      ward: '',
    };
  }
}
