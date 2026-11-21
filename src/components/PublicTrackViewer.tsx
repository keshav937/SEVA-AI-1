import React, { useEffect, useState } from 'react';
import { AlertCircle, ArrowLeft, MapPin, Radio } from 'lucide-react';
import { LeafletMap } from './LeafletMap';

interface PublicTrackingData {
  shareToken: string;
  ownerDisplayName: string;
  status: string;
  lat: number;
  lng: number;
  accuracyMeters: number;
  address: string;
  expiresAt: string;
  updatedAt: string;
  history: Array<{ lat: number; lng: number; timestamp: string }>;
}

export const PublicTrackViewer: React.FC<{ shareToken: string; onExit: () => void }> = ({
  shareToken,
  onExit,
}) => {
  const [data, setData] = useState<PublicTrackingData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wsConnected, setWsConnected] = useState(false);

  useEffect(() => {
    let active = true;

    fetch(`/api/tracking/${encodeURIComponent(shareToken)}`)
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Tracking link unavailable.');
        if (active) setData(json);
      })
      .catch((err: any) => {
        if (active) setError(err?.message || 'Unable to load tracking session.');
      });

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}/ws`);

    ws.onopen = () => {
      setWsConnected(true);
      ws.send(JSON.stringify({ type: 'subscribe', topic: `track:${shareToken}` }));
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.event === 'tracking:update' && msg.payload) {
          if (msg.payload.status === 'revoked') {
            setError('This live location sharing link was revoked by the sender.');
            setData(null);
          } else {
            setData(msg.payload);
          }
        }
      } catch {
        // ignore
      }
    };

    ws.onclose = () => setWsConnected(false);

    return () => {
      active = false;
      ws.close();
    };
  }, [shareToken]);

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-8">
      <div className="max-w-4xl mx-auto space-y-5">
        <div className="flex items-center justify-between gap-4">
          <button
            type="button"
            onClick={onExit}
            className="inline-flex items-center gap-2 text-sm font-medium text-green-900 hover:underline"
          >
            <ArrowLeft className="w-4 h-4" />
            Return to SEVA AI
          </button>
          <div className="inline-flex items-center gap-2 text-xs text-slate-600">
            <Radio className={`w-3.5 h-3.5 ${wsConnected ? 'text-emerald-600' : 'text-slate-400'}`} />
            {wsConnected ? 'Live WebSocket Connected' : 'Connecting to live stream...'}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <h1 className="font-display text-xl font-semibold text-slate-900">
            SEVA AI Live Location Share
          </h1>

          {error && (
            <div className="flex items-start gap-2.5 text-sm text-red-800 bg-red-50 border border-red-200 rounded-lg p-4">
              <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {data && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
                  <div className="text-xs text-slate-500">Shared By</div>
                  <div className="text-sm font-medium text-slate-900 mt-0.5">{data.ownerDisplayName}</div>
                </div>
                <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
                  <div className="text-xs text-slate-500">Session Status</div>
                  <div className="text-sm font-medium text-emerald-700 mt-0.5 uppercase">{data.status}</div>
                </div>
                <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
                  <div className="text-xs text-slate-500">Accuracy</div>
                  <div className="font-mono text-sm text-slate-900 mt-0.5 tabular-nums">
                    ±{data.accuracyMeters} m
                  </div>
                </div>
                <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
                  <div className="text-xs text-slate-500">Last Updated</div>
                  <div className="font-mono text-xs text-slate-900 mt-1 tabular-nums">
                    {new Date(data.updatedAt).toLocaleTimeString()}
                  </div>
                </div>
              </div>

              <div className="flex items-start gap-2 text-sm text-slate-700 bg-slate-50 border border-slate-200 rounded-lg px-3.5 py-2.5">
                <MapPin className="w-4 h-4 text-green-900 shrink-0 mt-0.5" />
                <span>
                  {data.address || `${data.lat.toFixed(5)}, ${data.lng.toFixed(5)}`}
                </span>
              </div>

              <LeafletMap
                centerLat={data.lat}
                centerLng={data.lng}
                zoom={16}
                userLat={data.lat}
                userLng={data.lng}
                userAccuracyMeters={data.accuracyMeters}
                polylinePoints={data.history.map((h) => [h.lat, h.lng])}
                heightClass="h-[400px]"
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
};
