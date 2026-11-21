/**
 * SEVA AI Firestore Security Rules Adversarial Verification Matrix ("Dirty Dozen")
 * Documents the 12 mandatory test payloads verified against firestore.rules.
 */
export const dirtyDozenRuleAssertions = [
  { id: 1, name: 'Unauthenticated read on users/user1', expected: 'PERMISSION_DENIED', path: 'users/user1', op: 'get', auth: null },
  { id: 2, name: 'Self-promotion to admin on user create', expected: 'PERMISSION_DENIED', path: 'users/attacker1', op: 'create', payload: { role: 'admin', points: 9999 } },
  { id: 3, name: 'Citizen points inflation on profile update', expected: 'PERMISSION_DENIED', path: 'users/citizen1', op: 'update', payload: { points: 5000 } },
  { id: 4, name: 'Shadow field injection on civic report', expected: 'PERMISSION_DENIED', path: 'reports/rep1', op: 'create', payload: { isVerifiedByGov: true } },
  { id: 5, name: 'Cross-user PII read on emergencyContacts', expected: 'PERMISSION_DENIED', path: 'emergencyContacts/c1', op: 'get', uid: 'otherUser' },
  { id: 6, name: 'Oversized document ID poisoning (>128 chars)', expected: 'PERMISSION_DENIED', path: `reports/${'a'.repeat(160)}`, op: 'create' },
  { id: 7, name: 'Unverified email spoofing admin email', expected: 'PERMISSION_DENIED', path: 'users/citizen1', op: 'list', auth: { email: 'guptakeshav2178@gmail.com', email_verified: false } },
  { id: 8, name: 'Sensitive women/child safety report scraping', expected: 'PERMISSION_DENIED', path: 'reports/sensitive1', op: 'get', resource: { isSensitive: true, reporterUid: 'victim1' }, uid: 'otherUser' },
  { id: 9, name: 'Client-forged createdAt timestamp', expected: 'PERMISSION_DENIED', path: 'reports/rep2', op: 'create', payload: { createdAt: '2020-01-01T00:00:00Z' } },
  { id: 10, name: 'Immortal reporterUid mutation on update', expected: 'PERMISSION_DENIED', path: 'reports/rep1', op: 'update', payload: { reporterUid: 'otherUser' } },
  { id: 11, name: 'Mutating terminal Resolved report description', expected: 'PERMISSION_DENIED', path: 'reports/repResolved', op: 'update', resource: { status: 'Resolved' }, payload: { description: 'tampered' } },
  { id: 12, name: 'Blanket list query on users or emergencyContacts', expected: 'PERMISSION_DENIED', path: 'users', op: 'list', uid: 'citizen1' },
] as const;
