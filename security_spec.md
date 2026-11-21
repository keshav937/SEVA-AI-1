# SEVA AI — Security Specification & Threat Invariants

## 1. Data Invariants
1. A user profile (`users/{uid}`) cannot self-assign `role = 'authority'` or `role = 'admin'`, nor initialize non-zero points.
2. All user-owned documents (`emergencyContacts`, `sosEvents`, `medicalRequests`, `trackingSessions`, `notifications`, `consentRecords`) enforce strict `uid == request.auth.uid` ownership and `email_verified == true`.
3. `reports/{reportId}` containing sensitive safety categories (`isSensitive == true`) can only be read or listed by the report owner (`reporterUid == request.auth.uid`) or verified admin; non-sensitive civic reports expose zero PII (no phone numbers or emails).
4. Resolved or rejected reports (`status in ['Resolved', 'Rejected']`) are terminal-locked against citizen tampering; only verified admin or authorized feedback updates (rating/comment only) are allowed.
5. `createdAt` and `updatedAt` timestamps must equal `request.time` (server timestamp), never client-spoofed strings.
6. All document IDs are strictly validated via `isValidId()` (`^[a-zA-Z0-9_-]+$`, `<= 128` chars), and every string/list field has explicit `.size()` bounds.

## 2. Adversarial "Dirty Dozen" Payloads (Expected: PERMISSION_DENIED)
1. **Unauthenticated read on `users/user1`**: `auth = null` -> DENIED.
2. **Self-promotion to Admin on `users/attacker`**: `{ role: 'admin', points: 9999 }` -> DENIED.
3. **Spoofed points inflation on `users/attacker` update**: `affectedKeys: ['points']` -> DENIED (citizen cannot directly mutate points without report verification).
4. **Shadow field injection on `reports/rep1`**: extra `{ isVerifiedByGov: true }` -> DENIED (`hasOnly` blocks unknown fields).
5. **Cross-user PII read on `emergencyContacts/c1`**: `auth.uid != resource.data.uid` -> DENIED.
6. **Oversized ID poisoning**: `reportId = 'a'.repeat(300)` -> DENIED (`isValidId` rejects `> 128`).
7. **Unverified email spoofing**: `email_verified: false` matching admin email -> DENIED.
8. **Sensitive report scraping (`list` on `reports` where `isSensitive == true`)** by non-owner citizen -> DENIED.
9. **Client-forged `createdAt` timestamp** (`createdAt: new Date(0)`) -> DENIED (`request.time` enforcement).
10. **Changing `reporterUid` on report update** -> DENIED (immortal owner field).
11. **Mutating terminal `Resolved` report description** by citizen -> DENIED.
12. **Blanket `list` query on `users` or `emergencyContacts`** by non-admin -> DENIED.
