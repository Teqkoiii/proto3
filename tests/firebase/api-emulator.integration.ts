import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { deleteApp, initializeApp } from 'firebase/app';
import {
  applyActionCode,
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  getAuth,
  sendEmailVerification,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { createGymAppApi } from '../../server/gym-app-api.ts';
import { getFirebaseAdminApp } from '../../server/firebaseAuth.ts';
import {
  readCommunityConversations,
  readCommunityMessages,
  readCommunityNotifications,
  writeCommunityConversation,
  writePartnerNotification,
} from '../../server/firebaseNotifications.ts';

const projectId = 'demo-gym-auth-test';
const authEmulatorHost = '127.0.0.1:9099';
const firestoreEmulatorHost = '127.0.0.1:8080';
process.env.FIREBASE_PROJECT_ID = projectId;
process.env.FIREBASE_AUTH_EMULATOR_HOST = authEmulatorHost;
process.env.FIRESTORE_EMULATOR_HOST = firestoreEmulatorHost;

test('verified emulator users receive server-authorized partner request notifications', async (t) => {
  const clientApp = initializeApp({
    apiKey: 'demo-api-key',
    authDomain: `${projectId}.firebaseapp.com`,
    projectId,
  }, 'api-emulator-integration-client');
  const auth = getAuth(clientApp);
  connectAuthEmulator(auth, `http://${authEmulatorHost}`, { disableWarnings: true });
  const database = new DatabaseSync(':memory:');
  const server = createServer(createGymAppApi(database, {
    partnerNotificationWriter: async (notification) => {
      try {
        await writePartnerNotification(notification);
      } catch (error) {
        // Keep emulator-only diagnostics useful without logging notification payloads.
        console.error('[API emulator test] notification write error', {
          name: error instanceof Error ? error.name : 'unknown',
          code: typeof error === 'object' && error !== null && 'code' in error
            ? String((error as { code: unknown }).code)
            : 'unknown',
          message: error instanceof Error ? error.message : 'unknown',
        });
        throw error;
      }
    },
    communityConversationWriter: writeCommunityConversation,
    communityConversationReader: readCommunityConversations,
    communityMessageReader: readCommunityMessages,
    communityNotificationReader: readCommunityNotifications,
  }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await signOut(auth);
    await deleteApp(clientApp);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    database.close();
  });

  const alice = await createVerifiedAccount(auth, `partner-alice-${randomUUID()}@bad-mergentheim.dhbw.de`);
  const bob = await createVerifiedAccount(auth, `partner-bob-${randomUUID()}@dhbw-mosbach.de`);
  await linkAccount(baseUrl, alice.token);
  await linkAccount(baseUrl, bob.token);
  await updateProfile(baseUrl, alice.token, 'Emulator Alice');
  await updateProfile(baseUrl, bob.token, 'Emulator Bob');

  const membersResponse = await api(baseUrl, '/api/gym/community/members', alice.token);
  assert.equal(membersResponse.response.status, 200);
  const bobMember = (membersResponse.body.members as Array<{ id: string; firstName: string }>)
    .find((member) => member.firstName === 'Emulator Bob');
  assert.ok(bobMember);

  const requestResponse = await api(baseUrl, '/api/gym/community/partner-requests', alice.token, {
    method: 'POST',
    body: { receiverId: bobMember.id, senderId: 'client-forged-sender' },
  });
  assert.equal(requestResponse.response.status, 201);
  assert.equal(requestResponse.body.notificationStatus, 'sent');
  const requestId = requestResponse.body.id as string;

  const firestore = getFirestore(getFirebaseAdminApp());
  const bobNotifications = await firestore.collection('users').doc(bob.uid).collection('notifications')
    .where('resourceId', '==', requestId).get();
  assert.equal(bobNotifications.size, 1);
  assert.equal(bobNotifications.docs[0]?.data().senderId, alice.uid);
  assert.equal(bobNotifications.docs[0]?.data().userId, bob.uid);
  assert.equal(bobNotifications.docs[0]?.data().type, 'partner_request');

  const acceptResponse = await api(baseUrl, `/api/gym/community/partner-requests/${requestId}`, bob.token, {
    method: 'PUT',
    body: { status: 'accepted', senderId: 'client-forged-sender' },
  });
  assert.equal(acceptResponse.response.status, 200);
  assert.equal(acceptResponse.body.notificationStatus, 'sent');

  const aliceNotifications = await firestore.collection('users').doc(alice.uid).collection('notifications')
    .where('resourceId', '==', requestId).get();
  assert.equal(aliceNotifications.size, 1);
  assert.equal(aliceNotifications.docs[0]?.data().senderId, bob.uid);
  assert.equal(aliceNotifications.docs[0]?.data().type, 'partner_accepted');

  const conversationResponse = await api(baseUrl, '/api/gym/community/conversations', alice.token, {
    method: 'POST',
    body: { partnerPrincipalId: bobMember.id, otherParticipantUid: 'client-forged-uid' },
  });
  assert.equal(conversationResponse.response.status, 200);
  assert.equal(conversationResponse.body.otherParticipantUid, bob.uid);
  const conversationId = conversationResponse.body.conversationId as string;
  const conversation = await firestore.collection('conversations').doc(conversationId).get();
  assert.deepEqual(conversation.get('participantIds'), [alice.uid, bob.uid].sort());

  const messageId = 'message_for_api';
  await firestore.collection('conversations').doc(conversationId).collection('messages').doc(messageId).set({
    id: messageId,
    conversationId,
    senderId: alice.uid,
    senderName: 'Emulator Alice',
    text: 'Validated server-side message',
    createdAt: new Date().toISOString(),
  });
  await firestore.collection('conversations').doc('unsafe_conversation').set({
    id: 'unsafe_conversation',
    participantIds: [alice.uid, bob.uid],
    participantNames: { [alice.uid]: 'Emulator Alice', [bob.uid]: 'Emulator Bob' },
    createdAt: new Date().toISOString(),
    privateEmail: 'must-not-leak@example.com',
  });
  await firestore.collection('users').doc(alice.uid).collection('notifications').doc('unsafe_notification').set({
    id: 'unsafe_notification',
    userId: alice.uid,
    senderId: bob.uid,
    type: 'partner_accepted',
    title: 'Unsafe notification',
    message: 'Must be omitted',
    read: false,
    privateEmail: 'must-not-leak@example.com',
  });

  const conversationList = await api(baseUrl, '/api/gym/community/conversations', alice.token);
  assert.equal(conversationList.response.status, 200);
  const conversations = conversationList.body.conversations as Array<Record<string, unknown>>;
  assert.ok(conversations.some((item) => item.id === conversationId));
  assert.ok(!conversations.some((item) => item.id === 'unsafe_conversation'));
  assert.ok(conversations.every((item) => !('privateEmail' in item)));

  const messagesResponse = await api(
    baseUrl,
    `/api/gym/community/conversations/${conversationId}/messages`,
    alice.token,
  );
  assert.equal(messagesResponse.response.status, 200);
  const messages = messagesResponse.body.messages as Array<Record<string, unknown>>;
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.text, 'Validated server-side message');
  assert.ok(!('privateEmail' in (messages[0] ?? {})));

  const notificationsResponse = await api(baseUrl, '/api/gym/community/notifications', alice.token);
  assert.equal(notificationsResponse.response.status, 200);
  const notifications = notificationsResponse.body.notifications as Array<Record<string, unknown>>;
  assert.ok(notifications.some((item) => item.type === 'partner_accepted'));
  assert.ok(!notifications.some((item) => item.id === 'unsafe_notification'));
  assert.ok(notifications.every((item) => !('privateEmail' in item)));

  const charlie = await createVerifiedAccount(auth, `community-outsider-${randomUUID()}@dhbw-mosbach.de`);
  await linkAccount(baseUrl, charlie.token);
  const outsiderMessages = await api(
    baseUrl,
    `/api/gym/community/conversations/${conversationId}/messages`,
    charlie.token,
  );
  assert.equal(outsiderMessages.response.status, 404);
});

async function createVerifiedAccount(auth: ReturnType<typeof getAuth>, email: string) {
  const password = `test-${randomUUID()}-Pass9`;
  const credential = await createUserWithEmailAndPassword(auth, email, password);
  await sendEmailVerification(credential.user);
  const response = await fetch(
    `http://${authEmulatorHost}/emulator/v1/projects/${projectId}/oobCodes`,
  );
  assert.equal(response.ok, true);
  const result = (await response.json()) as {
    oobCodes?: Array<{ email: string; oobCode: string; requestType: string }>;
  };
  const code = result.oobCodes?.find(
    (item) => item.email === email && item.requestType === 'VERIFY_EMAIL',
  );
  assert.ok(code);
  await applyActionCode(auth, code.oobCode);
  const verified = await signInWithEmailAndPassword(auth, email, password);
  const token = await verified.user.getIdToken();
  const account = { uid: verified.user.uid, token };
  await signOut(auth);
  return account;
}

async function linkAccount(baseUrl: string, token: string): Promise<void> {
  const result = await api(baseUrl, '/api/gym/auth/link', token, {
    method: 'POST',
    body: {},
  });
  assert.equal(result.response.status, 200);
}

async function updateProfile(baseUrl: string, token: string, firstName: string): Promise<void> {
  const result = await api(baseUrl, '/api/gym/profile/community', token, {
    method: 'PUT',
    body: { firstName, lastNameInitial: 'T' },
  });
  assert.equal(result.response.status, 200);
}

async function api(
  baseUrl: string,
  path: string,
  token: string,
  options: { method?: string; body?: Record<string, unknown> } = {},
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  return {
    response,
    body: response.status === 204 ? {} : await response.json() as Record<string, unknown>,
  };
}
