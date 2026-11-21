import React, { createContext, useContext, useEffect, useState } from 'react';
import {
  User,
  browserPopupRedirectResolver,
  getRedirectResult,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  signOut,
} from 'firebase/auth';
import {
  doc,
  getDoc,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import {
  OperationType,
  auth,
  buildFirestoreErrorInfo,
  db,
  googleAuthProvider,
  handleFirestoreError,
  testFirestoreConnection,
} from '../lib/firebase';
import { AuthoritySessionInfo, UserProfile } from '../types/seva';

interface AuthContextValue {
  firebaseUser: User | null;
  profile: UserProfile | null;
  authReady: boolean;
  signingIn: boolean;
  firestoreStatus: 'checking' | 'connected' | 'offline';
  authoritySession: AuthoritySessionInfo | null;
  signInWithGoogle: () => Promise<boolean>;
  logout: () => Promise<void>;
  updateCitizenProfile: (updates: {
    fullName: string;
    displayName: string;
    phone?: string;
    city?: string;
    ward?: string;
    dpdpConsent: boolean;
  }) => Promise<void>;
  verifyAuthorityAccess: (params: {
    department: string;
    jurisdiction: string;
    passcode: string;
    officerEmail?: string;
    officerName?: string;
  }) => Promise<AuthoritySessionInfo>;
  clearAuthoritySession: () => void;
  authError: string | null;
  clearAuthError: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function mapFirebaseAuthError(err: any): string {
  const code = String(err?.code || '');
  const host = typeof window !== 'undefined' ? window.location.hostname : 'this domain';
  const inIframe = typeof window !== 'undefined' && window.self !== window.top;

  switch (code) {
    case 'auth/unauthorized-domain':
      return `Google Sign-In is blocked because "${host}" is not listed under Firebase Console → Authentication → Settings → Authorized domains. Add "${host}" there and retry.`;
    case 'auth/popup-blocked':
      return inIframe
        ? 'Your browser blocked the Google Sign-In popup inside this preview frame. Allow pop-ups for this site or open SEVA AI in a full browser tab.'
        : 'Pop-up window was blocked by your browser. Please allow pop-ups for this site and click Sign In again.';
    case 'auth/popup-closed-by-user':
      return 'Google Sign-In popup was closed before finishing. Please click Sign In again and select your Google account.';
    case 'auth/cancelled-popup-request':
      return 'Sign-in request was interrupted by another click. Please click Sign In once and complete the Google prompt.';
    case 'auth/operation-not-supported-in-this-environment':
      return 'Browser storage or popup authentication is restricted in this embedded frame. Open SEVA AI in a full browser tab to sign in with Google.';
    case 'auth/network-request-failed':
      return 'Network error contacting Google Authentication. Check your connection and try again.';
    case 'auth/user-disabled':
      return 'This Google account has been disabled in Firebase Authentication.';
    default:
      return err?.message || 'Google Sign-In failed. Please try again.';
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [firestoreStatus, setFirestoreStatus] = useState<'checking' | 'connected' | 'offline'>('checking');
  // Authority token kept strictly in React memory (never localStorage)
  const [authoritySession, setAuthoritySession] = useState<AuthoritySessionInfo | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    testFirestoreConnection().then((res) => {
      setFirestoreStatus(res.ok ? 'connected' : 'offline');
    });

    getRedirectResult(auth).catch((err) => {
      if (err?.code) {
        setAuthError(mapFirebaseAuthError(err));
      }
    });
  }, []);

  useEffect(() => {
    let unsubProfile: (() => void) | null = null;
    let active = true;

    const unsubAuth = onAuthStateChanged(auth, async (user) => {
      if (!active) return;
      setFirebaseUser(user);
      if (unsubProfile) {
        unsubProfile();
        unsubProfile = null;
      }

      if (!user) {
        setProfile(null);
        setAuthoritySession(null);
        setAuthReady(true);
        return;
      }

      setAuthError(null);
      const userRef = doc(db, 'users', user.uid);
      const leaderboardRef = doc(db, 'leaderboard', user.uid);
      const cleanName = (user.displayName?.trim() || user.email?.split('@')[0]?.trim() || 'Citizen').slice(0, 80);

      try {
        const snap = await getDoc(userRef);
        if (!snap.exists()) {
          const initialProfile = {
            uid: user.uid,
            email: (user.email || '').slice(0, 200),
            fullName: cleanName.slice(0, 120),
            displayName: cleanName.slice(0, 80),
            city: 'New Delhi',
            ward: 'Central Ward',
            role: 'citizen',
            points: 0,
            verifiedReportsCount: 0,
            resolvedReportsCount: 0,
            badgeTier: 'New Citizen',
            badges: [] as string[],
            dpdpConsent: true,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          };
          await setDoc(userRef, initialProfile);
        }

        const lbSnap = await getDoc(leaderboardRef);
        if (!lbSnap.exists()) {
          await setDoc(leaderboardRef, {
            uid: user.uid,
            displayName: cleanName.slice(0, 80),
            city: 'New Delhi',
            ward: 'Central Ward',
            points: 0,
            verifiedReportsCount: 0,
            resolvedReportsCount: 0,
            badgeTier: 'New Citizen',
            badges: [] as string[],
            updatedAt: serverTimestamp(),
          });
        }
      } catch (err) {
        const info = buildFirestoreErrorInfo(err, OperationType.WRITE, `users/${user.uid}`);
        if (active) {
          setAuthError(
            info.error.includes('Missing or insufficient permissions')
              ? 'Signed in with Google, but Firestore denied profile initialization. Ensure your Google email is verified and Firestore rules are deployed.'
              : `Signed in with Google, but profile sync failed: ${info.error}`
          );
          setAuthReady(true);
        }
      }

      if (!active) return;
      unsubProfile = onSnapshot(
        userRef,
        (docSnap) => {
          if (docSnap.exists()) {
            setProfile(docSnap.data() as UserProfile);
          }
          setAuthReady(true);
        },
        (err) => {
          const info = buildFirestoreErrorInfo(err, OperationType.GET, `users/${user.uid}`);
          setAuthError(`Unable to sync citizen profile from Firestore: ${info.error}`);
          setAuthReady(true);
        }
      );
    });

    return () => {
      active = false;
      unsubAuth();
      if (unsubProfile) unsubProfile();
    };
  }, []);

  const signInWithGoogle = async (): Promise<boolean> => {
    if (signingIn) return false;
    setAuthError(null);

    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setAuthError('You appear to be offline. Reconnect to the internet and try signing in again.');
      return false;
    }

    setSigningIn(true);
    try {
      await signInWithPopup(auth, googleAuthProvider, browserPopupRedirectResolver);
      return true;
    } catch (err: any) {
      const code = String(err?.code || '');
      const inIframe = typeof window !== 'undefined' && window.self !== window.top;
      if (
        (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment') &&
        !inIframe
      ) {
        try {
          await signInWithRedirect(auth, googleAuthProvider, browserPopupRedirectResolver);
          return true;
        } catch (redirErr: any) {
          setAuthError(mapFirebaseAuthError(redirErr));
          return false;
        }
      }
      setAuthError(mapFirebaseAuthError(err));
      return false;
    } finally {
      setSigningIn(false);
    }
  };

  const logout = async () => {
    setAuthoritySession(null);
    setAuthError(null);
    await signOut(auth);
  };

  const clearAuthError = () => setAuthError(null);

  const updateCitizenProfile = async (updates: {
    fullName: string;
    displayName: string;
    phone?: string;
    city?: string;
    ward?: string;
    dpdpConsent: boolean;
  }) => {
    if (!firebaseUser) throw new Error('Please sign in first.');
    const userRef = doc(db, 'users', firebaseUser.uid);
    const lbRef = doc(db, 'leaderboard', firebaseUser.uid);

    const payload: Record<string, any> = {
      fullName: updates.fullName.trim().slice(0, 120),
      displayName: updates.displayName.trim().slice(0, 80),
      city: (updates.city || 'New Delhi').trim().slice(0, 80),
      ward: (updates.ward || 'Central Ward').trim().slice(0, 80),
      dpdpConsent: updates.dpdpConsent,
      updatedAt: serverTimestamp(),
    };
    if (updates.phone !== undefined) {
      payload.phone = updates.phone.trim().slice(0, 20);
    }

    try {
      await updateDoc(userRef, payload);
      const lbSnap = await getDoc(lbRef);
      if (lbSnap.exists()) {
        await updateDoc(lbRef, {
          displayName: payload.displayName,
          city: payload.city,
          ward: payload.ward,
          updatedAt: serverTimestamp(),
        });
      } else {
        await setDoc(lbRef, {
          uid: firebaseUser.uid,
          displayName: payload.displayName,
          city: payload.city,
          ward: payload.ward,
          points: 0,
          verifiedReportsCount: 0,
          resolvedReportsCount: 0,
          badgeTier: 'New Citizen',
          badges: [],
          updatedAt: serverTimestamp(),
        });
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `users/${firebaseUser.uid}`);
    }
  };

  const verifyAuthorityAccess = async (params: {
    department: string;
    jurisdiction: string;
    passcode: string;
    officerEmail?: string;
    officerName?: string;
  }) => {
    const emailToUse = firebaseUser?.email || params.officerEmail?.trim();
    const nameToUse = profile?.fullName || firebaseUser?.displayName || params.officerName?.trim() || 'Authority Officer';
    if (!emailToUse) {
      throw new Error('Sign in with Google or provide your official officer email address.');
    }

    const res = await fetch('/api/auth/verify-authority', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uid: firebaseUser?.uid,
        email: emailToUse,
        name: nameToUse,
        department: params.department,
        jurisdiction: params.jurisdiction,
        passcode: params.passcode,
        googleSignedIn: Boolean(firebaseUser),
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Authority verification failed.');
    }

    const session: AuthoritySessionInfo = {
      token: data.token,
      role: data.role,
      department: data.department,
      jurisdiction: data.jurisdiction,
      expiresAt: data.expiresAt,
    };
    setAuthoritySession(session);
    return session;
  };

  const clearAuthoritySession = () => setAuthoritySession(null);

  return (
    <AuthContext.Provider
      value={{
        firebaseUser,
        profile,
        authReady,
        signingIn,
        firestoreStatus,
        authoritySession,
        signInWithGoogle,
        logout,
        updateCitizenProfile,
        verifyAuthorityAccess,
        clearAuthoritySession,
        authError,
        clearAuthError,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
