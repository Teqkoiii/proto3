import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createGymAppApi } from './gym-app-api.ts';
import { isDhbwEmail } from './gymAppService.ts';

test('isDhbwEmail accurately validates official DHBW email domains', () => {
  assert.equal(isDhbwEmail('student@bad-mergentheim.dhbw.de'), true);
  assert.equal(isDhbwEmail('max.mustermann@dhbw-stuttgart.de'), true);
  assert.equal(isDhbwEmail('dozent@lehre.dhbw-mannheim.de'), true);
  assert.equal(isDhbwEmail('student@dhbw-mannheim.de'), true);
  assert.equal(isDhbwEmail('info@dhbw.de'), true);
  assert.equal(isDhbwEmail('student@dhbw-mosbach.de'), true);
  assert.equal(isDhbwEmail('student@heilbronn.dhbw.de'), true);
  assert.equal(isDhbwEmail('student@dhbw-attacker.de'), false);
  assert.equal(isDhbwEmail('student@evil.dhbw-attacker.de'), false);
  assert.equal(isDhbwEmail('student@gmail.com'), false);
  assert.equal(isDhbwEmail('attacker@evil-dhbw.com'), false);
  assert.equal(isDhbwEmail('not-an-email'), false);
});

test('Firebase-authenticated community workflow: privacy, calendar and partner requests', async (t) => {
  const db = new DatabaseSync(':memory:');
  const sentNotifications: Array<{
    recipientUid: string;
    senderUid: string;
    type: 'partner_request' | 'partner_accepted';
    resourceId: string;
  }> = [];
  const createdConversations: Array<{
    id: string;
    participantIds: string[];
    participantNames: Record<string, string>;
  }> = [];
  const app = createGymAppApi(db, {
    maxCheckInHours: 8,
    secureCookies: false,
    firebaseTokenVerifier: async (token) => {
      const identity = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as {
        uid: string;
        email: string;
        emailVerified: boolean;
      };
      return identity;
    },
    partnerNotificationWriter: async (notification) => {
      sentNotifications.push(notification);
    },
    communityConversationWriter: async (conversation) => {
      createdConversations.push(conversation);
    },
  });

  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => server.close());

  const address = server.address() as import('node:net').AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  // Helper for requests
  async function api(path: string, options: { method?: string; body?: any; token?: string } = {}) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const data = response.status !== 204 ? await response.json() : null;
    return { status: response.status, data };
  }

  // 1. Legacy password registration is disabled after the Firebase cutover
  const disabledRegistration = await api('/api/gym/register', { method: 'POST', body: { email: 'student@external-univ.de' } });
  assert.equal(disabledRegistration.status, 410);

  // 2. Link Firebase identities for User A and B
  const tokenA = Buffer.from(JSON.stringify({
    uid: 'anna-firebase',
    email: 'anna.schmidt@bad-mergentheim.dhbw.de',
    emailVerified: true,
  })).toString('base64url');
  const regUserA = await api('/api/gym/auth/link', {
    method: 'POST',
    token: tokenA,
    body: {},
  });
  assert.equal(regUserA.status, 200);
  const cookieA = tokenA;
  await api('/api/gym/profile/community', {
    method: 'PUT',
    token: cookieA,
    body: {
      firstName: 'Anna',
      lastNameInitial: 'S',
      courseOfStudy: 'Wirtschaftsinformatik',
      trainingGoals: ['Hypertrophie (Muskelaufbau)', 'Kraftsport'],
      preferredTimes: ['Nachmittags (15:00 - 18:00)'],
    },
  });

  // 3. User A checks their community profile
  const profA = await api('/api/gym/profile/community', { token: cookieA });
  assert.equal(profA.status, 200);
  assert.equal(profA.data.profile.firstName, 'Anna');
  assert.equal(profA.data.profile.lastNameInitial, 'S');
  assert.equal(profA.data.profile.isPublicPresence, true);

  // 4. Register User B (DHBW Mosbach)
  const cookieB = Buffer.from(JSON.stringify({
    uid: 'ben-firebase',
    email: 'ben.mueller@dhbw-mosbach.de',
    emailVerified: true,
  })).toString('base64url');
  const regUserB = await api('/api/gym/auth/link', {
    method: 'POST',
    token: cookieB,
    body: {},
  });
  assert.equal(regUserB.status, 200);
  await api('/api/gym/profile/community', {
    method: 'PUT',
    token: cookieB,
    body: { firstName: 'Ben', lastNameInitial: 'M', courseOfStudy: 'Angewandte Informatik', trainingGoals: ['Kraftsport'] },
  });

  // 5. User A creates a planned attendance in Calendar
  const tomorrow = new Date(Date.now() + 86400_000);
  tomorrow.setHours(16, 0, 0, 0);
  const createPlanned = await api('/api/gym/bookings', {
    method: 'POST',
    token: cookieA,
    body: {
      startsAt: tomorrow.toISOString(),
      durationMinutes: 90,
      title: 'Oberkörper / Bankdrücken',
      entryType: 'planned',
    },
  });
  assert.equal(createPlanned.status, 201);
  assert.equal(createPlanned.data.booking.entryType, 'planned');

  // 6. User B views calendar events - sees Anna S.'s planned session
  const calEvents = await api('/api/gym/calendar/events', { token: cookieB });
  assert.equal(calEvents.status, 200);
  const foundAnnaEvent = calEvents.data.events.find((e: any) => e.title === 'Oberkörper / Bankdrücken');
  assert.ok(foundAnnaEvent, 'User B should see Anna planned training');
  assert.equal(foundAnnaEvent.entryType, 'planned');
  assert.equal(foundAnnaEvent.userName, 'Anna S.');
  assert.equal(foundAnnaEvent.isMine, false);

  // 7. Privacy check: Anna switches isPublicPresence to false
  await api('/api/gym/profile/community', {
    method: 'PUT',
    token: cookieA,
    body: { isPublicPresence: false },
  });

  // User B views calendar again - Anna's name is now masked for privacy
  const calEventsAfterPrivate = await api('/api/gym/calendar/events', { token: cookieB });
  const maskedEvent = calEventsAfterPrivate.data.events.find((e: any) => e.id === foundAnnaEvent.id);
  assert.ok(maskedEvent);
  assert.equal(maskedEvent.userName, 'Anonymer DHBW Student');

  // But Anna herself still sees her own name
  const annaOwnCalendar = await api('/api/gym/calendar/events', { token: cookieA });
  const ownEvent = annaOwnCalendar.data.events.find((e: any) => e.id === foundAnnaEvent.id);
  assert.ok(ownEvent);
  assert.equal(ownEvent.isMine, true);

  // Private community profiles are not discoverable or chat-addressable without an accepted request.
  const members = await api('/api/gym/community/members', { token: cookieB });
  assert.equal(members.status, 200);
  assert.equal(members.data.members.some((m: any) => m.firstName === 'Anna'), false);
  const annaProfile = await api('/api/gym/profile/community', { token: cookieA });
  const annaPrincipalId = annaProfile.data.profile.principalId;
  const privateChat = await api('/api/gym/community/conversations', {
    method: 'POST',
    token: cookieB,
    body: { partnerPrincipalId: annaPrincipalId },
  });
  assert.equal(privateChat.status, 404);
  const privateRequest = await api('/api/gym/community/partner-requests', {
    method: 'POST',
    token: cookieB,
    body: { receiverId: annaPrincipalId },
  });
  assert.equal(privateRequest.status, 404);

  await api('/api/gym/profile/community', {
    method: 'PUT',
    token: cookieA,
    body: { isPublicPresence: true },
  });
  const publicMembers = await api('/api/gym/community/members', { token: cookieB });
  const annaMember = publicMembers.data.members.find((m: any) => m.firstName === 'Anna');
  assert.ok(annaMember);

  // 8. User B sends User A a partner request.
  const partnerReq = await api('/api/gym/community/partner-requests', {
    method: 'POST',
    token: cookieB,
    body: {
      receiverId: annaMember.id,
      senderId: 'attacker-controlled-uid',
      proposedDate: tomorrow.toISOString(),
      note: 'Hi Anna, trainieren wir morgen zusammen Bankdrücken?',
    },
  });
  assert.equal(partnerReq.status, 201);
  assert.equal(partnerReq.data.notificationStatus, 'sent');
  assert.equal(sentNotifications.length, 1);
  assert.equal(sentNotifications[0]?.recipientUid, 'anna-firebase');
  assert.equal(sentNotifications[0]?.senderUid, 'ben-firebase');
  assert.equal(sentNotifications[0]?.type, 'partner_request');
  assert.equal(sentNotifications[0]?.resourceId, partnerReq.data.id);

  // 9. User A receives and accepts the partner request
  const annaRequests = await api('/api/gym/community/partner-requests', { token: cookieA });
  assert.equal(annaRequests.status, 200);
  const incoming = annaRequests.data.requests.find((r: any) => r.id === partnerReq.data.id);
  assert.ok(incoming);
  assert.equal(incoming.isIncoming, true);
  assert.equal(incoming.status, 'pending');

  const acceptReq = await api(`/api/gym/community/partner-requests/${incoming.id}`, {
    method: 'PUT',
    token: cookieA,
    body: { status: 'accepted', senderId: 'attacker-controlled-uid' },
  });
  assert.equal(acceptReq.status, 200);
  assert.equal(acceptReq.data.status, 'accepted');
  assert.equal(acceptReq.data.notificationStatus, 'sent');
  assert.equal(sentNotifications.length, 2);
  assert.equal(sentNotifications[1]?.recipientUid, 'ben-firebase');
  assert.equal(sentNotifications[1]?.senderUid, 'anna-firebase');
  assert.equal(sentNotifications[1]?.type, 'partner_accepted');
  assert.equal(sentNotifications[1]?.resourceId, partnerReq.data.id);

  // An accepted partner can still open a chat after making their profile private.
  await api('/api/gym/profile/community', {
    method: 'PUT',
    token: cookieA,
    body: { isPublicPresence: false },
  });
  const conversation = await api('/api/gym/community/conversations', {
    method: 'POST',
    token: cookieB,
    body: { partnerPrincipalId: annaMember.id, otherParticipantUid: 'spoofed-uid' },
  });
  assert.equal(conversation.status, 200);
  assert.equal(conversation.data.otherParticipantUid, 'anna-firebase');
  assert.deepEqual(createdConversations[0]?.participantIds, ['anna-firebase', 'ben-firebase']);
  assert.deepEqual(createdConversations[0]?.participantNames, {
    'anna-firebase': 'Anna S.',
    'ben-firebase': 'Ben M.',
  });

  // 10. Check-in and Check-out
  const checkInRes = await api('/api/gym/check-in', { method: 'POST', token: cookieA });
  assert.equal(checkInRes.status, 200);
  assert.ok(checkInRes.data.checkedInAt);

  // Live occupancy includes active check-in
  const occupancy = await api('/api/gym/occupancy', { token: cookieB });
  assert.ok(occupancy.data.count >= 1);

  // Check-out
  const checkOutRes = await api('/api/gym/check-out', { method: 'POST', token: cookieA });
  assert.equal(checkOutRes.status, 200);
});
