import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Bell, Lock, LogIn, Menu, Mic, ShieldCheck, User, X } from 'lucide-react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { AuthorityDashboardView } from './components/AuthorityDashboardView';
import { ComplaintBoxView } from './components/ComplaintBoxView';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ExploreCityView } from './components/ExploreCityView';
import { HomeView } from './components/HomeView';
import { MedicalAssistanceView } from './components/MedicalAssistanceView';
import { MyReportsView } from './components/MyReportsView';
import { ProfilePrivacyView } from './components/ProfilePrivacyView';
import { PublicTrackViewer } from './components/PublicTrackViewer';
import { ReportIssueView } from './components/ReportIssueView';
import { RewardsLeaderboardView } from './components/RewardsLeaderboardView';
import { RoadAccidentView } from './components/RoadAccidentView';
import { SafetyHeatmapView } from './components/SafetyHeatmapView';
import { SevaSaathiPanel } from './components/SevaSaathiPanel';
import { SevaShieldView } from './components/SevaShieldView';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { LocationProvider } from './contexts/LocationContext';
import { OperationType, buildFirestoreErrorInfo, db } from './lib/firebase';
import {
  AppTab,
  CivicCategory,
  CivicReport,
  SupportedLanguage,
  VoiceDraftPayload,
} from './types/seva';

const CITIZEN_NAV_ITEMS: Array<{ id: AppTab; label: string }> = [
  { id: 'home', label: 'Home' },
  { id: 'explore', label: 'Explore' },
  { id: 'report', label: 'Report Issue' },
  { id: 'shield', label: 'SOS' },
  { id: 'medical', label: 'Medical' },
  { id: 'accident', label: 'Accident' },
  { id: 'complaints', label: 'Complaints' },
  { id: 'heatmap', label: 'Safety Map' },
  { id: 'rewards', label: 'Rewards' },
  { id: 'reports', label: 'My Reports' },
  { id: 'profile', label: 'Profile' },
];

function isUrlRequestingAuthority(): boolean {
  const params = new URLSearchParams(window.location.search);
  const hash = window.location.hash.toLowerCase();
  return (
    params.get('portal') === 'authority' ||
    params.get('tab') === 'authority' ||
    hash.includes('authority')
  );
}

function SevaShell() {
  const {
    firebaseUser,
    profile,
    authoritySession,
    clearAuthoritySession,
    signingIn,
    signInWithGoogle,
    authError,
    clearAuthError,
    firestoreStatus,
  } = useAuth();

  const [activeTab, setActiveTab] = useState<AppTab>(() =>
    isUrlRequestingAuthority() ? 'authority' : 'home'
  );
  const [roleGuardBanner, setRoleGuardBanner] = useState<string | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [language, setLanguage] = useState<SupportedLanguage>('en');
  const [reportCategorySeed, setReportCategorySeed] = useState<CivicCategory>('Roads and Potholes');
  const [voiceDraft, setVoiceDraft] = useState<VoiceDraftPayload | null>(null);
  const [externalSpeakReq, setExternalSpeakReq] = useState<{ text: string; id: number } | null>(null);
  const [authorityModuleJump, setAuthorityModuleJump] = useState<{ module: 'notifications'; id: number } | null>(null);

  const [firestoreReports, setFirestoreReports] = useState<CivicReport[]>([]);
  const [serverReportsById, setServerReportsById] = useState<Record<string, Partial<CivicReport>>>({});
  const [reportsError, setReportsError] = useState<string | null>(null);
  const [unreadNotifications, setUnreadNotifications] = useState(0);

  const [publicTrackToken, setPublicTrackToken] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('track');
  });

  const isBootstrappedAdminEmail =
    firebaseUser?.email?.toLowerCase() === 'guptakeshav2178@gmail.com';
  const isLoggedCitizen =
    Boolean(firebaseUser) && !authoritySession && profile?.role === 'citizen' && !isBootstrappedAdminEmail;

  // Enforce strict RBAC isolation on URL tampering or role state transitions
  useEffect(() => {
    if (authoritySession) {
      setActiveTab('authority');
      setRoleGuardBanner(null);
      return;
    }
    if (isLoggedCitizen && (activeTab === 'authority' || isUrlRequestingAuthority())) {
      setActiveTab('home');
      setRoleGuardBanner(
        'Access Restricted: Citizen accounts can only access the Citizen Dashboard. Sign out of Citizen mode first to log in with official Authority credentials.'
      );
      if (window.location.hash || window.location.search.includes('authority')) {
        window.history.replaceState({}, '', '/');
      }
    }
  }, [activeTab, authoritySession, isLoggedCitizen]);

  useEffect(() => {
    const onHashChange = () => {
      if (authoritySession) {
        setActiveTab('authority');
        return;
      }
      if (isLoggedCitizen && isUrlRequestingAuthority()) {
        setActiveTab('home');
        setRoleGuardBanner(
          'Access Restricted: Citizen accounts cannot switch to the Authority Portal via URL.'
        );
        window.history.replaceState({}, '', '/');
      }
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [authoritySession, isLoggedCitizen]);

  const fetchCitizenServerReports = useCallback(async () => {
    if (!firebaseUser || authoritySession) return;
    try {
      const res = await fetch(`/api/citizen/reports/${encodeURIComponent(firebaseUser.uid)}`);
      const data = await res.json();
      if (res.ok && Array.isArray(data.reports)) {
        const mapped: Record<string, Partial<CivicReport>> = {};
        for (const rep of data.reports as CivicReport[]) {
          mapped[rep.id] = rep;
        }
        setServerReportsById(mapped);
      }
    } catch {
      // ignore
    }
  }, [authoritySession, firebaseUser]);

  const fetchUnreadBadge = useCallback(async () => {
    try {
      if (authoritySession) {
        const res = await fetch('/api/notifications', {
          headers: { Authorization: `Bearer ${authoritySession.token}` },
        });
        const data = await res.json();
        if (res.ok && typeof data.unreadCount === 'number') {
          setUnreadNotifications(data.unreadCount);
        }
      } else if (firebaseUser) {
        const res = await fetch(`/api/notifications?uid=${encodeURIComponent(firebaseUser.uid)}`);
        const data = await res.json();
        if (res.ok && typeof data.unreadCount === 'number') {
          setUnreadNotifications(data.unreadCount);
        }
      } else {
        setUnreadNotifications(0);
      }
    } catch {
      // ignore
    }
  }, [authoritySession, firebaseUser]);

  useEffect(() => {
    fetchUnreadBadge();
  }, [fetchUnreadBadge]);

  // Subscribe to user's own Firestore reports + backend ledger + WebSocket updates (Citizen only)
  useEffect(() => {
    if (!firebaseUser || authoritySession) {
      if (!firebaseUser) {
        setFirestoreReports([]);
        setServerReportsById({});
        setReportsError(null);
      }
      return;
    }

    fetchCitizenServerReports();

    const q = query(collection(db, 'reports'), where('reporterUid', '==', firebaseUser.uid));
    const unsub = onSnapshot(
      q,
      (snap) => {
        setReportsError(null);
        const list = snap.docs.map((d) => ({ id: d.id, ...d.data() } as CivicReport));
        setFirestoreReports(list);
      },
      (err) => {
        const info = buildFirestoreErrorInfo(err, OperationType.LIST, 'reports');
        setReportsError(`Unable to sync reports from Firestore: ${info.error}`);
      }
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
          setServerReportsById((prev) => ({
            ...prev,
            [updated.id]: updated,
          }));
        }
        if (msg.event === 'notification:new') {
          fetchUnreadBadge();
        }
      } catch {
        // ignore
      }
    };

    return () => {
      unsub();
      ws.close();
    };
  }, [authoritySession, fetchCitizenServerReports, fetchUnreadBadge, firebaseUser]);

  // Real-time WebSocket unread badge updates when inside Authority session
  useEffect(() => {
    if (!authoritySession) return;
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}/ws`);
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'subscribe', topic: 'authority:all' }));
      ws.send(JSON.stringify({ type: 'subscribe', topic: `officer:${authoritySession.uid}` }));
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.event === 'notification:new' || msg.event === 'report:new' || msg.event === 'sos:alert') {
          fetchUnreadBadge();
        }
      } catch {
        // ignore
      }
    };
    return () => ws.close();
  }, [authoritySession, fetchUnreadBadge]);

  const myReports = React.useMemo(() => {
    const mergedMap = new Map<string, CivicReport>();
    for (const fsRep of firestoreReports) {
      const srv = serverReportsById[fsRep.id];
      if (!srv) {
        mergedMap.set(fsRep.id, fsRep);
      } else {
        mergedMap.set(fsRep.id, {
          ...fsRep,
          referenceNumber: srv.referenceNumber || fsRep.referenceNumber,
          status: srv.status || fsRep.status,
          verificationStatus: srv.verificationStatus || fsRep.verificationStatus,
          fraudQueueStatus: srv.fraudQueueStatus || fsRep.fraudQueueStatus,
          additionalEvidenceRequested: srv.additionalEvidenceRequested,
          additionalEvidenceRequestNote: srv.additionalEvidenceRequestNote,
          citizenEvidenceUploads: srv.citizenEvidenceUploads,
          assignedOfficer: srv.assignedOfficer ?? fsRep.assignedOfficer,
          assignmentHistory: srv.assignmentHistory || fsRep.assignmentHistory,
          actionNotes: srv.actionNotes ?? fsRep.actionNotes,
          resolutionNotes: srv.resolutionNotes ?? fsRep.resolutionNotes,
          resolutionEvidence: srv.resolutionEvidence || fsRep.resolutionEvidence,
          citizenConfirmedResolution: srv.citizenConfirmedResolution,
          reopenReason: srv.reopenReason,
          disputeHistory: srv.disputeHistory,
          feedbackRating: srv.feedbackRating ?? fsRep.feedbackRating,
          feedbackComment: srv.feedbackComment ?? fsRep.feedbackComment,
          slaDeadlineAt: srv.slaDeadlineAt,
          timeline: srv.timeline || fsRep.timeline,
        });
      }
    }
    return Array.from(mergedMap.values());
  }, [firestoreReports, serverReportsById]);

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
    if (authoritySession) {
      // Strictly lock Authority sessions inside Authority Dashboard
      setActiveTab('authority');
      setMobileMenuOpen(false);
      return;
    }
    if (isLoggedCitizen && tab === 'authority') {
      setRoleGuardBanner(
        'Access Denied: Signed-in Citizens cannot open the Authority Portal directly. Sign out of your Citizen session first.'
      );
      setActiveTab('home');
      setMobileMenuOpen(false);
      return;
    }
    setRoleGuardBanner(null);
    setActiveTab(tab);
    setMobileMenuOpen(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleStartReportCategory = (cat: CivicCategory) => {
    setReportCategorySeed(cat);
    handleNavigate('report');
  };

  const handlePopulateReportDraft = (draft: VoiceDraftPayload) => {
    if (authoritySession) return;
    setVoiceDraft({ ...draft });
    handleNavigate('report');
  };

  const handleSpeakText = (text: string) => {
    setVoiceOpen(true);
    setExternalSpeakReq({ text, id: Date.now() });
  };

  // =========================================================================
  // DEDICATED AUTHORITY PORTAL SHELL (STRICTLY SEPARATED FROM CITIZEN SHELL)
  // =========================================================================
  if (authoritySession) {
    return (
      <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
        <header className="sticky top-0 z-40 bg-slate-900 text-white border-b border-slate-800">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0">
              <ShieldCheck className="w-5 h-5 text-emerald-400 shrink-0" />
              <div className="truncate">
                <span className="font-display text-base sm:text-lg font-bold tracking-tight">
                  SEVA AI · AUTHORITY PORTAL
                </span>
                <span className="hidden md:inline-block ml-3 text-xs text-slate-300">
                  {authoritySession.department} · {authoritySession.role.toUpperCase()}
                </span>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => setAuthorityModuleJump({ module: 'notifications', id: Date.now() })}
                aria-label="Authority Notifications"
                className="relative p-2 rounded-lg border border-slate-700 text-slate-200 hover:bg-slate-800"
              >
                <Bell className="w-4 h-4" />
                {unreadNotifications > 0 && (
                  <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-red-600 text-white text-[10px] font-bold flex items-center justify-center">
                    {unreadNotifications}
                  </span>
                )}
              </button>

              <button
                type="button"
                onClick={() => setVoiceOpen(true)}
                className="inline-flex items-center gap-2 px-3 py-2 bg-emerald-700 text-white text-xs font-semibold rounded-lg hover:bg-emerald-600 whitespace-nowrap"
              >
                <Mic className="w-3.5 h-3.5" />
                SEVA SAATHI
              </button>

              <button
                type="button"
                onClick={clearAuthoritySession}
                className="inline-flex items-center gap-1.5 px-3 py-2 bg-slate-800 border border-slate-700 text-slate-200 text-xs font-medium rounded-lg hover:bg-slate-700 whitespace-nowrap"
              >
                <Lock className="w-3.5 h-3.5" />
                Sign Out Authority
              </button>
            </div>
          </div>
        </header>

        <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-8">
          <AuthorityDashboardView
            onSpeakText={handleSpeakText}
            externalModuleRequest={authorityModuleJump}
          />
        </main>

        <footer className="border-t border-slate-200 bg-white mt-12">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
            <span>SEVA AI · Role-Isolated Authority Operations Portal ({authoritySession.name})</span>
            <span>All citizen modules disabled during active Authority session.</span>
          </div>
        </footer>

        <SevaSaathiPanel
          isOpen={voiceOpen}
          onClose={() => setVoiceOpen(false)}
          language={language}
          onLanguageChange={setLanguage}
          myReports={[]}
          onPopulateReportDraft={handlePopulateReportDraft}
          onNavigate={handleNavigate}
          externalSpeakRequest={externalSpeakReq}
        />
      </div>
    );
  }

  // =========================================================================
  // CITIZEN DASHBOARD SHELL (NO AUTHORITY NAVIGATION WHEN CITIZEN SIGNED IN)
  // =========================================================================
  return (
    <div className="min-h-screen flex flex-col bg-white text-slate-900">
      <header className="sticky top-0 z-40 bg-white/95 backdrop-blur border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => handleNavigate('home')}
            className="font-display text-lg font-bold tracking-tight text-green-900 whitespace-nowrap shrink-0"
          >
            SEVA AI
          </button>

          <nav className="hidden xl:flex items-center gap-3.5 text-xs font-medium text-slate-600">
            {CITIZEN_NAV_ITEMS.map((item) => (
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

          <div className="flex items-center gap-2 shrink-0">
            {firebaseUser && (
              <button
                type="button"
                onClick={() => handleNavigate('profile')}
                aria-label="Citizen Notifications"
                className="relative p-2 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50"
                title="View notifications"
              >
                <Bell className="w-4 h-4 text-green-900" />
                {unreadNotifications > 0 && (
                  <span className="absolute -top-1 -right-1 min-w-[17px] h-[17px] px-1 rounded-full bg-red-600 text-white text-[10px] font-bold flex items-center justify-center">
                    {unreadNotifications}
                  </span>
                )}
              </button>
            )}

            {firebaseUser ? (
              <button
                type="button"
                onClick={() => handleNavigate('profile')}
                className="hidden sm:inline-flex items-center gap-1.5 px-3 py-2 border border-slate-200 text-slate-800 text-xs font-medium rounded-lg hover:bg-slate-50 whitespace-nowrap shrink-0 max-w-[135px]"
                title={firebaseUser.email || 'Signed in'}
              >
                <User className="w-3.5 h-3.5 text-green-900 shrink-0" />
                <span className="truncate">{profile?.displayName || firebaseUser.displayName || 'Citizen'}</span>
              </button>
            ) : (
              <button
                type="button"
                disabled={signingIn}
                onClick={() => signInWithGoogle()}
                className="inline-flex items-center gap-1.5 px-3 py-2 border border-slate-200 text-slate-800 text-xs font-semibold rounded-lg hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                <LogIn className="w-3.5 h-3.5 text-green-900" />
                {signingIn ? 'Signing in...' : 'Sign In'}
              </button>
            )}

            <button
              type="button"
              onClick={() => setVoiceOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 bg-green-900 text-white text-xs font-semibold rounded-lg hover:bg-green-800 transition-colors whitespace-nowrap shrink-0"
            >
              <Mic className="w-3.5 h-3.5" />
              SEVA SAATHI
            </button>

            <button
              type="button"
              onClick={() => setMobileMenuOpen((v) => !v)}
              aria-label="Toggle navigation menu"
              className="xl:hidden p-2 rounded-lg border border-slate-200 text-slate-700"
            >
              {mobileMenuOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {/* Mobile / Compact Drawer */}
        {mobileMenuOpen && (
          <div className="xl:hidden border-t border-slate-200 bg-white px-4 py-3 grid grid-cols-2 sm:grid-cols-3 gap-2">
            {CITIZEN_NAV_ITEMS.map((item) => (
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
            {!isLoggedCitizen && (
              <button
                type="button"
                onClick={() => handleNavigate('authority')}
                className="col-span-2 sm:col-span-3 text-left px-3 py-2 rounded-lg text-xs font-medium bg-slate-900 text-white"
              >
                Authority Portal Login
              </button>
            )}
          </div>
        )}
      </header>

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-8">
        {roleGuardBanner && (
          <div
            role="alert"
            className="mb-6 border border-red-300 bg-red-50 rounded-xl p-4 flex items-start justify-between gap-3 text-xs text-red-900"
          >
            <div className="flex items-start gap-2">
              <Lock className="w-4 h-4 text-red-700 shrink-0 mt-0.5" />
              <span>{roleGuardBanner}</span>
            </div>
            <button
              type="button"
              onClick={() => setRoleGuardBanner(null)}
              className="p-1 hover:bg-red-100 rounded"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {authError && (
          <div
            role="alert"
            className="mb-6 border border-red-300 bg-red-50 rounded-xl p-4 flex flex-wrap items-start justify-between gap-3"
          >
            <div className="flex items-start gap-2.5 text-sm text-red-900">
              <AlertCircle className="w-5 h-5 text-red-700 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <div className="font-semibold">Sign-In Notice</div>
                <p className="text-xs leading-relaxed">{authError}</p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {!firebaseUser && (
                <button
                  type="button"
                  disabled={signingIn}
                  onClick={() => signInWithGoogle()}
                  className="px-3 py-1.5 bg-red-700 text-white text-xs font-medium rounded-lg hover:bg-red-800 disabled:opacity-50"
                >
                  {signingIn ? 'Signing in...' : 'Retry Google Sign-In'}
                </button>
              )}
              <button
                type="button"
                onClick={clearAuthError}
                aria-label="Dismiss sign-in notice"
                className="p-1.5 text-red-800 hover:bg-red-100 rounded-md"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {firestoreStatus === 'offline' && (
          <div className="mb-6 border border-amber-300 bg-amber-50 rounded-xl p-3.5 text-xs text-amber-950">
            Database connection warning: Firestore appears offline or unreachable.
          </div>
        )}

        {reportsError && (
          <div className="mb-6 border border-amber-300 bg-amber-50 rounded-xl p-3.5 text-xs text-amber-950">
            {reportsError}
          </div>
        )}

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
            language={language}
            onOpenVoiceAssistant={() => setVoiceOpen(true)}
            onSubmittedSuccess={() => {
              fetchCitizenServerReports();
              handleNavigate('reports');
            }}
          />
        )}
        {activeTab === 'shield' && <SevaShieldView onSpeakText={handleSpeakText} />}
        {activeTab === 'medical' && <MedicalAssistanceView onSpeakText={handleSpeakText} />}
        {activeTab === 'accident' && <RoadAccidentView onSpeakText={handleSpeakText} />}
        {activeTab === 'complaints' && <ComplaintBoxView myReports={myReports} />}
        {activeTab === 'heatmap' && <SafetyHeatmapView />}
        {activeTab === 'rewards' && <RewardsLeaderboardView />}
        {activeTab === 'reports' && (
          <MyReportsView
            reports={myReports}
            language={language}
            onGoToReport={() => handleNavigate('report')}
            onRefreshReports={fetchCitizenServerReports}
          />
        )}
        {activeTab === 'profile' && <ProfilePrivacyView />}
        {activeTab === 'authority' && !isLoggedCitizen && (
          <AuthorityDashboardView onSpeakText={handleSpeakText} />
        )}
      </main>

      <footer className="border-t border-slate-200 bg-slate-50 mt-12">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 flex flex-wrap items-center justify-between gap-4 text-xs text-slate-600">
          <div>
            <strong className="text-slate-900">SEVA AI</strong> · Smart City Civic Assistance &amp; Public Safety Platform · Seva First Innovation Challenge 2026
          </div>
          <div className="flex flex-wrap items-center gap-5">
            <span>Emergency Helplines: 112 (Police) · 108 (Ambulance) · 1091 (Women)</span>
            {!isLoggedCitizen && (
              <button
                type="button"
                onClick={() => handleNavigate('authority')}
                className="font-semibold text-green-900 hover:underline"
              >
                Authority Portal
              </button>
            )}
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
