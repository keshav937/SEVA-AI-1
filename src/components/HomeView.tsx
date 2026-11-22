import React from 'react';
import {
  ArrowRight,
  Building2,
  Car,
  Compass,
  FileWarning,
  HeartPulse,
  MapPin,
  Mic,
  PawPrint,
  ShieldAlert,
  Trophy,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useLocationEngine } from '../contexts/LocationContext';
import { AppTab, CivicCategory, CivicReport } from '../types/seva';
import { LiveTrackingPanel } from './LiveTrackingPanel';

const CATEGORY_CARDS: Array<{ category: CivicCategory; dept: string; desc: string }> = [
  {
    category: 'Roads and Potholes',
    dept: 'Public Works Department',
    desc: 'Report damaged pavement, potholes, and missing signage with GPS coordinates.',
  },
  {
    category: 'Waste Management',
    dept: 'Municipal Corporation',
    desc: 'Report uncollected garbage, overflowing bins, or illegal dumping spots.',
  },
  {
    category: 'Blocked Drains and Waterlogging',
    dept: 'Municipal Corporation',
    desc: 'Alert stormwater and sanitation teams to clogged drains and flooding.',
  },
  {
    category: 'Traffic and Road Obstructions',
    dept: 'Traffic Police',
    desc: 'Report broken signals, fallen trees, or severe carriageway blockages.',
  },
  {
    category: 'Road Accident Reporting',
    dept: 'Emergency Control Room',
    desc: 'Fast-track accident alerts with live GPS, photo evidence, and nearby hospitals.',
  },
  {
    category: 'Medical Assistance',
    dept: 'Medical Services',
    desc: 'Connect with nearby hospitals, ambulance providers, and urgent care tracking.',
  },
  {
    category: 'Women and Child Safety',
    dept: 'Police Department',
    desc: 'Privacy-protected reporting and Seva Shield emergency assistance.',
  },
  {
    category: 'Animal Rescue and Welfare',
    dept: 'Animal Welfare & Rescue',
    desc: 'Report injured strays or wildlife hazards requiring rescue teams.',
  },
];

interface HomeViewProps {
  myReports: CivicReport[];
  onNavigate: (tab: AppTab) => void;
  onStartReportCategory: (cat: CivicCategory) => void;
  onOpenVoice: () => void;
}

export const HomeView: React.FC<HomeViewProps> = ({
  myReports,
  onNavigate,
  onStartReportCategory,
  onOpenVoice,
}) => {
  const { firebaseUser, profile, signingIn, signInWithGoogle } = useAuth();
  const { lat, lng, address, requestCurrentLocation } = useLocationEngine();

  return (
    <div className="space-y-10">
      {/* Hero Section */}
      <section className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-stretch">
        <div className="lg:col-span-7 flex flex-col justify-between border border-slate-200 rounded-2xl bg-slate-50 p-6 sm:p-8 space-y-6">
          <div className="space-y-4">
            <div className="text-xs font-semibold text-green-900 tracking-wide">
              One City · One Platform · A Safer Tomorrow
            </div>
            <h1
              className="font-display text-3xl sm:text-5xl font-bold tracking-tight text-slate-900 leading-tight"
              style={{ textWrap: 'balance' }}
            >
              Your City. Your Voice. Your Safety.
            </h1>
            <p className="text-base text-slate-600 leading-relaxed max-w-2xl">
              {firebaseUser && profile
                ? `Welcome back, ${profile.fullName}. Report civic issues by voice with SEVA SAATHI, request dedicated Medical or Road Accident dispatch, and track municipal resolution transparently.`
                : 'Report civic hazards by voice or photo, access dedicated SOS, Medical & Road Accident assistance around your live GPS location, and track municipal action transparently.'}
            </p>
          </div>

          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={onOpenVoice}
                className="inline-flex items-center gap-2 px-5 py-3 bg-green-900 text-white text-sm font-medium rounded-lg hover:bg-green-800 transition-colors"
              >
                <Mic className="w-4 h-4" />
                Speak with SEVA SAATHI
              </button>
              <button
                type="button"
                onClick={() => onNavigate('explore')}
                className="inline-flex items-center gap-2 px-5 py-3 bg-white border border-slate-300 text-slate-900 text-sm font-medium rounded-lg hover:bg-slate-100 transition-colors"
              >
                <Compass className="w-4 h-4" />
                Explore Nearby Services
              </button>
              {!firebaseUser && (
                <button
                  type="button"
                  disabled={signingIn}
                  onClick={() => signInWithGoogle()}
                  className="inline-flex items-center gap-2 px-4 py-3 text-sm font-medium text-green-900 hover:underline disabled:opacity-50"
                >
                  {signingIn ? 'Signing in...' : 'Citizen Sign In'}
                  <ArrowRight className="w-4 h-4" />
                </button>
              )}
            </div>

            {/* Live GPS Bar */}
            <div className="pt-4 border-t border-slate-200 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
              <div className="flex items-center gap-2">
                <MapPin className="w-4 h-4 text-green-900 shrink-0" />
                <span>
                  {lat !== null && lng !== null
                    ? `${address || 'GPS Acquired'} (${lat.toFixed(4)}, ${lng.toFixed(4)})`
                    : 'Live GPS idle — click to sense your location'}
                </span>
              </div>
              <button
                type="button"
                onClick={() => requestCurrentLocation()}
                className="font-semibold text-green-900 hover:underline"
              >
                {lat !== null ? 'Refresh GPS' : 'Sense My GPS'}
              </button>
            </div>
          </div>
        </div>

        <div className="lg:col-span-5">
          <img
            src="/src/assets/images/seva_hero_city_1795250515626.jpg"
            alt="Modern Indian smart city boulevard with organized traffic and green avenues"
            referrerPolicy="no-referrer"
            className="w-full h-72 lg:h-full object-cover rounded-2xl border border-slate-200"
          />
        </div>
      </section>

      {/* Dedicated Citizen Quick-Action Strip (Strictly Separated Modules) */}
      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <button
          type="button"
          onClick={() => onNavigate('shield')}
          className="text-left border border-slate-200 rounded-xl bg-white p-4 hover:border-red-600 transition-colors"
        >
          <div className="flex items-center gap-1.5 text-xs text-red-700 font-semibold">
            <ShieldAlert className="w-4 h-4" />
            Seva Shield SOS
          </div>
          <div className="text-sm font-semibold text-slate-900 mt-1">Women &amp; Personal Safety SOS</div>
          <div className="text-xs text-slate-500 mt-1">2s SOS trigger, caregiver SMS &amp; live share →</div>
        </button>

        <button
          type="button"
          onClick={() => onNavigate('medical')}
          className="text-left border border-slate-200 rounded-xl bg-white p-4 hover:border-emerald-700 transition-colors"
        >
          <div className="flex items-center gap-1.5 text-xs text-emerald-800 font-semibold">
            <HeartPulse className="w-4 h-4 text-red-600" />
            Medical Assistance
          </div>
          <div className="text-sm font-semibold text-slate-900 mt-1">Urgent Medical &amp; Ambulance</div>
          <div className="text-xs text-slate-500 mt-1">108/112, hospitals within 1–15km &amp; MED tracking →</div>
        </button>

        <button
          type="button"
          onClick={() => onNavigate('accident')}
          className="text-left border border-slate-200 rounded-xl bg-white p-4 hover:border-amber-600 transition-colors"
        >
          <div className="flex items-center gap-1.5 text-xs text-amber-800 font-semibold">
            <Car className="w-4 h-4" />
            Road Accident Help
          </div>
          <div className="text-sm font-semibold text-slate-900 mt-1">Crash Response &amp; Scene Photos</div>
          <div className="text-xs text-slate-500 mt-1">Dispatch police + trauma units &amp; ACC tracking →</div>
        </button>

        <button
          type="button"
          onClick={() => onNavigate('reports')}
          className="text-left border border-slate-200 rounded-xl bg-white p-4 hover:border-green-900 transition-colors"
        >
          <div className="text-xs text-slate-500">My Submitted Reports</div>
          <div className="font-mono text-2xl font-bold text-slate-900 mt-1 tabular-nums">
            {myReports.length}
          </div>
          <div className="text-xs text-green-900 font-medium mt-1">Track Status &amp; Reference Lookup →</div>
        </button>

        <button
          type="button"
          onClick={() => onNavigate('complaints')}
          className="text-left border border-slate-200 rounded-xl bg-white p-4 hover:border-green-900 transition-colors"
        >
          <div className="flex items-center gap-1.5 text-xs text-slate-700 font-semibold">
            <FileWarning className="w-4 h-4 text-amber-700" />
            Citizen Complaint Box
          </div>
          <div className="text-sm font-semibold text-slate-900 mt-1">Escalate Delayed or Unfair Action</div>
          <div className="text-xs text-slate-500 mt-1">Independent supervisor accountability →</div>
        </button>

        <button
          type="button"
          onClick={() => onNavigate('rewards')}
          className="text-left border border-slate-200 rounded-xl bg-white p-4 hover:border-green-900 transition-colors"
        >
          <div className="flex items-center gap-1.5 text-xs text-amber-700 font-semibold">
            <Trophy className="w-4 h-4" />
            Seva Samman Rewards
          </div>
          <div className="font-mono text-2xl font-bold text-slate-900 mt-1 tabular-nums">
            {profile?.points ?? 0} pts
          </div>
          <div className="text-xs text-slate-500 mt-1">{profile?.badgeTier || 'Civic Recognition'} →</div>
        </button>
      </section>

      {/* 8 Dedicated Civic Issue Categories (Includes Animal Rescue) */}
      <section className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="font-display text-2xl font-bold text-slate-900">
              Report an Issue by Department
            </h2>
            <p className="text-sm text-slate-600 mt-0.5">
              Each category includes AI vision &amp; text analysis, Seva Trust verification, and 5-step guided voice reporting.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => onStartReportCategory('Animal Rescue and Welfare')}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-900 hover:underline"
            >
              <PawPrint className="w-3.5 h-3.5" />
              Report Animal Rescue
            </button>
            <button
              type="button"
              onClick={onOpenVoice}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-green-900 hover:underline"
            >
              <Mic className="w-3.5 h-3.5" />
              Speak directly to SEVA SAATHI
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {CATEGORY_CARDS.map((card) => (
            <div
              key={card.category}
              className="border border-slate-200 rounded-xl bg-white p-4 flex flex-col justify-between gap-4"
            >
              <div>
                <div className="text-xs text-slate-500">{card.dept}</div>
                <h3 className="font-display text-base font-semibold text-slate-900 mt-1">
                  {card.category}
                </h3>
                <p className="text-xs text-slate-600 mt-1.5 leading-relaxed">{card.desc}</p>
              </div>
              <button
                type="button"
                onClick={() => onStartReportCategory(card.category)}
                className="w-full py-2 bg-slate-900 text-white text-xs font-medium rounded-lg hover:bg-green-900 transition-colors"
              >
                Report New Issue
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* Live GPS & Location Sharing */}
      <LiveTrackingPanel />

      {/* Public Notice for Signed-Out Visitors Only: Separate Authority Portal Login */}
      {!firebaseUser && (
        <section className="border border-slate-200 rounded-xl bg-slate-50 p-6 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h3 className="font-display text-lg font-semibold text-slate-900">
              Municipal, Police &amp; Emergency Authority Personnel?
            </h3>
            <p className="text-sm text-slate-600 mt-0.5">
              Authorized department officers use a separate, role-isolated Authority Operations Dashboard.
            </p>
          </div>
          <button
            type="button"
            onClick={() => onNavigate('authority')}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-slate-900 text-white text-sm font-medium rounded-lg hover:bg-slate-800 whitespace-nowrap"
          >
            <Building2 className="w-4 h-4" />
            Authority Portal Sign-In
          </button>
        </section>
      )}
    </div>
  );
};
