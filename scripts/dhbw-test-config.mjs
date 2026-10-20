import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const projectId = 'dhbw-gym-test';
const projectNumber = '93969186943';

function resolvePhysicalPath(path) {
  let current = resolve(path);
  const remainingSegments = [];

  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return resolve(current, ...remainingSegments);
    remainingSegments.unshift(basename(current));
    current = parent;
  }

  return resolve(realpathSync(current), ...remainingSegments);
}

function isWithin(parent, path) {
  const pathFromParent = relative(parent, path);
  return pathFromParent === '' ||
    (!pathFromParent.startsWith(`..${sep}`) && pathFromParent !== '..' && !isAbsolute(pathFromParent));
}

export function validateDhbwTestConfig({
  config,
  environment = process.env,
  repositoryRoot,
}) {
  if (config.FIREBASE_PROJECT_ID !== projectId || config.VITE_FIREBASE_PROJECT_ID !== projectId) {
    throw new Error('Both server and client project IDs must be exactly dhbw-gym-test.');
  }
  if (config.DHBW_TEST_CREDENTIALS_CONFIRMED !== projectId) {
    throw new Error('Verify the active Google ADC identity has access to the test project, then set DHBW_TEST_CREDENTIALS_CONFIRMED=dhbw-gym-test.');
  }
  if (config.VITE_FIREBASE_MESSAGING_SENDER_ID !== projectNumber) {
    throw new Error('The test Web App sender ID must match Firebase project number 93969186943.');
  }
  if (
    config.VITE_FIREBASE_AUTH_DOMAIN !== `${projectId}.firebaseapp.com` ||
    !config.VITE_FIREBASE_APP_ID?.startsWith(`1:${projectNumber}:web:`)
  ) {
    throw new Error('The test Auth domain and Web App ID must belong to Firebase project 93969186943.');
  }
  if (config.VITE_FIREBASE_FIRESTORE_DATABASE_ID !== '(default)') {
    throw new Error('The local test setup currently requires the (default) Firestore database used by Firebase Admin.');
  }

  for (const name of [
    'VITE_FIREBASE_API_KEY',
    'VITE_FIREBASE_APP_ID',
    'VITE_FIREBASE_AUTH_DOMAIN',
    'VITE_FIREBASE_FIRESTORE_DATABASE_ID',
  ]) {
    const value = config[name]?.trim();
    if (!value || value.startsWith('REPLACE_WITH_')) {
      throw new Error(`Complete ${name} in .env.dhbw-test.local using the test Web App configuration.`);
    }
  }

  if (config.GOOGLE_APPLICATION_CREDENTIALS || environment.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error('GOOGLE_APPLICATION_CREDENTIALS is set; unset it and use the explicitly verified local ADC identity instead.');
  }
  if ([
    'FIREBASE_AUTH_EMULATOR_HOST',
    'FIRESTORE_EMULATOR_HOST',
    'FIREBASE_CONFIG',
    'FIREBASE_TOKEN',
  ].some((name) => config[name] || environment[name])) {
    throw new Error('Emulator, Firebase CLI, or alternate Firebase configuration is active; clear it before selecting live test mode.');
  }

  if (!isAbsolute(config.GYM_APP_DATABASE_PATH ?? '')) {
    throw new Error('GYM_APP_DATABASE_PATH must be an explicit absolute Windows path to a separate test database.');
  }
  const databasePath = resolve(config.GYM_APP_DATABASE_PATH);
  const productionDatabasePath = resolve(repositoryRoot, 'data', 'gym-app.sqlite3');
  const physicalDatabasePath = resolvePhysicalPath(databasePath);
  const physicalDataDirectory = resolvePhysicalPath(resolve(repositoryRoot, 'data'));
  if (
    databasePath.toLowerCase() === productionDatabasePath.toLowerCase() ||
    isWithin(physicalDataDirectory, physicalDatabasePath)
  ) {
    throw new Error('The selected test database must be physically outside the repository data directory.');
  }
  if (existsSync(databasePath) && config.DHBW_TEST_DATABASE_REUSE !== '1') {
    throw new Error('The selected test database already exists; inspect it and explicitly set DHBW_TEST_DATABASE_REUSE=1 to reuse it.');
  }
  if (config.HOST !== '127.0.0.1') {
    throw new Error('DHBW test API must bind only to 127.0.0.1.');
  }

  return {
    projectId,
    databasePath,
    firestoreDatabaseId: config.VITE_FIREBASE_FIRESTORE_DATABASE_ID,
  };
}
