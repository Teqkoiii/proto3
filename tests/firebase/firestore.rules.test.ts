import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { after, before } from 'node:test';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';

const projectId = 'demo-gym-auth-test';
const alice = { uid: 'alice', email: 'alice@bad-mergentheim.dhbw.de', email_verified: true };
const bob = { uid: 'bob', email: 'bob@dhbw-mosbach.de', email_verified: true };
const outsider = { uid: 'outsider', email: 'outsider@example.com', email_verified: true };

let environment: RulesTestEnvironment;

before(async () => {
  environment = await initializeTestEnvironment({
    projectId,
    firestore: {
      rules: await readFile(new URL('../../firestore.rules', import.meta.url), 'utf8'),
    },
  });
});

after(async () => {
  await environment.cleanup();
});

async function resetFirestore(): Promise<void> {
  await environment.clearFirestore();
}

function signedIn(identity: { uid: string; email: string; email_verified: boolean }) {
  return environment.authenticatedContext(identity.uid, {
    email: identity.email,
    email_verified: identity.email_verified,
  }).firestore();
}

function profile(userId: string, isPublicPresence: boolean) {
  return {
    userId,
    firstName: userId,
    isPublicPresence,
    trainingGoals: ['strength'],
    preferredTimes: ['morning'],
  };
}

function notification(input: {
  id: string;
  userId: string;
  senderId: string;
  type: 'partner_request' | 'partner_accepted' | 'new_message' | 'slot_reminder' | 'gym_alert';
  resourceId?: string;
  eventId?: string;
}) {
  return {
    id: input.id,
    userId: input.userId,
    senderId: input.senderId,
    type: input.type,
    title: 'Test notification',
    message: 'Test message',
    read: false,
    ...(input.resourceId ? { resourceId: input.resourceId } : {}),
    ...(input.eventId ? { eventId: input.eventId } : {}),
  };
}

test('unmatched healthcheck documents remain denied to unauthenticated users', async () => {
  await resetFirestore();
  const publicHealthcheck = doc(environment.unauthenticatedContext().firestore(), 'test/healthcheck');
  await assertFails(getDoc(publicHealthcheck));
});

test('Firestore access requires a verified DHBW email and rejects lookalike domains', async () => {
  await resetFirestore();
  const publicProfile = doc(environment.unauthenticatedContext().firestore(), 'community_profiles/alice');
  await environment.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'community_profiles/alice'), profile('alice', true));
  });

  await assertSucceeds(getDoc(doc(signedIn(alice), 'community_profiles/alice')));
  await assertFails(getDoc(doc(signedIn({ ...alice, email_verified: false }), 'community_profiles/alice')));
  await assertFails(getDoc(doc(signedIn(outsider), 'community_profiles/alice')));
  await assertFails(setDoc(doc(signedIn(outsider), 'community_profiles/outsider'), profile('outsider', true)));
  await assertFails(getDoc(publicProfile));

  const lookalikes = [
    { uid: 'fake-one', email: 'one@dhbw-attacker.de', email_verified: true },
    { uid: 'fake-two', email: 'two@evil.dhbw-attacker.de', email_verified: true },
  ];
  for (const identity of lookalikes) {
    await assertFails(getDoc(doc(signedIn(identity), 'community_profiles/alice')));
    await assertFails(setDoc(doc(signedIn(identity), `community_profiles/${identity.uid}`), profile(identity.uid, true)));
  }
});

test('community profiles deny raw listing and reject extra fields on writes and legacy reads', async () => {
  await resetFirestore();
  await environment.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'community_profiles/alice'), profile('alice', false));
    await setDoc(doc(db, 'community_profiles/alice-public'), profile('alice', true));
    await setDoc(doc(db, 'community_profiles/legacy-private-field'), {
      ...profile('legacy-private-field', true),
      email: 'private@example.com',
    });
  });

  const aliceDb = signedIn(alice);
  const bobDb = signedIn(bob);
  await assertSucceeds(getDoc(doc(aliceDb, 'community_profiles/alice')));
  await assertFails(getDoc(doc(bobDb, 'community_profiles/alice')));
  await assertSucceeds(getDoc(doc(bobDb, 'community_profiles/alice-public')));
  await assertFails(getDoc(doc(bobDb, 'community_profiles/legacy-private-field')));
  await assertFails(getDocs(query(
    collection(bobDb, 'community_profiles'),
    where('isPublicPresence', '==', true),
  )));
  await assertFails(getDocs(collection(bobDb, 'community_profiles')));
  await assertSucceeds(updateDoc(doc(aliceDb, 'community_profiles/alice'), { firstName: 'Alice updated' }));
  await assertFails(updateDoc(doc(bobDb, 'community_profiles/alice'), { firstName: 'Takeover' }));
  await assertFails(deleteDoc(doc(bobDb, 'community_profiles/alice')));
  await assertFails(setDoc(doc(bobDb, 'community_profiles/alice-copy'), profile('alice', true)));
  await assertSucceeds(setDoc(doc(bobDb, 'community_profiles/bob'), profile('bob', true)));
  await assertFails(updateDoc(doc(bobDb, 'community_profiles/bob'), { email: 'private@example.com' }));
  await assertFails(setDoc(doc(bobDb, 'community_profiles/bob-with-private-field'), {
    ...profile('bob', true),
    email: 'private@example.com',
  }));
  await assertFails(setDoc(doc(bobDb, 'community_profiles/alice-takeover'), profile('alice', true)));
  await assertSucceeds(deleteDoc(doc(aliceDb, 'community_profiles/alice')));
});

test('partner requests are readable only by participants and writes are server-only', async () => {
  await resetFirestore();
  await environment.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'partner_requests/request-one'), {
      senderId: alice.uid,
      receiverId: bob.uid,
      status: 'pending',
      note: 'Train together',
    });
  });

  const aliceDb = signedIn(alice);
  const bobDb = signedIn(bob);
  const outsiderDb = signedIn({ ...outsider, uid: 'charlie' });
  const requestRef = doc(aliceDb, 'partner_requests/request-one');
  await assertSucceeds(getDoc(requestRef));
  await assertSucceeds(getDoc(doc(bobDb, 'partner_requests/request-one')));
  await assertFails(getDoc(doc(outsiderDb, 'partner_requests/request-one')));
  await assertSucceeds(getDocs(query(
    collection(aliceDb, 'partner_requests'),
    where('senderId', '==', alice.uid),
  )));
  await assertSucceeds(getDocs(query(
    collection(bobDb, 'partner_requests'),
    where('receiverId', '==', bob.uid),
  )));
  await assertFails(getDocs(collection(outsiderDb, 'partner_requests')));
  await assertFails(updateDoc(doc(bobDb, 'partner_requests/request-one'), { status: 'accepted' }));
  await assertFails(updateDoc(doc(bobDb, 'partner_requests/request-one'), { status: 'declined' }));
  await assertFails(updateDoc(doc(aliceDb, 'partner_requests/request-one'), { status: 'cancelled' }));
  await assertFails(updateDoc(doc(outsiderDb, 'partner_requests/request-one'), { status: 'accepted' }));
  await assertFails(deleteDoc(doc(aliceDb, 'partner_requests/request-one')));
  await assertFails(deleteDoc(doc(bobDb, 'partner_requests/request-one')));
  await assertFails(deleteDoc(doc(outsiderDb, 'partner_requests/request-one')));
  await assertFails(setDoc(doc(aliceDb, 'partner_requests/fake-request'), {
    senderId: alice.uid,
    receiverId: bob.uid,
    status: 'pending',
  }));
  await assertFails(setDoc(doc(bobDb, 'partner_requests/request-two'), {
    senderId: alice.uid,
    receiverId: bob.uid,
    status: 'pending',
    note: 'A new request',
  }));
});

test('conversations and chat messages are limited to conversation participants', async () => {
  await resetFirestore();
  await environment.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'conversations/conversation-one'), {
      id: 'conversation-one',
      participantIds: [alice.uid, bob.uid],
      participantNames: { alice: 'Alice', bob: 'Bob' },
      lastMessageText: 'Existing chat',
    });
    await setDoc(doc(db, 'conversations/conversation-one/messages/message-one'), {
      id: 'message-one',
      conversationId: 'conversation-one',
      senderId: alice.uid,
      senderName: 'Alice',
      text: 'Hello',
    });
  });

  const aliceDb = signedIn(alice);
  const bobDb = signedIn(bob);
  const charlieDb = signedIn({ ...outsider, uid: 'charlie' });
  const conversationRef = doc(aliceDb, 'conversations/conversation-one');
  const messageRef = doc(aliceDb, 'conversations/conversation-one/messages/message-one');
  await assertSucceeds(getDoc(conversationRef));
  await assertSucceeds(getDoc(doc(bobDb, 'conversations/conversation-one')));
  await assertFails(getDoc(doc(bobDb, 'conversations/conversation-with-extra-field')));
  await assertFails(getDoc(doc(charlieDb, 'conversations/conversation-one')));
  await assertSucceeds(getDocs(query(
    collection(bobDb, 'conversations'),
    where('participantIds', 'array-contains', bob.uid),
  )));
  await environment.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'conversations/conversation-with-extra-field'), {
      id: 'conversation-with-extra-field',
      participantIds: [alice.uid, bob.uid],
      privateEmail: 'private@example.com',
    });
  });
  await assertFails(getDoc(doc(bobDb, 'conversations/conversation-with-extra-field')));
  await environment.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'conversations/conversation-with-private-name'), {
      id: 'conversation-with-private-name',
      participantIds: [alice.uid, bob.uid],
      participantNames: {
        alice: 'Alice',
        bob: 'Bob',
        privateEmail: 'private@example.com',
      },
    });
  });
  await assertFails(getDoc(doc(bobDb, 'conversations/conversation-with-private-name')));
  await assertFails(getDocs(query(
    collection(bobDb, 'conversations'),
    where('participantIds', 'array-contains', bob.uid),
  )));
  await assertFails(getDocs(collection(charlieDb, 'conversations')));
  await assertSucceeds(getDoc(messageRef));
  await assertSucceeds(getDoc(doc(bobDb, 'conversations/conversation-one/messages/message-one')));
  await assertFails(getDoc(doc(charlieDb, 'conversations/conversation-one/messages/message-one')));
  await assertSucceeds(getDocs(collection(bobDb, 'conversations/conversation-one/messages')));
  await environment.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'conversations/conversation-one/messages/legacy-extra-field'), {
      id: 'legacy-extra-field',
      conversationId: 'conversation-one',
      senderId: alice.uid,
      text: 'Legacy message',
      privateEmail: 'private@example.com',
    });
  });
  await assertFails(getDoc(doc(bobDb, 'conversations/conversation-one/messages/legacy-extra-field')));
  await assertFails(getDocs(collection(bobDb, 'conversations/conversation-one/messages')));
  await assertFails(getDocs(collection(charlieDb, 'conversations/conversation-one/messages')));
  await assertFails(updateDoc(doc(charlieDb, 'conversations/conversation-one'), { lastMessageText: 'Spoofed' }));
  await assertFails(updateDoc(doc(bobDb, 'conversations/conversation-one'), { participantIds: [bob.uid] }));
  await assertSucceeds(updateDoc(doc(bobDb, 'conversations/conversation-one'), {
    lastMessageText: 'Reply',
    lastSenderId: bob.uid,
    lastMessageAt: '2026-10-22T08:00:00.000Z',
  }));
  await assertFails(updateDoc(doc(bobDb, 'conversations/conversation-one'), {
    lastMessageText: 'Spoofed sender',
    lastSenderId: alice.uid,
  }));
  await assertFails(updateDoc(doc(bobDb, 'conversations/conversation-one'), {
    lastMessageText: 'Malformed timestamp',
    lastSenderId: bob.uid,
    lastMessageAt: 'not-a-timestamp',
  }));
  await assertFails(updateDoc(doc(bobDb, 'conversations/conversation-one'), {
    lastMessageText: 'Invalid sender metadata',
    lastSenderId: 'charlie',
  }));
  await assertFails(setDoc(doc(aliceDb, 'conversations/conversation-two'), {
    id: 'conversation-two',
    participantIds: [alice.uid, bob.uid],
    participantNames: { alice: 'Alice', bob: 'Bob' },
  }));
  await assertSucceeds(setDoc(doc(bobDb, 'conversations/conversation-one/messages/reply'), {
    id: 'reply',
    conversationId: 'conversation-one',
    senderId: bob.uid,
    senderName: 'Bob',
    text: 'Reply',
  }));
  await assertFails(setDoc(doc(bobDb, 'conversations/conversation-one/messages/extra-field'), {
    id: 'extra-field',
    conversationId: 'conversation-one',
    senderId: bob.uid,
    senderName: 'Bob',
    text: 'Reply',
    privateEmail: 'private@example.com',
  }));
  await assertFails(setDoc(doc(charlieDb, 'conversations/forged-conversation'), {
    id: 'forged-conversation',
    participantIds: [alice.uid, bob.uid],
  }));
  await assertFails(setDoc(doc(aliceDb, 'conversations/one-person'), {
    id: 'one-person',
    participantIds: [alice.uid],
  }));
  await assertFails(setDoc(doc(aliceDb, 'conversations/group-chat'), {
    id: 'group-chat',
    participantIds: [alice.uid, bob.uid, 'charlie'],
  }));
  await assertFails(setDoc(doc(aliceDb, 'conversations/duplicate-participant'), {
    id: 'duplicate-participant',
    participantIds: [alice.uid, alice.uid],
  }));
  await assertFails(setDoc(doc(charlieDb, 'conversations/conversation-one/messages/forged'), {
    id: 'forged',
    conversationId: 'conversation-one',
    senderId: alice.uid,
    senderName: 'Alice',
    text: 'Forged message',
  }));
  await assertFails(deleteDoc(doc(bobDb, 'conversations/conversation-one/messages/message-one')));
  await assertSucceeds(deleteDoc(doc(aliceDb, 'conversations/conversation-one/messages/message-one')));
});

test('notifications are private and cross-user delivery requires a real participant event', async () => {
  await resetFirestore();
  await environment.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'partner_requests/request-one'), {
      senderId: alice.uid,
      receiverId: bob.uid,
      status: 'pending',
    });
    await setDoc(doc(db, 'conversations/conversation-one'), {
      id: 'conversation-one',
      participantIds: [alice.uid, bob.uid],
      participantNames: { alice: 'Alice', bob: 'Bob' },
    });
    await setDoc(doc(db, 'conversations/conversation-one/messages/message-one'), {
      id: 'message-one',
      conversationId: 'conversation-one',
      senderId: alice.uid,
      text: 'A valid chat message',
    });
    await setDoc(doc(db, 'users/alice/notifications/existing'), notification({
      id: 'existing',
      userId: alice.uid,
      senderId: alice.uid,
      type: 'slot_reminder',
    }));
  });

  const aliceDb = signedIn(alice);
  const bobDb = signedIn(bob);
  await assertSucceeds(getDocs(collection(aliceDb, 'users/alice/notifications')));
  await assertSucceeds(getDoc(doc(aliceDb, 'users/alice/notifications/existing')));
  await environment.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'users/alice/notifications/legacy-extra-field'), {
      ...notification({
        id: 'legacy-extra-field',
        userId: alice.uid,
        senderId: alice.uid,
        type: 'slot_reminder',
      }),
      privateEmail: 'private@example.com',
    });
  });
  await assertFails(getDoc(doc(aliceDb, 'users/alice/notifications/legacy-extra-field')));
  await assertFails(getDocs(collection(aliceDb, 'users/alice/notifications')));
  await assertFails(getDoc(doc(bobDb, 'users/alice/notifications/existing')));
  await assertFails(getDocs(collection(bobDb, 'users/alice/notifications')));
  await assertFails(updateDoc(doc(bobDb, 'users/alice/notifications/existing'), { read: true }));
  await assertFails(deleteDoc(doc(bobDb, 'users/alice/notifications/existing')));
  await assertSucceeds(setDoc(doc(aliceDb, 'users/alice/notifications/reminder'), {
    ...notification({
      id: 'reminder',
      userId: alice.uid,
      senderId: alice.uid,
      type: 'slot_reminder',
    }),
    linkUrl: '/calendar',
  }));
  await assertFails(setDoc(doc(aliceDb, 'users/alice/notifications/external-link'), {
    ...notification({
      id: 'external-link',
      userId: alice.uid,
      senderId: alice.uid,
      type: 'slot_reminder',
    }),
    linkUrl: 'https://untrusted.example',
  }));
  await assertFails(setDoc(doc(aliceDb, 'users/alice/notifications/extra-field'), {
    ...notification({
      id: 'extra-field',
      userId: alice.uid,
      senderId: alice.uid,
      type: 'slot_reminder',
    }),
    privateEmail: 'private@example.com',
  }));
  await assertFails(setDoc(doc(aliceDb, 'users/bob/notifications/spoofed-reminder'), notification({
    id: 'spoofed-reminder',
    userId: bob.uid,
    senderId: alice.uid,
    type: 'slot_reminder',
  })));
  await assertFails(setDoc(doc(aliceDb, 'users/bob/notifications/unrelated'), notification({
    id: 'unrelated',
    userId: bob.uid,
    senderId: alice.uid,
    type: 'partner_request',
  })));
  await assertFails(setDoc(doc(aliceDb, 'users/bob/notifications/partner-request'), notification({
    id: 'partner-request',
    userId: bob.uid,
    senderId: alice.uid,
    type: 'partner_request',
    resourceId: 'request-one',
  })));
  await assertFails(setDoc(doc(bobDb, 'users/alice/notifications/partner-accepted'), notification({
    id: 'partner-accepted',
    userId: alice.uid,
    senderId: bob.uid,
    type: 'partner_accepted',
    resourceId: 'request-one',
  })));
  await assertSucceeds(setDoc(doc(aliceDb, 'users/bob/notifications/new-message'), notification({
    id: 'new-message',
    userId: bob.uid,
    senderId: alice.uid,
    type: 'new_message',
    resourceId: 'conversation-one',
    eventId: 'message-one',
  })));
  await assertFails(setDoc(doc(aliceDb, 'users/bob/notifications/missing-event'), notification({
    id: 'missing-event',
    userId: bob.uid,
    senderId: alice.uid,
    type: 'new_message',
    resourceId: 'conversation-one',
    eventId: 'no-such-message',
  })));
  await assertFails(setDoc(doc(aliceDb, 'users/outsider/notifications/new-message'), notification({
    id: 'new-message',
    userId: outsider.uid,
    senderId: alice.uid,
    type: 'new_message',
    resourceId: 'conversation-one',
    eventId: 'message-one',
  })));
});
