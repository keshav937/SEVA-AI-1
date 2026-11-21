import React, { useEffect, useState } from 'react';
import { Menu, Mic, X } from 'lucide-react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { AuthorityDashboardView } from './components/AuthorityDashboardView';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ExploreCityView } from './components/ExploreCityView';
import { HomeView } from './components/HomeView';
import { MyReportsView } from './components/MyReportsView';
import { ProfilePrivacyView } from './components/ProfilePrivacyView';
import { PublicTrackViewer } from './components/PublicTrackViewer';
import { ReportIssueView } from './components/ReportIssueView';
import { RewardsLeaderboardView } from './components/RewardsLeaderboardView';
import { SafetyHeatmapView } from './components/SafetyHeatmapView';
import { SevaSaathiPanel } from './components/SevaSaathiPanel';
import { SevaShieldView } from './components/SevaShieldView';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { LocationProvider } from './contexts/LocationContext';
import { OperationType, db, handleFirestoreError } from './lib/firebase';
import {
  AppTab,
  CivicCategory,
  CivicReport,
  SupportedLanguage,
  VoiceDraftPayload,
} from './types/seva';

const NAV_ITEMS: Array<{ id: AppTab; label: string }> = [
  { id: 'home', label: 'Home' },
  { id: 'explore', label: 'Explore City' },
  { id: 'report', label: 'Report Issue' },
  { id: 'shield', label: 'Seva Shield' },
  { id: 'heatmap', label: 'Safety Map' },
  { id: 'rewards', label: 'Rewards' },
  { id: 'reports', label: 'My Reports' },
  { id: 'profile', label: 'Profile' },
];

function SevaShell() {
  const { firebaseUser } = useAuth();

  const [activeTab, setActiveTab] = useState<AppTab>('home');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [language, setLanguage] = useState<SupportedLanguage>('en');
  const [reportCategorySeed, setReportCategorySeed] = useState<CivicCategory>('Roads and Potholes');
  const [voiceDraft, setVoiceDraft] = useState<VoiceDraftPayload | null>(null);
  const [externalSpeakReq, setExternalSpeakReq] = useState<{ text: string; id: number } | null>(null);

  const [myReports, setMyReports] = useState<CivicReport[]>([]);
  const [publicTrackToken, setPublicTrackToken] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('track');
  });

  // Subscribe to user's own Firestore reports + real-time WebSocket operational updates
  useEffect(() => {
    if (!firebaseUser) {
      setMyReports([]);
      return;
    }

    const q = query(collection(db, 'reports'), where('reporterUid', '==', firebaseUser.uid));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list = snap.docs.map((d) => ({ id: d.id, ...d.data() } as CivicReport));
        setMyReports(list);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'reports')
    );

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}/ws`);
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'subscribe', topic: `citizen:${firebaseUser.uid}` }));
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.event === 'report:updated' && msg.payload) {
          const updated = msg.payload as CivicReport;
          setMyReports((prev) =>
            prev.map((item) => (item.id === updated.id ? { ...item, ...updated } : item))
          );
        }
      } catch {
        // ignore
      }
    };

    return () => {
      unsub();
      ws.close();
    };
  }, [firebaseUser]);

  if (publicTrackToken) {
    return (
      <PublicTrackViewer
        shareToken={publicTrackToken}
        onExit={() => {
          setPublicTrackToken(null);
          window.history.replaceState({}, '', '/');
        }}
      />
    );
  }

  const handleNavigate = (tab: AppTab) => {
    setActiveTab(tab);
    setMobileMenuOpen(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleStartReportCategory = (cat: CivicCategory) => {
    setReportCategorySeed(cat);
    handleNavigate('report');
  };

  const handlePopulateReportDraft = (draft: VoiceDraftPayload) => {
    setVoiceDraft({ ...draft });
    handleNavigate('report');
  };

  const handleSpeakText = (text: string) => {
    setVoiceOpen(true);
    setExternalSpeakReq({ text, id: Date.now() });
  };

  return (
    <div className="min-h-screen flex flex-col bg-white text-slate-900">
      {/* Clean 3-Zone Top Bar Contract */}
      <header className="sticky top-0 z-40 bg-white/95 backdrop-blur border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-8">
          {/* Zone 1: Single-line Brand Wordmark */}
          <button
            type="button"
            onClick={() => handleNavigate('home')}
            className="font-display text-lg font-bold tracking-tight text-green-900 whitespace-nowrap shrink-0"
          >
            SEVA AI
          </button>

          {/* Zone 2: Single-line Text Navigation Links */}
          <nav className="hidden lg:flex items-center gap-5 text-sm font-medium text-slate-600">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => handleNavigate(item.id)}
                className={`whitespace-nowrap shrink-0 py-1 transition-colors border-b-2 ${
                  activeTab === item.id
                    ? 'text-green-900 border-green-900 font-semibold'
                    : 'border-transparent hover:text-slate-900'
                }`}
              >
                {item.label}
              </button>
            ))}
          </nav>

          {/* Zone 3: Single Primary Action + Mobile Menu Trigger */}
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setVoiceOpen(true)}
              className="inline-flex items-center gap-2 px-4 py-2 bg-green-900 text-white text-xs font-semibold rounded-lg hover:bg-green-800 transition-colors whitespace-nowrap shrink-0"
            >
              <Mic className="w-3.5 h-3.5" />
              SEVA SAATHI
            </button>

            <button
              type="button"
              onClick={() => setMobileMenuOpen((v) => !v)}
              aria-label="Toggle navigation menu"
              className="lg:hidden p-2 rounded-lg border border-slate-200 text-slate-700"
            >
              {mobileMenuOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {/* Mobile Drawer */}
        {mobileMenuOpen && (
          <div className="lg:hidden border-t border-slate-200 bg-white px-4 py-3 grid grid-cols-2 gap-2">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => handleNavigate(item.id)}
                className={`text-left px-3 py-2 rounded-lg text-xs font-medium ${
                  activeTab === item.id
                    ? 'bg-green-900 text-white'
                    : 'bg-slate-50 text-slate-700'
                }`}
              >
                {item.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => handleNavigate('authority')}
              className={`col-span-2 text-left px-3 py-2 rounded-lg text-xs font-medium ${
                activeTab === 'authority'
                  ? 'bg-green-900 text-white'
                  : 'bg-slate-100 text-slate-900'
              }`}
            >
              Authority Portal
            </button>
          </div>
        )}
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-8">
        {activeTab === 'home' && (
          <HomeView
            myReports={myReports}
            onNavigate={handleNavigate}
            onStartReportCategory={handleStartReportCategory}
            onOpenVoice={() => setVoiceOpen(true)}
          />
        )}
        {activeTab === 'explore' && <ExploreCityView />}
        {activeTab === 'report' && (
          <ReportIssueView
            initialCategory={reportCategorySeed}
            voiceDraft={voiceDraft}
            onOpenVoiceAssistant={() => setVoiceOpen(true)}
            onSubmittedSuccess={() => handleNavigate('reports')}
          />
        )}
        {activeTab === 'shield' && <SevaShieldView onSpeakText={handleSpeakText} />}
        {activeTab === 'heatmap' && <SafetyHeatmapView />}
        {activeTab === 'rewards' && <RewardsLeaderboardView />}
        {activeTab === 'reports' && (
          <MyReportsView reports={myReports} onGoToReport={() => handleNavigate('report')} />
        )}
        {activeTab === 'profile' && <ProfilePrivacyView />}
        {activeTab === 'authority' && <AuthorityDashboardView onSpeakText={handleSpeakText} />}
      </main>

      {/* Quiet Civic Footer */}
      <footer className="border-t border-slate-200 bg-slate-50 mt-12">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 flex flex-wrap items-center justify-between gap-4 text-xs text-slate-600">
          <div>
            <strong className="text-slate-900">SEVA AI</strong> · Smart City Civic Assistance &amp; Public Safety Platform · Seva First Innovation Challenge 2026
          </div>
          <div className="flex flex-wrap items-center gap-5">
            <span>Emergency Helplines: 112 (Police) · 108 (Ambulance) · 1091 (Women)</span>
            <button
              type="button"
              onClick={() => handleNavigate('authority')}
              className="font-semibold text-green-900 hover:underline"
            >
              Authority Portal
            </button>
            <button
              type="button"
              onClick={() => handleNavigate('profile')}
              className="hover:underline"
            >
              DPDP Privacy Hub
            </button>
          </div>
        </div>
      </footer>

      {/* SEVA SAATHI ElevenLabs Voice Assistant Drawer */}
      <SevaSaathiPanel
        isOpen={voiceOpen}
        onClose={() => setVoiceOpen(false)}
        language={language}
        onLanguageChange={setLanguage}
        myReports={myReports}
        onPopulateReportDraft={handlePopulateReportDraft}
        onNavigate={handleNavigate}
        externalSpeakRequest={externalSpeakReq}
      />
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <LocationProvider>
          <SevaShell />
        </LocationProvider>
      </AuthProvider>
    </ErrorBoundary>
  );
}
