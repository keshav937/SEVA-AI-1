import React, { useEffect, useRef } from 'react';
import L from 'leaflet';

export interface MapMarkerItem {
  id: string;
  lat: number;
  lng: number;
  title: string;
  subtitle?: string;
  color?: string;
  directionsUrl?: string;
}

export interface HeatmapCircleItem {
  id: string;
  lat: number;
  lng: number;
  radiusMeters: number;
  color: string;
  label: string;
}

interface LeafletMapProps {
  centerLat: number;
  centerLng: number;
  zoom?: number;
  userLat?: number | null;
  userLng?: number | null;
  userAccuracyMeters?: number | null;
  searchRadiusMeters?: number | null;
  primaryRadiusColor?: string;
  secondaryRadiusMeters?: number | null;
  secondaryRadiusColor?: string;
  markers?: MapMarkerItem[];
  heatmapCircles?: HeatmapCircleItem[];
  polylinePoints?: Array<[number, number]>;
  onMapClick?: (lat: number, lng: number) => void;
  selectedMarkerId?: string | null;
  heightClass?: string;
}

export const LeafletMap: React.FC<LeafletMapProps> = ({
  centerLat,
  centerLng,
  zoom = 14,
  userLat,
  userLng,
  userAccuracyMeters,
  searchRadiusMeters,
  primaryRadiusColor = '#14532D',
  secondaryRadiusMeters,
  secondaryRadiusColor = '#1D4ED8',
  markers = [],
  heatmapCircles = [],
  polylinePoints = [],
  onMapClick,
  selectedMarkerId,
  heightClass = 'h-[420px]',
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerGroupRef = useRef<L.LayerGroup | null>(null);
  const onClickRef = useRef(onMapClick);
  onClickRef.current = onMapClick;

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, {
      center: [centerLat, centerLng],
      zoom,
      zoomControl: true,
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(map);

    const group = L.layerGroup().addTo(map);
    map.on('click', (e: L.LeafletMouseEvent) => {
      if (onClickRef.current) {
        onClickRef.current(e.latlng.lat, e.latlng.lng);
      }
    });

    mapRef.current = map;
    layerGroupRef.current = group;

    return () => {
      map.remove();
      mapRef.current = null;
      layerGroupRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!mapRef.current) return;
    mapRef.current.setView([centerLat, centerLng], zoom, { animate: true });
  }, [centerLat, centerLng, zoom]);

  useEffect(() => {
    const group = layerGroupRef.current;
    const map = mapRef.current;
    if (!group || !map) return;

    group.clearLayers();

    // Primary search radius ring
    if (typeof userLat === 'number' && typeof userLng === 'number' && searchRadiusMeters) {
      L.circle([userLat, userLng], {
        radius: searchRadiusMeters,
        color: primaryRadiusColor,
        weight: 1.5,
        dashArray: '6 4',
        fillColor: primaryRadiusColor,
        fillOpacity: 0.04,
      }).addTo(group);
    }

    // Secondary search radius ring (when hospital and police radii differ)
    if (
      typeof userLat === 'number' &&
      typeof userLng === 'number' &&
      secondaryRadiusMeters &&
      secondaryRadiusMeters !== searchRadiusMeters
    ) {
      L.circle([userLat, userLng], {
        radius: secondaryRadiusMeters,
        color: secondaryRadiusColor,
        weight: 1.5,
        dashArray: '4 4',
        fillColor: secondaryRadiusColor,
        fillOpacity: 0.03,
      }).addTo(group);
    }

    // User GPS accuracy halo + live marker
    if (typeof userLat === 'number' && typeof userLng === 'number') {
      if (userAccuracyMeters && userAccuracyMeters > 0) {
        L.circle([userLat, userLng], {
          radius: Math.min(userAccuracyMeters, 1500),
          color: '#059669',
          weight: 1,
          fillColor: '#059669',
          fillOpacity: 0.14,
        }).addTo(group);
      }

      L.circleMarker([userLat, userLng], {
        radius: 8,
        color: '#FFFFFF',
        weight: 3,
        fillColor: '#14532D',
        fillOpacity: 1,
      })
        .bindPopup('<strong>Your Live GPS Location</strong>')
        .addTo(group);
    }

    // Live tracking breadcrumb path
    if (polylinePoints.length > 1) {
      L.polyline(polylinePoints, {
        color: '#059669',
        weight: 3.5,
        opacity: 0.85,
      }).addTo(group);
    }

    // Safety Heatmap density circles
    for (const hc of heatmapCircles) {
      L.circle([hc.lat, hc.lng], {
        radius: hc.radiusMeters,
        color: hc.color,
        weight: 1,
        fillColor: hc.color,
        fillOpacity: 0.28,
      })
        .bindPopup(`<div class="text-xs font-medium">${hc.label}</div>`)
        .addTo(group);
    }

    // Place / Report markers
    for (const m of markers) {
      const isSelected = selectedMarkerId === m.id;
      const marker = L.circleMarker([m.lat, m.lng], {
        radius: isSelected ? 9 : 6.5,
        color: '#FFFFFF',
        weight: 2,
        fillColor: m.color || '#059669',
        fillOpacity: 0.95,
      });

      const popupEl = document.createElement('div');
      popupEl.className = 'text-xs leading-snug max-w-[220px]';
      const titleEl = document.createElement('div');
      titleEl.className = 'font-semibold text-slate-900 mb-0.5';
      titleEl.textContent = m.title;
      popupEl.appendChild(titleEl);

      if (m.subtitle) {
        const subEl = document.createElement('div');
        subEl.className = 'text-slate-600 mb-1.5';
        subEl.textContent = m.subtitle;
        popupEl.appendChild(subEl);
      }

      if (m.directionsUrl) {
        const link = document.createElement('a');
        link.href = m.directionsUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.className = 'text-green-800 font-medium underline';
        link.textContent = 'Open Directions';
        popupEl.appendChild(link);
      }

      marker.bindPopup(popupEl).addTo(group);
      if (isSelected) {
        marker.openPopup();
      }
    }
  }, [
    userLat,
    userLng,
    userAccuracyMeters,
    searchRadiusMeters,
    primaryRadiusColor,
    secondaryRadiusMeters,
    secondaryRadiusColor,
    markers,
    heatmapCircles,
    polylinePoints,
    selectedMarkerId,
  ]);

  return (
    <div
      ref={containerRef}
      className={`w-full ${heightClass} rounded-xl border border-slate-200 overflow-hidden bg-slate-100`}
    />
  );
};
