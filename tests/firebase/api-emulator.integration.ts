import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
import { GymAppRepository } from '../../server/gymAppRepository.ts';
import { hashPassword } from '../../server/password.ts';
import { getFirebaseAdminApp } from '../../server/firebaseAuth.ts';
import { writeCommunityConversation, writePartnerNotification } from '../../server/firebaseNotifications.ts';

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
    partnerNotificationWriter: writePartnerNotification,
    communityConversationWriter: writeCommunityConversation,
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

  // Legacy profiles must not be claimable by email alone; the previous password is required.
  const legacyEmail = `legacy-link-${randomUUID()}@bad-mergentheim.dhbw.de`;
  const legacyPassword = 'legacy-password-123';
  const now = new Date().toISOString();
  const repository = new GymAppRepository(database);
  const legacyPrincipalId = repository.createAnonymousPrincipal(
    randomUUID().replaceAll('-', '').repeat(2),
    now,
    new Date(Date.now() + 86_400_000).toISOString(),
  );
  repository.createLocalCredentials(legacyPrincipalId, legacyEmail, await hashPassword(legacyPassword), now);
  repository.upsertCommunityProfile({
    principalId: legacyPrincipalId,
    firstName: 'Legacy Profile',
    lastNameInitial: 'L',
    courseOfStudy: 'Pflege',
    trainingGoals: ['Kraft'],
    preferredTimes: ['abends'],
    interests: ['Fitness'],
    bio: 'Profil muss erhalten bleiben',
    isPublicPresence: true,
    updatedAt: now,
  });

  const legacyFirebaseUser = await createVerifiedAccount(auth, legacyEmail);
  const missingPassword = await api(baseUrl, '/api/gym/auth/link', legacyFirebaseUser.token, {
    method: 'POST',
    body: {},
  });
  assert.equal(missingPassword.response.status, 409);
  assertLinkRejectionDidNotMutateLegacyProfile(
    database, repository, legacyFirebaseUser.uid, legacyPrincipalId,
    { firstName: 'Legacy Profile', bio: 'Profil muss erhalten bleiben' },
  );

  const wrongPassword = await api(baseUrl, '/api/gym/auth/link', legacyFirebaseUser.token, {
    method: 'POST',
    body: { legacyPassword: 'wrong-password-123' },
  });
  assert.equal(wrongPassword.response.status, 401);
  assertLinkRejectionDidNotMutateLegacyProfile(
    database, repository, legacyFirebaseUser.uid, legacyPrincipalId,
    { firstName: 'Legacy Profile', bio: 'Profil muss erhalten bleiben' },
  );

  const linked = await api(baseUrl, '/api/gym/auth/link', legacyFirebaseUser.token, {
    method: 'POST',
    body: { legacyPassword },
  });
  assert.equal(linked.response.status, 200);

  const preservedProfile = await api(baseUrl, '/api/gym/profile/community', legacyFirebaseUser.token);
  assert.equal(preservedProfile.response.status, 200);
  assert.equal((preservedProfile.body.profile as { firstName: string }).firstName, 'Legacy Profile');
  assert.equal((preservedProfile.body.profile as { bio: string }).bio, 'Profil muss erhalten bleiben');

  // An expired legacy session must not prove ownership of an existing profile.
  const expiredEmail = `expired-link-${randomUUID()}@bad-mergentheim.dhbw.de`;
  const expiredPassword = 'expired-password-123';
  const expiredSessionToken = randomBytes(32).toString('hex');
  const expiredNow = new Date().toISOString();
  const expiredPrincipalId = repository.createAnonymousPrincipal(
    createHash('sha256').update(expiredSessionToken).digest('hex'),
    expiredNow,
    new Date(Date.now() - 60_000).toISOString(),
  );
  repository.createLocalCredentials(expiredPrincipalId, expiredEmail, await hashPassword(expiredPassword), expiredNow);
  repository.upsertCommunityProfile({
    principalId: expiredPrincipalId,
    firstName: 'Expired Session Profile',
    lastNameInitial: 'E',
    courseOfStudy: 'Pflege',
    trainingGoals: ['Ausdauer'],
    preferredTimes: ['morgens'],
    interests: ['Laufen'],
    bio: 'Abgelaufene Sitzung darf keinen Zugriff geben',
    isPublicPresence: true,
    updatedAt: expiredNow,
  });

  const expiredFirebaseUser = await createVerifiedAccount(auth, expiredEmail);
  const expiredSessionLink = await api(baseUrl, '/api/gym/auth/link', expiredFirebaseUser.token, {
    method: 'POST',
    body: {},
    cookie: `gym_app_session=${expiredSessionToken}`,
  });
  assert.equal(expiredSessionLink.response.status, 409);
  assertLinkRejectionDidNotMutateLegacyProfile(
    database, repository, expiredFirebaseUser.uid, expiredPrincipalId,
    { firstName: 'Expired Session Profile', bio: 'Abgelaufene Sitzung darf keinen Zugriff geben' },
  );

  // A verified address outside the approved DHBW domains must still be rejected.
  const externalAccount = await createVerifiedAccount(auth, `external-${randomUUID()}@example.com`);
  const externalLink = await api(baseUrl, '/api/gym/auth/link', externalAccount.token, {
    method: 'POST',
    body: {},
  });
  assert.equal(externalLink.response.status, 403);

  // An unverified DHBW address must not be allowed to link or access an account.
  const unverified = await createUnverifiedAccount(auth, `unverified-${randomUUID()}@bad-mergentheim.dhbw.de`);
  const unverifiedLink = await api(baseUrl, '/api/gym/auth/link', unverified.token, {
    method: 'POST',
    body: {},
  });
  assert.equal(unverifiedLink.response.status, 403);
});

function assertLinkRejectionDidNotMutateLegacyProfile(
  database: DatabaseSync,
  repository: GymAppRepository,
  firebaseUid: string,
  principalId: string,
  expectedProfile: { firstName: string; bio: string },
): void {
  assert.equal(
    repository.findPrincipalForVerifiedAccount('firebase', firebaseUid),
    undefined,
    'a rejected link must not associate the Firebase UID with any local profile',
  );
  assert.equal(
    database.prepare("SELECT id FROM gym_accounts WHERE provider = 'firebase' AND subject = ?")
      .get(firebaseUid),
    undefined,
    'a rejected link must not leave a Firebase account record behind',
  );

  const principal = database.prepare('SELECT account_id AS accountId FROM gym_principals WHERE id = ?')
    .get(principalId) as { accountId: string | null } | undefined;
  assert.equal(principal?.accountId, null, 'a rejected link must not alter the legacy principal');

  const profile = database.prepare(
    'SELECT first_name AS firstName, bio FROM community_profiles WHERE principal_id = ?',
  ).get(principalId) as { firstName: string; bio: string } | undefined;
  assert.ok(profile, 'the legacy profile must remain present after a rejected link');
  assert.equal(profile.firstName, expectedProfile.firstName, 'the legacy profile name must remain unchanged');
  assert.equal(profile.bio, expectedProfile.bio, 'the legacy profile bio must remain unchanged');
}

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

async function createUnverifiedAccount(auth: ReturnType<typeof getAuth>, email: string) {
  const password = `test-${randomUUID()}-Pass9`;
  const credential = await createUserWithEmailAndPassword(auth, email, password);
  await sendEmailVerification(credential.user);
  const token = await credential.user.getIdToken();
  const account = { uid: credential.user.uid, token };
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
  options: { method?: string; body?: Record<string, unknown>; cookie?: string } = {},
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  return {
    response,
    body: response.status === 204 ? {} : await response.json() as Record<string, unknown>,
  };
}
