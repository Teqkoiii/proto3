import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { validateDhbwTestConfig } from './dhbw-test-config.mjs';

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'dhbw-test-config-'));
  const repositoryRoot = join(root, 'repository');
  mkdirSync(join(repositoryRoot, 'data'), { recursive: true });
  return {
    root,
    repositoryRoot,
    databasePath: join(root, 'isolated', 'gym-test.sqlite3'),
    config: {
      FIREBASE_PROJECT_ID: 'dhbw-gym-test',
      VITE_FIREBASE_PROJECT_ID: 'dhbw-gym-test',
      DHBW_TEST_CREDENTIALS_CONFIRMED: 'dhbw-gym-test',
      GYM_APP_DATABASE_PATH: join(root, 'isolated', 'gym-test.sqlite3'),
      HOST: '127.0.0.1',
      VITE_FIREBASE_API_KEY: 'test-web-api-key',
      VITE_FIREBASE_APP_ID: '1:93969186943:web:testappid',
      VITE_FIREBASE_AUTH_DOMAIN: 'dhbw-gym-test.firebaseapp.com',
      VITE_FIREBASE_MESSAGING_SENDER_ID: '93969186943',
      VITE_FIREBASE_FIRESTORE_DATABASE_ID: '(default)',
    },
  };
}

function withFixture(callback) {
  const fixture = createFixture();
  try {
    return callback(fixture);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

test('accepts a complete test-project configuration and returns the isolated database path', () => {
  withFixture(({ config, repositoryRoot, databasePath }) => {
    assert.deepEqual(validateDhbwTestConfig({
      config,
      environment: {},
      repositoryRoot,
    }), {
      projectId: 'dhbw-gym-test',
      databasePath,
      firestoreDatabaseId: '(default)',
    });
  });
});

test('rejects either client or server selecting the previous Firebase project', () => {
  withFixture(({ config, repositoryRoot }) => {
    assert.throws(() => validateDhbwTestConfig({
      config: { ...config, FIREBASE_PROJECT_ID: 'reverberant-athlete-1c70r' },
      environment: {},
      repositoryRoot,
    }), /project IDs must be exactly dhbw-gym-test/);
    assert.throws(() => validateDhbwTestConfig({
      config: { ...config, VITE_FIREBASE_PROJECT_ID: 'reverberant-athlete-1c70r' },
      environment: {},
      repositoryRoot,
    }), /project IDs must be exactly dhbw-gym-test/);
  });
});

test('rejects a production database path and a path physically inside repository data', () => {
  withFixture(({ config, repositoryRoot }) => {
    const productionDatabasePath = join(repositoryRoot, 'data', 'gym-app.sqlite3');
    assert.throws(() => validateDhbwTestConfig({
      config: { ...config, GYM_APP_DATABASE_PATH: productionDatabasePath },
      environment: {},
      repositoryRoot,
    }), /physically outside/);
  });
});

test('requires explicit confirmation before reusing any existing database', () => {
  withFixture(({ config, repositoryRoot, databasePath }) => {
    mkdirSync(join(databasePath, '..'), { recursive: true });
    writeFileSync(databasePath, 'test-only');
    assert.throws(() => validateDhbwTestConfig({
      config,
      environment: {},
      repositoryRoot,
    }), /already exists/);
    assert.doesNotThrow(() => validateDhbwTestConfig({
      config: { ...config, DHBW_TEST_DATABASE_REUSE: '1' },
      environment: {},
      repositoryRoot,
    }));
  });
});

test('rejects credentials and emulator settings that can redirect the selected runtime', () => {
  withFixture(({ config, repositoryRoot }) => {
    assert.throws(() => validateDhbwTestConfig({
      config,
      environment: { GOOGLE_APPLICATION_CREDENTIALS: 'external-key-path' },
      repositoryRoot,
    }), /GOOGLE_APPLICATION_CREDENTIALS/);
    assert.throws(() => validateDhbwTestConfig({
      config: { ...config, FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' },
      environment: {},
      repositoryRoot,
    }), /Emulator/);
  });
});

test('rejects a web app whose sender ID or app ID does not match the test project number', () => {
  withFixture(({ config, repositoryRoot }) => {
    assert.throws(() => validateDhbwTestConfig({
      config: { ...config, VITE_FIREBASE_MESSAGING_SENDER_ID: '1078731855921' },
      environment: {},
      repositoryRoot,
    }), /sender ID/);
    assert.throws(() => validateDhbwTestConfig({
      config: { ...config, VITE_FIREBASE_APP_ID: '1:1078731855921:web:oldapp' },
      environment: {},
      repositoryRoot,
    }), /Web App ID/);
  });
});

test('requires the Firestore database used by the Firebase Admin notification writer', () => {
  withFixture(({ config, repositoryRoot }) => {
    assert.throws(() => validateDhbwTestConfig({
      config: { ...config, VITE_FIREBASE_FIRESTORE_DATABASE_ID: 'named-test-database' },
      environment: {},
      repositoryRoot,
    }), /requires the \(default\) Firestore database/);
  });
});
