# Security Specification for DHBW Gym Community Firestore

## 1. Data Invariants
1. A community profile can only be created or modified by its owning user (`userId == request.auth.uid`).
2. Partner requests must have `senderId == request.auth.uid` on create.
3. Status transitions for partner requests can only be made by the receiver (for accepted/declined) or sender (for cancelled).
4. Conversations must include the creating user in `participantIds` with a maximum of 2 participants.
5. Messages in a conversation can only be read and created by members who are verified participants in that conversation document (`exists(...)` or in `participantIds`).
6. A message's `senderId` must strictly match `request.auth.uid`.
7. Personal notifications under `/users/{userId}/notifications/{notificationId}` can only be read by the owner `userId == request.auth.uid`.
8. All string fields have strict bounded size constraints (`.size() <= MAX`).
9. Document IDs must conform to `isValidId(id)` pattern with regex `^[a-zA-Z0-9_\-]+$`.
10. Timestamps (`createdAt`, `updatedAt`) must validate against `request.time`.

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
