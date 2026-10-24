import 'dotenv/config';
import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { createGymAppApi } from './server/gym-app-api.ts';
import {
  readCommunityConversations,
  readCommunityMessages,
  readCommunityNotifications,
  writeCommunityConversation,
  writePartnerNotification,
} from './server/firebaseNotifications.ts';

const isProduction = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';

const databasePath = resolve(process.env.GYM_APP_DATABASE_PATH || './data/gym-app.sqlite3');
if (process.env.FIREBASE_PROJECT_ID === 'dhbw-gym-test') {
  function resolvePhysicalPath(path: string): string {
    let current = resolve(path);
    const remainingSegments: string[] = [];
    while (!existsSync(current)) {
      const parent = dirname(current);
      if (parent === current) return resolve(current, ...remainingSegments);
      remainingSegments.unshift(basename(current));
      current = parent;
    }
    return resolve(realpathSync(current), ...remainingSegments);
  }

  const productionDataDirectory = resolve('./data');
  const relativeDatabasePath = relative(productionDataDirectory, databasePath);
  const physicalDatabasePath = resolvePhysicalPath(databasePath);
  const physicalDataDirectory = resolvePhysicalPath(productionDataDirectory);
  const relativePhysicalDatabasePath = relative(physicalDataDirectory, physicalDatabasePath);
  if (
    process.env.DHBW_TEST_CREDENTIALS_CONFIRMED !== 'dhbw-gym-test' ||
    process.env.GYM_APP_DATABASE_PATH == null ||
    !process.env.GYM_APP_DATABASE_PATH ||
    !isAbsolute(process.env.GYM_APP_DATABASE_PATH) ||
    relativeDatabasePath === '' ||
    (!relativeDatabasePath.startsWith(`..${sep}`) && relativeDatabasePath !== '..') ||
    relativePhysicalDatabasePath === '' ||
    (!relativePhysicalDatabasePath.startsWith(`..${sep}`) && relativePhysicalDatabasePath !== '..') ||
    process.env.VITE_FIREBASE_PROJECT_ID !== 'dhbw-gym-test' ||
    process.env.VITE_FIREBASE_MESSAGING_SENDER_ID !== '93969186943' ||
    process.env.VITE_FIREBASE_AUTH_DOMAIN !== 'dhbw-gym-test.firebaseapp.com' ||
    !process.env.VITE_FIREBASE_APP_ID?.startsWith('1:93969186943:web:') ||
    !process.env.VITE_FIREBASE_API_KEY ||
    process.env.VITE_FIREBASE_API_KEY.startsWith('REPLACE_WITH_') ||
    !process.env.VITE_FIREBASE_FIRESTORE_DATABASE_ID ||
    process.env.VITE_FIREBASE_FIRESTORE_DATABASE_ID.startsWith('REPLACE_WITH_') ||
    process.env.VITE_FIREBASE_FIRESTORE_DATABASE_ID !== '(default)' ||
    host !== '127.0.0.1' ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    process.env.FIREBASE_AUTH_EMULATOR_HOST ||
    process.env.FIRESTORE_EMULATOR_HOST ||
    process.env.FIREBASE_CONFIG ||
    process.env.FIREBASE_TOKEN
  ) {
    throw new Error('DHBW test mode requires explicit test-project confirmation, a separate SQLite path, and loopback binding');
  }
}
mkdirSync(dirname(databasePath), { recursive: true });
const database = new DatabaseSync(databasePath);

const app = express();

const gymApi = createGymAppApi(database, {
  secureCookies: isProduction,
  maxCheckInHours: Number(process.env.GYM_MAX_CHECK_IN_HOURS || 8),
  partnerNotificationWriter: writePartnerNotification,
  communityConversationWriter: writeCommunityConversation,
  communityConversationReader: readCommunityConversations,
  communityMessageReader: readCommunityMessages,
  communityNotificationReader: readCommunityNotifications,
});

app.use(gymApi);

if (!isProduction) {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: 'spa',
  });
  app.use(vite.middlewares);
} else {
  const distPath = resolve('dist');
  app.use(express.static(distPath));
  app.get('*', (_req, res) => {
    res.sendFile(resolve(distPath, 'index.html'));
  });
}

app.listen(port, host, () => {
  console.info(`DHBW Gym Community server running on http://${host}:${port}`);
});
