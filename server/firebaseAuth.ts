import { applicationDefault, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

export interface VerifiedFirebaseIdentity {
  uid: string;
  email: string | null;
  emailVerified: boolean;
}

export function getFirebaseAdminApp(): App {
  const projectId = process.env.FIREBASE_PROJECT_ID?.trim();

  if (!projectId) {
    throw new Error('FIREBASE_PROJECT_ID is required for Firebase authentication');
  }

  const appName = 'gym-community-api';
  const existingApp = getApps().find((app) => app.name === appName);

  const app = existingApp ?? initializeApp(
    process.env.FIREBASE_AUTH_EMULATOR_HOST
      ? { projectId }
      : { credential: applicationDefault(), projectId },
    appName,
  );

  return app;
}

function getFirebaseAdminAuth() {
  return getAuth(getFirebaseAdminApp());
}

export async function verifyFirebaseIdToken(
  token: string,
): Promise<VerifiedFirebaseIdentity> {
  if (!token || token.length > 10_000) {
    throw new Error('Invalid Firebase ID token');
  }

  const decoded = await getFirebaseAdminAuth().verifyIdToken(token, true);

  if (!decoded.uid || typeof decoded.email_verified !== 'boolean') {
    throw new Error('Firebase token is missing required identity claims');
  }

  return {
    uid: decoded.uid,
    email: typeof decoded.email === 'string' ? decoded.email : null,
    emailVerified: decoded.email_verified,
  };
}
