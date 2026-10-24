import { initializeApp } from 'firebase/app';
import firebaseConfig from '../../firebase-applet-config.json';
import { hasFirebaseTestWebConfig } from './firebaseAppConfig';

const authEmulatorHost = import.meta.env?.VITE_FIREBASE_AUTH_EMULATOR_HOST?.trim();
const firestoreEmulatorHost = import.meta.env?.VITE_FIREBASE_FIRESTORE_EMULATOR_HOST?.trim();
const configuredProjectId = import.meta.env?.VITE_FIREBASE_PROJECT_ID?.trim();
const testProjectId = 'dhbw-gym-test';
const testWebConfig = {
  apiKey: import.meta.env?.VITE_FIREBASE_API_KEY?.trim(),
  appId: import.meta.env?.VITE_FIREBASE_APP_ID?.trim(),
  authDomain: import.meta.env?.VITE_FIREBASE_AUTH_DOMAIN?.trim(),
  messagingSenderId: import.meta.env?.VITE_FIREBASE_MESSAGING_SENDER_ID?.trim(),
  firestoreDatabaseId: import.meta.env?.VITE_FIREBASE_FIRESTORE_DATABASE_ID?.trim(),
};
const hasTestWebConfig = hasFirebaseTestWebConfig(testWebConfig);
const isTestProject = configuredProjectId === testProjectId;

if (import.meta.env?.PROD && (authEmulatorHost || firestoreEmulatorHost || configuredProjectId || hasTestWebConfig)) {
  throw new Error('Firebase emulator and project overrides are not allowed in production builds');
}

if (configuredProjectId && !authEmulatorHost && !isTestProject) {
  throw new Error('Only the explicit DHBW test project can be selected outside the Firebase Auth Emulator');
}

if (hasTestWebConfig && !isTestProject) {
  throw new Error('DHBW test Firebase settings require VITE_FIREBASE_PROJECT_ID=dhbw-gym-test');
}

if (isTestProject) {
  if (authEmulatorHost || firestoreEmulatorHost) {
    throw new Error('The DHBW test project cannot be combined with Firebase Emulator hosts');
  }
  if (testWebConfig.messagingSenderId !== '93969186943') {
    throw new Error('The DHBW test Firebase sender ID does not match project 93969186943');
  }
  if (
    testWebConfig.authDomain !== `${testProjectId}.firebaseapp.com` ||
    !testWebConfig.appId?.startsWith('1:93969186943:web:')
  ) {
    throw new Error('The DHBW test Firebase Auth domain or Web App ID does not match the test project.');
  }
  if (Object.values(testWebConfig).some((value) => !value || value.startsWith('REPLACE_WITH_'))) {
    throw new Error('Complete the local DHBW test Firebase Web App configuration before starting the app');
  }
}

if (Boolean(authEmulatorHost) !== Boolean(firestoreEmulatorHost)) {
  throw new Error('Configure both Firebase Auth and Firestore Emulator hosts together');
}

export const firebaseProjectId = configuredProjectId || firebaseConfig.projectId;
export const firebaseApp = initializeApp({
  ...(isTestProject ? {
    apiKey: testWebConfig.apiKey!,
    appId: testWebConfig.appId!,
    authDomain: testWebConfig.authDomain!,
    messagingSenderId: testWebConfig.messagingSenderId!,
    projectId: testProjectId,
  } : {
    ...firebaseConfig,
    projectId: firebaseProjectId,
    authDomain: `${firebaseProjectId}.firebaseapp.com`,
  }),
});
export const firebaseAuthEmulatorHost = authEmulatorHost;
export const firebaseFirestoreEmulatorHost = firestoreEmulatorHost;
export const firebaseFirestoreDatabaseId = firestoreEmulatorHost
  ? import.meta.env?.VITE_FIREBASE_FIRESTORE_DATABASE_ID || '(default)'
  : isTestProject
    ? testWebConfig.firestoreDatabaseId!
    : firebaseConfig.firestoreDatabaseId;
