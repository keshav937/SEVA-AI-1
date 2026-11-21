import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Info, RefreshCw } from 'lucide-react';
import { useLocationEngine } from '../contexts/LocationContext';
import { HeatmapCircleItem, LeafletMap } from './LeafletMap';

interface HeatmapIncident {
  id: string;
  category: string;
  severity: 'Low' | 'Medium' | 'High' | 'Critical';
  ward: string;
  locality: string;
  lat: number;
  lng: number;
  isSensitiveArea: boolean;
  status: string;
  createdAt: string;
}

export const SafetyHeatmapView: React.FC = () => {
  const { lat, lng, requestCurrentLocation } = useLocationEngine();

  const [incidents, setIncidents] = useState<HeatmapIncident[]>([]);
  const [updatedAt, setUpdatedAt] = useState<string>('');
  const [categoryFilter, setCategoryFilter] = useState('All');
  const [severityFilter, setSeverityFilter] = useState('All');
  const [timeFilter, setTimeFilter] = useState<'all' | 'day' | 'night'>('all');
  const [loading, setLoading] = useState(false);

  const loadHeatmap = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (categoryFilter !== 'All') qs.set('category', categoryFilter);
      if (severityFilter !== 'All') qs.set('severity', severityFilter);
      const res = await fetch(`/api/heatmap?${qs.toString()}`);
      const data = await res.json();
      setIncidents(data.incidents || []);
      setUpdatedAt(data.updatedAt || new Date().toISOString());
    } finally {
      setLoading(false);
    }
  }, [categoryFilter, severityFilter]);

  useEffect(() => {
    loadHeatmap();
  }, [loadHeatmap]);

  const filteredByTime = useMemo(() => {
    if (timeFilter === 'all') return incidents;
    return incidents.filter((inc) => {
      const hour = new Date(inc.createdAt).getHours();
      const isDay = hour >= 6 && hour < 19;
      return timeFilter === 'day' ? isDay : !isDay;
    });
  }, [incidents, timeFilter]);

  // Geographic clustering by ~0.01 deg grid (~1.1 km)
  const circles: HeatmapCircleItem[] = useMemo(() => {
    const clusters = new Map<
      string,
      { latSum: number; lngSum: number; count: number; maxSev: string; ward: string }
    >();

    for (const inc of filteredByTime) {
      const key = `${inc.lat.toFixed(2)}:${inc.lng.toFixed(2)}`;
      const cur = clusters.get(key) || {
        latSum: 0,
        lngSum: 0,
        count: 0,
        maxSev: inc.severity,
        ward: inc.ward,
      };
      cur.latSum += inc.lat;
      cur.lngSum += inc.lng;
      cur.count += 1;
      if (inc.severity === 'Critical' || inc.severity === 'High') cur.maxSev = inc.severity;
      clusters.set(key, cur);
    }

    return Array.from(clusters.entries()).map(([key, c]) => {
      const densityColor =
        c.count >= 4 || c.maxSev === 'Critical'
          ? '#DC2626'
          : c.count >= 2 || c.maxSev === 'High'
          ? '#D97706'
          : '#059669';
      const levelLabel =
        densityColor === '#DC2626'
          ? 'High reported density'
          : densityColor === '#D97706'
          ? 'Moderate reported density'
          : 'Low reported density';
      return {
        id: key,
        lat: c.latSum / c.count,
        lng: c.lngSum / c.count,
        radiusMeters: Math.min(900, 300 + c.count * 120),
        color: densityColor,
        label: `${c.ward} · ${c.count} approved report(s) · ${levelLabel}`,
      };
    });
  }, [filteredByTime]);

  const mapCenterLat = lat ?? filteredByTime[0]?.lat ?? 28.6139;
  const mapCenterLng = lng ?? filteredByTime[0]?.lng ?? 77.209;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900">
            City Safety Intelligence Heatmap
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Privacy-preserving density visualization of approved civic and public safety incident reports.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => requestCurrentLocation()}
            className="px-3.5 py-2 border border-slate-200 text-slate-800 text-xs font-medium rounded-lg hover:bg-slate-50"
          >
            Center on My GPS
          </button>
          <button
            type="button"
            onClick={loadHeatmap}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-green-900 text-white text-xs font-medium rounded-lg hover:bg-green-800"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="border border-slate-200 rounded-xl bg-white p-4 flex flex-wrap items-center gap-4">
        <div>
          <label className="block text-xs text-slate-500 mb-1">Category</label>
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="text-xs border border-slate-200 rounded-lg px-3 py-2 bg-white"
          >
            <option value="All">All Categories</option>
            <option value="Roads and Potholes">Roads and Potholes</option>
            <option value="Waste Management">Waste Management</option>
            <option value="Blocked Drains and Waterlogging">Blocked Drains and Waterlogging</option>
            <option value="Traffic and Road Obstructions">Traffic and Road Obstructions</option>
            <option value="Road Accident Reporting">Road Accident Reporting</option>
            <option value="Women and Child Safety">Women and Child Safety</option>
            <option value="Animal Rescue and Welfare">Animal Rescue and Welfare</option>
          </select>
        </div>

        <div>
          <label className="block text-xs text-slate-500 mb-1">Severity</label>
          <select
            value={severityFilter}
            onChange={(e) => setSeverityFilter(e.target.value)}
            className="text-xs border border-slate-200 rounded-lg px-3 py-2 bg-white"
          >
            <option value="All">All Severities</option>
            <option value="Low">Low</option>
            <option value="Medium">Medium</option>
            <option value="High">High</option>
            <option value="Critical">Critical</option>
          </select>
        </div>

        <div>
          <label className="block text-xs text-slate-500 mb-1">Time of Day</label>
          <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg">
            {(['all', 'day', 'night'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTimeFilter(t)}
                className={`px-2.5 py-1 text-xs font-medium rounded-md capitalize ${
                  timeFilter === t ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        <div className="ml-auto text-xs text-slate-500 tabular-nums">
          {filteredByTime.length} approved records · Updated{' '}
          {updatedAt ? new Date(updatedAt).toLocaleTimeString() : 'just now'}
        </div>
      </div>

      {/* Map + Legend */}
      <LeafletMap
        centerLat={mapCenterLat}
        centerLng={mapCenterLng}
        zoom={12}
        userLat={lat}
        userLng={lng}
        heatmapCircles={circles}
        heightClass="h-[440px]"
      />

      <div className="border border-slate-200 rounded-xl bg-slate-50 p-4 flex flex-wrap items-center justify-between gap-4 text-xs">
        <div className="flex flex-wrap items-center gap-5">
          <span className="inline-flex items-center gap-2 font-medium text-slate-800">
            <span className="w-3 h-3 rounded-full bg-emerald-600" />
            Low Reported Incident Density
          </span>
          <span className="inline-flex items-center gap-2 font-medium text-slate-800">
            <span className="w-3 h-3 rounded-full bg-amber-600" />
            Moderate Reported Incident Density
          </span>
          <span className="inline-flex items-center gap-2 font-medium text-slate-800">
            <span className="w-3 h-3 rounded-full bg-red-600" />
            High Reported Incident Density
          </span>
        </div>

        <div className="flex items-center gap-1.5 text-slate-600">
          <Info className="w-4 h-4 shrink-0" />
          <span>
            Displays reported incident density from verified records only (reporter identities hidden; sensitive coordinates fuzzed). Not a definitive prediction of danger.
          </span>
        </div>
      </div>
    </div>
  );
};
