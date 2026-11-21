import React, { useEffect, useMemo, useState } from 'react';
import { Award, CheckCircle2, Medal, ShieldCheck, Trophy } from 'lucide-react';
import {
  collection,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
} from 'firebase/firestore';
import { useAuth } from '../contexts/AuthContext';
import { OperationType, db, handleFirestoreError } from '../lib/firebase';
import { AwardCandidate, LeaderboardEntry } from '../types/seva';

const REWARD_TIERS = [
  { name: 'Bronze Citizen', threshold: '1+ verified report' },
  { name: 'Silver Citizen', threshold: '10+ verified reports' },
  { name: 'Gold Citizen', threshold: '25+ verified reports' },
  { name: 'Platinum Guardian', threshold: '50+ verified reports' },
  { name: 'City Champion', threshold: 'Top verified contributor' },
];

const SPECIAL_BADGES = [
  'First Report',
  'Clean City Champion',
  'Road Safety Guardian',
  'Public Health Protector',
  'Animal Welfare Champion',
  'Safety Hero',
  'Consistent Citizen',
  'Emergency Response Contributor',
];

export const RewardsLeaderboardView: React.FC = () => {
  const { firebaseUser, profile, signInWithGoogle } = useAuth();

  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [candidates, setCandidates] = useState<AwardCandidate[]>([]);
  const [limitCount, setLimitCount] = useState<10 | 20>(10);
  const [cityFilter, setCityFilter] = useState<string>('All');
  const [wardFilter, setWardFilter] = useState<string>('All');
  const [nominationMsg, setNominationMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!firebaseUser) {
      setEntries([]);
      setCandidates([]);
      return;
    }

    const unsubLb = onSnapshot(
      collection(db, 'leaderboard'),
      (snap) => {
        const list = snap.docs.map((d) => d.data() as LeaderboardEntry);
        list.sort((a, b) => b.points - a.points || b.verifiedReportsCount - a.verifiedReportsCount);
        setEntries(list);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'leaderboard')
    );

    const unsubAwards = onSnapshot(
      query(collection(db, 'awardCandidates')),
      (snap) => {
        setCandidates(snap.docs.map((d) => ({ id: d.id, ...d.data() } as AwardCandidate)));
      },
      () => {
        // Non-admin users only see shortlisted/honoree or own nominations
      }
    );

    return () => {
      unsubLb();
      unsubAwards();
    };
  }, [firebaseUser]);

  const cities = useMemo(
    () => ['All', ...Array.from(new Set(entries.map((e) => e.city).filter(Boolean)))],
    [entries]
  );
  const wards = useMemo(
    () => ['All', ...Array.from(new Set(entries.map((e) => e.ward).filter(Boolean)))],
    [entries]
  );

  const rankedEntries = useMemo(() => {
    return entries
      .filter((e) => (cityFilter === 'All' || e.city === cityFilter) && (wardFilter === 'All' || e.ward === wardFilter))
      .slice(0, limitCount);
  }, [entries, cityFilter, wardFilter, limitCount]);

  const submitAwardNomination = async () => {
    setNominationMsg(null);
    if (!firebaseUser || !profile) {
      setNominationMsg('Please sign in first.');
      return;
    }
    const id = `cand_${firebaseUser.uid}`;
    try {
      await setDoc(doc(db, 'awardCandidates', id), {
        uid: firebaseUser.uid,
        displayName: profile.displayName.slice(0, 80),
        city: (profile.city || 'New Delhi').slice(0, 80),
        ward: (profile.ward || 'Central Ward').slice(0, 80),
        points: profile.points || 0,
        verifiedReportsCount: profile.verifiedReportsCount || 0,
        status: 'nominated',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setNominationMsg('Verified contribution portfolio submitted for State Civic Excellence Honours screening.');
    } catch (err: any) {
      if (err?.message?.includes('Missing or insufficient permissions')) {
        handleFirestoreError(err, OperationType.CREATE, `awardCandidates/${id}`);
      }
      setNominationMsg(err?.message || 'Unable to submit nomination.');
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900">
          Seva Samman — Civic Champion Recognition
        </h1>
        <p className="text-sm text-slate-600 mt-1">
          Points and civic tiers are awarded strictly upon authority verification and resolution — never for unverified or duplicate reports.
        </p>
      </div>

      {!firebaseUser ? (
        <div className="border border-slate-200 rounded-xl bg-slate-50 p-6 flex flex-wrap items-center justify-between gap-4">
          <p className="text-sm text-slate-700">
            Sign in with Google to view live citizen rankings, your verified civic portfolio, and Seva Samman milestones.
          </p>
          <button
            type="button"
            onClick={() => signInWithGoogle()}
            className="px-4 py-2 bg-green-900 text-white text-xs font-medium rounded-lg"
          >
            Sign In with Google
          </button>
        </div>
      ) : (
        <>
          {/* Citizen Portfolio Summary */}
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
            <div className="border border-slate-200 rounded-xl bg-white p-4">
              <div className="text-xs text-slate-500">Current Tier</div>
              <div className="font-display text-lg font-bold text-green-900 mt-1">
                {profile?.badgeTier || 'New Citizen'}
              </div>
            </div>
            <div className="border border-slate-200 rounded-xl bg-white p-4">
              <div className="text-xs text-slate-500">Verified Points</div>
              <div className="font-mono text-2xl font-bold text-slate-900 mt-1 tabular-nums">
                {profile?.points ?? 0}
              </div>
            </div>
            <div className="border border-slate-200 rounded-xl bg-white p-4">
              <div className="text-xs text-slate-500">Verified Reports</div>
              <div className="font-mono text-2xl font-bold text-slate-900 mt-1 tabular-nums">
                {profile?.verifiedReportsCount ?? 0}
              </div>
            </div>
            <div className="border border-slate-200 rounded-xl bg-white p-4">
              <div className="text-xs text-slate-500">Resolved Reports</div>
              <div className="font-mono text-2xl font-bold text-emerald-700 mt-1 tabular-nums">
                {profile?.resolvedReportsCount ?? 0}
              </div>
            </div>
          </div>

          {/* Tiers & Badges */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-5 border border-slate-200 rounded-xl bg-white p-5 space-y-3">
              <h3 className="font-display text-base font-semibold text-slate-900">
                Recognition Levels
              </h3>
              <div className="divide-y divide-slate-200">
                {REWARD_TIERS.map((tier) => (
                  <div key={tier.name} className="py-2.5 flex items-center justify-between text-sm">
                    <span className="font-medium text-slate-900">{tier.name}</span>
                    <span className="text-xs text-slate-500">{tier.threshold}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="lg:col-span-7 border border-slate-200 rounded-xl bg-white p-5 space-y-3">
              <h3 className="font-display text-base font-semibold text-slate-900">
                Civic Service Badges
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {SPECIAL_BADGES.map((badge) => {
                  const unlocked = profile?.badges?.includes(badge);
                  return (
                    <div
                      key={badge}
                      className={`border rounded-lg px-3.5 py-2.5 flex items-center justify-between text-xs ${
                        unlocked
                          ? 'border-green-900 bg-emerald-50/50 text-green-950 font-semibold'
                          : 'border-slate-200 bg-slate-50 text-slate-600'
                      }`}
                    >
                      <span className="inline-flex items-center gap-2">
                        <Medal className={`w-4 h-4 ${unlocked ? 'text-green-900' : 'text-slate-400'}`} />
                        {badge}
                      </span>
                      <span>{unlocked ? 'Earned' : 'Locked'}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Dynamic Leaderboard */}
          <div className="border border-slate-200 rounded-xl bg-white p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Trophy className="w-5 h-5 text-amber-600" />
                <h3 className="font-display text-lg font-semibold text-slate-900">
                  Dynamic Civic Leaderboard
                </h3>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
                  {([10, 20] as const).map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => setLimitCount(n)}
                      className={`px-2.5 py-1 text-xs font-medium rounded-md ${
                        limitCount === n ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                      }`}
                    >
                      Top {n}
                    </button>
                  ))}
                </div>

                <select
                  value={cityFilter}
                  onChange={(e) => setCityFilter(e.target.value)}
                  className="text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 bg-white"
                >
                  {cities.map((c) => (
                    <option key={c} value={c}>
                      City: {c}
                    </option>
                  ))}
                </select>

                <select
                  value={wardFilter}
                  onChange={(e) => setWardFilter(e.target.value)}
                  className="text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 bg-white"
                >
                  {wards.map((w) => (
                    <option key={w} value={w}>
                      Ward: {w}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {rankedEntries.length === 0 ? (
              <p className="text-sm text-slate-500 py-8 text-center">
                No leaderboard records match this filter yet.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-xs text-slate-500">
                      <th className="py-2.5 pr-4">Rank</th>
                      <th className="py-2.5 pr-4">Display Name</th>
                      <th className="py-2.5 pr-4">City / Ward</th>
                      <th className="py-2.5 pr-4">Tier</th>
                      <th className="py-2.5 pr-4 text-right">Verified</th>
                      <th className="py-2.5 pr-4 text-right">Resolved</th>
                      <th className="py-2.5 text-right">Points</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {rankedEntries.map((row, idx) => (
                      <tr key={row.uid} className={row.uid === firebaseUser.uid ? 'bg-emerald-50/40' : ''}>
                        <td className="py-2.5 pr-4 font-mono text-xs font-semibold tabular-nums">
                          #{idx + 1}
                        </td>
                        <td className="py-2.5 pr-4 font-medium text-slate-900">{row.displayName}</td>
                        <td className="py-2.5 pr-4 text-xs text-slate-600">
                          {row.city} · {row.ward}
                        </td>
                        <td className="py-2.5 pr-4 text-xs text-green-900 font-medium">{row.badgeTier}</td>
                        <td className="py-2.5 pr-4 text-right font-mono tabular-nums">
                          {row.verifiedReportsCount}
                        </td>
                        <td className="py-2.5 pr-4 text-right font-mono tabular-nums">
                          {row.resolvedReportsCount}
                        </td>
                        <td className="py-2.5 text-right font-mono font-semibold text-slate-900 tabular-nums">
                          {row.points}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Proposed State Civic Excellence Honours */}
          <div className="border border-slate-200 rounded-xl bg-slate-50 p-6 grid grid-cols-1 lg:grid-cols-12 gap-6 items-center">
            <div className="lg:col-span-4">
              <img
                src="/src/assets/images/seva_samman_emblem_1795250515477.jpg"
                alt="Seva Samman State Civic Excellence Medallion"
                referrerPolicy="no-referrer"
                className="w-full h-56 object-cover rounded-xl border border-slate-200"
              />
            </div>
            <div className="lg:col-span-8 space-y-3">
              <div className="inline-flex items-center gap-2 text-xs font-semibold text-amber-800">
                <Award className="w-4 h-4" />
                Proposed Recognition Framework · Ready for Municipal &amp; State Partnership
              </div>
              <h2 className="font-display text-xl font-bold text-slate-900">
                State Civic Excellence Honours
              </h2>
              <p className="text-sm text-slate-700 leading-relaxed">
                Designed to showcase Top 10 and Top 20 verified state civic contributors for potential official felicitation, digital certificates, and annual civic champion recognition once formal municipal or state partnerships are executed.
              </p>
              <p className="text-xs text-slate-500">
                Notice: This is a proposed official recognition programme architecture. No Chief Minister, Lieutenant Governor, or government department endorsement is claimed without formal written authorization.
              </p>

              <div className="pt-2 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={submitAwardNomination}
                  className="inline-flex items-center gap-2 px-4 py-2.5 bg-green-900 text-white text-xs font-medium rounded-lg hover:bg-green-800"
                >
                  <ShieldCheck className="w-4 h-4" />
                  Submit Verified Portfolio for Annual Shortlist
                </button>
                <span className="text-xs text-slate-600">
                  {candidates.length} shortlisted / nominated portfolio(s) in registry
                </span>
              </div>

              {nominationMsg && (
                <div className="flex items-center gap-2 text-xs text-green-900 bg-white border border-slate-200 rounded-lg p-2.5">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  <span>{nominationMsg}</span>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
};
