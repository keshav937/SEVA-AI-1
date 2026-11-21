import React, { createContext, useContext, useEffect, useState } from 'react';
import {
  User,
  onAuthStateChanged,
  signInWithPopup,
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
  firestoreStatus: 'checking' | 'connected' | 'offline';
  authoritySession: AuthoritySessionInfo | null;
  signInWithGoogle: () => Promise<void>;
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
  }) => Promise<AuthoritySessionInfo>;
  clearAuthoritySession: () => void;
  authError: string | null;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [firestoreStatus, setFirestoreStatus] = useState<'checking' | 'connected' | 'offline'>('checking');
  // Authority token kept strictly in React memory (never localStorage)
  const [authoritySession, setAuthoritySession] = useState<AuthoritySessionInfo | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    testFirestoreConnection().then((res) => {
      setFirestoreStatus(res.ok ? 'connected' : 'offline');
    });
  }, []);

  useEffect(() => {
    let unsubProfile: (() => void) | null = null;

    const unsubAuth = onAuthStateChanged(auth, async (user) => {
      setFirebaseUser(user);
      setAuthError(null);
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

      const userRef = doc(db, 'users', user.uid);
      const leaderboardRef = doc(db, 'leaderboard', user.uid);

      try {
        const snap = await getDoc(userRef);
        if (!snap.exists()) {
          const cleanName = (user.displayName || user.email?.split('@')[0] || 'Citizen').slice(0, 80);
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
        handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}`);
      }

      unsubProfile = onSnapshot(
        userRef,
        (docSnap) => {
          if (docSnap.exists()) {
            setProfile(docSnap.data() as UserProfile);
          }
          setAuthReady(true);
        },
        (err) => {
          handleFirestoreError(err, OperationType.GET, `users/${user.uid}`);
        }
      );
    });

    return () => {
      unsubAuth();
      if (unsubProfile) unsubProfile();
    };
  }, []);

  const signInWithGoogle = async () => {
    setAuthError(null);
    try {
      await signInWithPopup(auth, googleAuthProvider);
    } catch (err: any) {
      setAuthError(err?.message || 'Google sign-in was cancelled or blocked.');
      throw err;
    }
  };

  const logout = async () => {
    setAuthoritySession(null);
    await signOut(auth);
  };

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
  }) => {
    if (!firebaseUser) throw new Error('Sign in with your official Google account first.');
    const res = await fetch('/api/auth/verify-authority', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uid: firebaseUser.uid,
        email: firebaseUser.email,
        name: profile?.fullName || firebaseUser.displayName || 'Officer',
        department: params.department,
        jurisdiction: params.jurisdiction,
        passcode: params.passcode,
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
        firestoreStatus,
        authoritySession,
        signInWithGoogle,
        logout,
        updateCitizenProfile,
        verifyAuthorityAccess,
        clearAuthoritySession,
        authError,
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
