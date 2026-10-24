import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { deleteApp, initializeApp } from 'firebase/app';
import {
  connectAuthEmulator,
  applyActionCode,
  createUserWithEmailAndPassword,
  getAuth,
  sendEmailVerification,
  signInWithEmailAndPassword,
  type Auth,
} from 'firebase/auth';
import { createFirebaseAuthClient } from '../../src/services/firebaseAuth.ts';

const projectId = 'demo-gym-auth-test';
const emulatorHost = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099';
const authEmulatorUrl = `http://${emulatorHost}`;
const clientAppName = 'auth-emulator-test-client';

let auth: Auth;
let firebaseAuth: ReturnType<typeof createFirebaseAuthClient>;

before(async () => {
  const clientApp = initializeApp({
    apiKey: 'demo-api-key',
    authDomain: `${projectId}.firebaseapp.com`,
    projectId,
  }, clientAppName);
  auth = getAuth(clientApp);
  connectAuthEmulator(auth, authEmulatorUrl, { disableWarnings: true });
  firebaseAuth = createFirebaseAuthClient(auth);
});

after(async () => {
  await firebaseAuth.logoutFirebase();
  await deleteApp(auth.app);
});

test('email registration sends verification and blocks login until the account is verified', async () => {
  const email = `verified-${Date.now()}@bad-mergentheim.dhbw.de`;
  const password = 'test-password-only-123';

  await firebaseAuth.registerWithEmailAndPassword(email, password);
  assert.equal(auth.currentUser, null, 'registration must leave no signed-in unverified session');

  await assert.rejects(
    firebaseAuth.loginWithEmailAndPassword(email, password),
    /bestätige zuerst deine E-Mail-Adresse/i,
  );
  assert.equal(auth.currentUser, null, 'unverified login must sign out before rejecting');

  await firebaseAuth.resendVerificationEmail(email, password);
  assert.equal(auth.currentUser, null, 'resending verification must sign out afterward');

  const response = await fetch(`${authEmulatorUrl}/emulator/v1/projects/${projectId}/oobCodes`);
  assert.equal(response.ok, true, 'the Auth Emulator must expose the verification email action');
  const body = (await response.json()) as {
    oobCodes?: Array<{ email: string; oobCode: string; requestType: string }>;
  };
  const verification = body.oobCodes?.find(
    (code) => code.email === email && code.requestType === 'VERIFY_EMAIL',
  );
  assert.ok(verification, 'registration must issue a Firebase verification email action');
  await applyActionCode(auth, verification.oobCode);

  const verifiedUser = await firebaseAuth.loginWithEmailAndPassword(email, password);
  assert.equal(verifiedUser.emailVerified, true);
  assert.ok(await firebaseAuth.getFirebaseIdToken());

  await firebaseAuth.logoutFirebase();
  assert.equal(auth.currentUser, null);
  const returningUser = await firebaseAuth.loginWithEmailAndPassword(email, password);
  assert.equal(returningUser.uid, verifiedUser.uid, 'verified accounts can sign in again after logout');
});

test('duplicate registration, wrong credentials, and resend for verified accounts are rejected', async () => {
  const email = `auth-errors-${Date.now()}@dhbw-mosbach.de`;
  const password = 'test-password-only-456';
  const credential = await createUserWithEmailAndPassword(auth, email, password);
  await firebaseAuth.logoutFirebase();

  await assert.rejects(
    firebaseAuth.registerWithEmailAndPassword(email, password),
    (error: unknown) => error instanceof Error && /email-already-in-use/i.test(error.message),
  );
  await assert.rejects(
    firebaseAuth.loginWithEmailAndPassword(email, 'wrong-test-password'),
    (error: unknown) => error instanceof Error && /invalid-credential|wrong-password/i.test(error.message),
  );
  assert.equal(auth.currentUser, null, 'failed credential attempts must not leave an authenticated user');

  await sendEmailVerification(credential.user);
  const response = await fetch(`${authEmulatorUrl}/emulator/v1/projects/${projectId}/oobCodes`);
  assert.equal(response.ok, true);
  const body = (await response.json()) as {
    oobCodes?: Array<{ email: string; oobCode: string; requestType: string }>;
  };
  const verification = body.oobCodes?.find(
    (code) => code.email === email && code.requestType === 'VERIFY_EMAIL',
  );
  assert.ok(verification);
  await applyActionCode(auth, verification.oobCode);

  await assert.rejects(
    firebaseAuth.resendVerificationEmail(email, password),
    /bereits bestätigt/i,
  );
  assert.equal(auth.currentUser, null, 'already-verified resend attempts must sign out');
});

test('resending verification does not expose its temporary sign-in to app auth observers', async () => {
  const email = `resend-isolation-${Date.now()}@bad-mergentheim.dhbw.de`;
  const password = 'test-password-only-789';
  await firebaseAuth.registerWithEmailAndPassword(email, password);

  const observedUids: string[] = [];
  let resolveInitialState!: () => void;
  const initialState = new Promise<void>((resolve) => {
    resolveInitialState = resolve;
  });
  const unsubscribe = firebaseAuth.subscribeToAuth((user) => {
    if (user) observedUids.push(user.uid);
    resolveInitialState();
  });

  try {
    await initialState;
    await firebaseAuth.resendVerificationEmail(email, password);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(observedUids.length, 0, 'temporary resend sign-in must not look like an app login');
    assert.equal(auth.currentUser, null);
    assert.equal(await firebaseAuth.getFirebaseIdToken(), undefined);
  } finally {
    unsubscribe();
  }
});

test('Firebase Auth emulator network errors are surfaced rather than converted to success', async () => {
  const disconnectedApp = initializeApp({
    apiKey: 'demo-api-key',
    authDomain: `${projectId}.firebaseapp.com`,
    projectId,
  }, 'auth-emulator-unreachable-test');
  const disconnectedAuth = getAuth(disconnectedApp);
  connectAuthEmulator(disconnectedAuth, 'http://127.0.0.1:1', { disableWarnings: true });
  const disconnectedClient = createFirebaseAuthClient(disconnectedAuth);

  try {
    await assert.rejects(
      disconnectedClient.loginWithEmailAndPassword('missing@bad-mergentheim.dhbw.de', 'test-password-only-123'),
      (error: unknown) => error instanceof Error && /network|fetch|failed/i.test(error.message),
    );
  } finally {
    await disconnectedClient.logoutFirebase();
    await deleteApp(disconnectedApp);
  }
});
