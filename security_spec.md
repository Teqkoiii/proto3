# Security Specification for DHBW Gym Community Firestore

## 1. Data Invariants
1. Community profiles can only be created or modified by their owner (`userId == request.auth.uid`); public reads require a valid, allowlisted document.
2. Partner-request writes are server-only. Direct document reads are limited to participants and valid schemas; raw Firestore list queries are denied because rules cannot redact unexpected fields.
3. Partner-request status changes are performed by the authenticated API, which checks the sender/receiver relationship and allowed status transition.
4. Conversations are created by the authenticated API and contain exactly two distinct participant UIDs. Direct document reads require membership; client updates may change only last-message metadata.
5. Message reads and writes require verified conversation membership, a valid parent conversation, matching path/document IDs, and a sender UID matching the caller for creates. Raw message list queries are denied.
6. Notification reads are owner-scoped. Raw notification list queries are denied; client-created notification types are restricted by rules, while partner notifications are server-only.
7. Every document schema uses an explicit field allowlist, bounded strings/lists, and validated IDs to prevent unexpected fields from being exposed.
8. Document IDs must conform to `isValidId(id)` (`^[a-zA-Z0-9_-]+$`, maximum 128 characters).
9. Timestamp strings must match the bounded ISO-8601 pattern enforced by the rules; they are not required to equal `request.time`.
10. The global catch-all denies access unless a more specific match explicitly grants it.

## 2. Supported Access Paths
- Community profile discovery and partner-request listing use the authenticated API, which returns scoped data transfer objects.
- Conversations, messages, and notifications are listed through the authenticated API, which validates every document and drops malformed or unexpected-field records.
- Direct Firestore reads are intentionally narrower than API list operations. Do not re-enable raw list access unless the data model and rules can guarantee that unexpected private fields cannot be returned.
- Partner requests are persisted in the authenticated SQLite API; Firestore partner-request documents, where present, are read-only to participants and are not client-writable.

## 2. The "Dirty Dozen" Attack Payloads
1. **Ghost Field Injection**: Adding an unpermitted `isAdmin: true` to a CommunityProfile update.
2. **Sender Spoofing in Request**: Attempting a direct client create with `senderId: "victim-uid"`; partner-request writes are denied to clients.
3. **Unauthorized Message Reading**: Reading a message outside the caller's conversation; list queries are denied and individual reads require verified membership.
4. **Message Impersonation**: Creating a message with `senderId: "partner-uid"` in an active conversation.
5. **Denial of Wallet Payload**: Submitting a 2MB string in `bio` or `text`.
6. **Path Traversal / Junk ID Attack**: Using `../` or `\x00` in `{conversationId}` path variable.
7. **Cross-User Notification Snooping**: Reading another user's notification document or attempting a raw collection list; both are denied.
8. **Forged Request Status Escalation**: A third party updating `/partner_requests/{id}` to `accepted`.
9. **Chat Room Takeover**: Updating `participantIds` on an existing conversation to eject the original member.
10. **Orphan Message Insertion**: Creating a message pointing to a non-existent conversation document.
11. **Malformed Timestamp Injection**: Supplying a timestamp that does not match the bounded ISO-8601 format.
12. **Double Status Re-open**: Transitioning a terminal `cancelled` partner request back to `pending`.
