import React, { useState } from 'react';
import {
  AlertTriangle,
  Copy,
  Check,
  MapPin,
  Navigation,
  Pause,
  Play,
  Share2,
  ShieldOff,
  Square,
} from 'lucide-react';
import { useLocationEngine } from '../contexts/LocationContext';
import { LeafletMap } from './LeafletMap';

export const LiveTrackingPanel: React.FC = () => {
  const {
    lat,
    lng,
    accuracyMeters,
    address,
    lastUpdated,
    gpsState,
    gpsError,
    trackingState,
    shareToken,
    shareExpiresAt,
    trackingHistory,
    requestCurrentLocation,
    startLiveTracking,
    pauseLiveTracking,
    resumeLiveTracking,
    stopLiveTracking,
    revokeShareLink,
  } = useLocationEngine();

  const [shareConsent, setShareConsent] = useState(false);
  const [copied, setCopied] = useState(false);

  const shareUrl = shareToken ? `${window.location.origin}/?track=${shareToken}` : '';

  const handleStart = async () => {
    await startLiveTracking(true);
  };

  const handleCopy = () => {
    if (!shareUrl) return;
    navigator.clipboard.writeText(shareUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const stateLabels: Record<string, string> = {
    idle: 'Location not requested yet',
    requesting: 'Requesting permission...',
    acquiring: 'Finding GPS location...',
    acquired: 'Location acquired',
    improving: 'Improving GPS accuracy...',
    weak: 'Weak GPS signal',
    denied: 'Permission denied',
    timeout: 'GPS timed out',
    unavailable: 'GPS unavailable',
    offline: 'Network disconnected',
  };

  return (
    <div className="border border-slate-200 rounded-xl bg-white p-5 space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className="font-display text-lg font-semibold text-slate-900">
            Live GPS Sensing &amp; Location Tracking
          </h3>
          <p className="text-sm text-slate-600 mt-0.5">
            Real browser geolocation with WebSocket relay and revocable family sharing links.
          </p>
        </div>

        <button
          type="button"
          onClick={() => requestCurrentLocation()}
          className="inline-flex items-center gap-2 px-4 py-2 bg-green-900 text-white text-sm font-medium rounded-lg hover:bg-green-800 transition-colors whitespace-nowrap"
        >
          <Navigation className="w-4 h-4" />
          Sense My GPS Location
        </button>
      </div>

      {/* Honest Telemetry Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
          <div className="text-xs text-slate-500">GPS Status</div>
          <div className="text-sm font-medium text-slate-900 mt-0.5">{stateLabels[gpsState]}</div>
        </div>
        <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
          <div className="text-xs text-slate-500">Coordinates</div>
          <div className="font-mono text-xs text-slate-900 mt-1 tabular-nums">
            {lat !== null && lng !== null ? `${lat.toFixed(5)}, ${lng.toFixed(5)}` : 'Not acquired'}
          </div>
        </div>
        <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
          <div className="text-xs text-slate-500">Accuracy</div>
          <div className="font-mono text-sm font-medium text-slate-900 mt-0.5 tabular-nums">
            {accuracyMeters !== null ? `±${accuracyMeters} m` : '—'}
          </div>
        </div>
        <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
          <div className="text-xs text-slate-500">Last Updated</div>
          <div className="font-mono text-xs text-slate-900 mt-1 tabular-nums">
            {lastUpdated ? new Date(lastUpdated).toLocaleTimeString() : '—'}
          </div>
        </div>
      </div>

      {address && (
        <div className="flex items-start gap-2 text-sm text-slate-700 bg-slate-50 border border-slate-200 rounded-lg px-3.5 py-2.5">
          <MapPin className="w-4 h-4 text-green-900 shrink-0 mt-0.5" />
          <span>{address}</span>
        </div>
      )}

      {gpsError && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-3.5 py-2.5">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{gpsError}</span>
          </div>
          <button
            type="button"
            onClick={() => requestCurrentLocation()}
            className="px-2.5 py-1 bg-amber-900 text-white rounded font-semibold shrink-0 hover:bg-amber-800"
          >
            Retry GPS
          </button>
        </div>
      )}

      {/* Live Map */}
      {lat !== null && lng !== null ? (
        <LeafletMap
          centerLat={lat}
          centerLng={lng}
          zoom={16}
          userLat={lat}
          userLng={lng}
          userAccuracyMeters={accuracyMeters}
          polylinePoints={trackingHistory.map((p) => [p.lat, p.lng])}
          heightClass="h-[300px]"
        />
      ) : (
        <div className="h-[200px] rounded-xl border border-dashed border-slate-300 bg-slate-50 flex flex-col items-center justify-center text-center p-6">
          <MapPin className="w-6 h-6 text-slate-400 mb-2" />
          <p className="text-sm font-medium text-slate-700">Waiting for real device coordinates</p>
          <p className="text-xs text-slate-500 mt-1 max-w-md">
            Click &ldquo;Sense My GPS Location&rdquo; above and grant browser location permission to view your live map.
          </p>
        </div>
      )}

      {/* Live Tracking & Sharing Controls */}
      <div className="pt-4 border-t border-slate-200 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-slate-900">
              Live Location Tracking Session ({trackingState.toUpperCase()})
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              Updates every 3–5 seconds while this page remains open and active.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {(trackingState === 'idle' || trackingState === 'stopped') && (
              <button
                type="button"
                onClick={handleStart}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-emerald-700 text-white text-xs font-medium rounded-lg hover:bg-emerald-800"
              >
                <Play className="w-3.5 h-3.5" />
                Start Tracking
              </button>
            )}
            {trackingState === 'active' && (
              <button
                type="button"
                onClick={pauseLiveTracking}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-amber-600 text-white text-xs font-medium rounded-lg hover:bg-amber-700"
              >
                <Pause className="w-3.5 h-3.5" />
                Pause Tracking
              </button>
            )}
            {trackingState === 'paused' && (
              <button
                type="button"
                onClick={resumeLiveTracking}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-emerald-700 text-white text-xs font-medium rounded-lg hover:bg-emerald-800"
              >
                <Play className="w-3.5 h-3.5" />
                Resume Tracking
              </button>
            )}
            {(trackingState === 'active' || trackingState === 'paused') && (
              <button
                type="button"
                onClick={() => stopLiveTracking()}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-slate-800 text-white text-xs font-medium rounded-lg hover:bg-slate-900"
              >
                <Square className="w-3.5 h-3.5" />
                Stop Tracking
              </button>
            )}
          </div>
        </div>

        {/* Shareable Temporary Link */}
        {shareToken && (
          <div className="bg-slate-50 border border-slate-200 rounded-lg p-3.5 space-y-2.5">
            <label className="flex items-start gap-2 text-xs text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={shareConsent}
                onChange={(e) => setShareConsent(e.target.checked)}
                className="mt-0.5 rounded border-slate-300 text-green-900"
              />
              <span>
                I explicitly consent to sharing my temporary live location link with selected family members or trusted contacts (expires {shareExpiresAt ? new Date(shareExpiresAt).toLocaleTimeString() : 'in 2 hours'}).
              </span>
            </label>

            {shareConsent && (
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex-1 min-w-[200px] font-mono text-xs bg-white border border-slate-200 rounded-md px-2.5 py-1.5 text-slate-800 truncate">
                  {shareUrl}
                </div>
                <button
                  type="button"
                  onClick={handleCopy}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-green-900 text-white text-xs font-medium rounded-md hover:bg-green-800"
                >
                  {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? 'Copied' : 'Share Link'}
                </button>
                <a
                  href={shareUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-slate-300 text-slate-800 text-xs font-medium rounded-md hover:bg-slate-100"
                >
                  <Share2 className="w-3.5 h-3.5" />
                  Preview Recipient View
                </a>
                <button
                  type="button"
                  onClick={() => revokeShareLink()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-red-600 text-white text-xs font-medium rounded-md hover:bg-red-700"
                >
                  <ShieldOff className="w-3.5 h-3.5" />
                  Revoke Sharing
                </button>
              </div>
            )}
          </div>
        )}

        {trackingHistory.length > 0 && (
          <div className="text-xs text-slate-600">
            <span className="font-medium text-slate-800">
              Recorded Waypoints ({trackingHistory.length}):
            </span>{' '}
            Latest at{' '}
            <span className="font-mono tabular-nums">
              {trackingHistory[trackingHistory.length - 1].lat.toFixed(5)},{' '}
              {trackingHistory[trackingHistory.length - 1].lng.toFixed(5)}
            </span>
          </div>
        )}

        <p className="text-xs text-slate-500">
          Browser GPS limitation: Continuous location updates require this browser tab to remain open and unlocked. Operating systems may suspend background GPS when a phone screen is locked.
        </p>
      </div>
    </div>
  );
};
