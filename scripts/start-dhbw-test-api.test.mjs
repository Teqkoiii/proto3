import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const launcherPath = fileURLToPath(new URL('./start-dhbw-test-api.mjs', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

function createConfig(databasePath) {
  return [
    'FIREBASE_PROJECT_ID=dhbw-gym-test',
    'VITE_FIREBASE_PROJECT_ID=dhbw-gym-test',
    'DHBW_TEST_CREDENTIALS_CONFIRMED=dhbw-gym-test',
    `GYM_APP_DATABASE_PATH=${databasePath}`,
    'HOST=127.0.0.1',
    'VITE_FIREBASE_API_KEY=test-web-api-key',
    'VITE_FIREBASE_APP_ID=1:93969186943:web:testappid',
    'VITE_FIREBASE_AUTH_DOMAIN=dhbw-gym-test.firebaseapp.com',
    'VITE_FIREBASE_MESSAGING_SENDER_ID=93969186943',
    'VITE_FIREBASE_FIRESTORE_DATABASE_ID=(default)',
  ].join('\n');
}

test('--check validates only local data and never launches the server', () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'dhbw-test-check-'));
  try {
    const configPath = join(tempDirectory, '.env.dhbw-test.local');
    const databasePath = join(tempDirectory, 'isolated', 'gym-test.sqlite3');
    writeFileSync(configPath, createConfig(databasePath));
    const environment = { ...process.env, DHBW_TEST_CONFIG_PATH: configPath };
    for (const name of [
      'GOOGLE_APPLICATION_CREDENTIALS',
      'FIREBASE_AUTH_EMULATOR_HOST',
      'FIRESTORE_EMULATOR_HOST',
      'FIREBASE_CONFIG',
      'FIREBASE_TOKEN',
      'GCLOUD_PROJECT',
    ]) delete environment[name];

    const result = spawnSync(process.execPath, [launcherPath, '--check'], {
      cwd: tempDirectory,
      env: environment,
      encoding: 'utf8',
      timeout: 10_000,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /no server or Firebase connection was started/);
    assert.match(result.stdout, /Project: dhbw-gym-test/);
    assert.doesNotMatch(result.stdout, /Starting local DHBW test API/);
    assert.doesNotMatch(result.stdout, /DHBW Gym Community server running/);
    assert.equal(result.stderr, '');
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('offline --check refuses the original Firebase project', () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'dhbw-test-check-reject-'));
  try {
    const configPath = join(tempDirectory, '.env.dhbw-test.local');
    const databasePath = join(tempDirectory, 'isolated', 'gym-test.sqlite3');
    writeFileSync(
      configPath,
      createConfig(databasePath).replace('FIREBASE_PROJECT_ID=dhbw-gym-test', 'FIREBASE_PROJECT_ID=reverberant-athlete-1c70r'),
    );
    const environment = { ...process.env, DHBW_TEST_CONFIG_PATH: configPath };
    for (const name of [
      'GOOGLE_APPLICATION_CREDENTIALS',
      'FIREBASE_AUTH_EMULATOR_HOST',
      'FIRESTORE_EMULATOR_HOST',
      'FIREBASE_CONFIG',
      'FIREBASE_TOKEN',
      'GCLOUD_PROJECT',
    ]) delete environment[name];

    const result = spawnSync(process.execPath, [launcherPath, '--check'], {
      cwd: tempDirectory,
      env: environment,
      encoding: 'utf8',
      timeout: 10_000,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /project IDs must be exactly dhbw-gym-test/);
    assert.doesNotMatch(result.stdout, /Starting local DHBW test API/);
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('direct test-project server startup refuses before creating a database or listening', () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'dhbw-test-server-guard-'));
  try {
    const databasePath = join(tempDirectory, 'not-created', 'gym-test.sqlite3');
    // Prevent the developer's repository .env from supplying the values this test intentionally omits.
    const emptyDotenvPath = join(tempDirectory, '.env-empty');
    writeFileSync(emptyDotenvPath, '');
    const environment = {
      ...process.env,
      DOTENV_CONFIG_PATH: emptyDotenvPath,
      NODE_ENV: 'development',
      FIREBASE_PROJECT_ID: 'dhbw-gym-test',
      DHBW_TEST_CREDENTIALS_CONFIRMED: 'dhbw-gym-test',
      GYM_APP_DATABASE_PATH: databasePath,
      HOST: '127.0.0.1',
      PORT: '0',
    };
    for (const name of [
      'GOOGLE_APPLICATION_CREDENTIALS',
      'FIREBASE_AUTH_EMULATOR_HOST',
      'FIRESTORE_EMULATOR_HOST',
      'FIREBASE_CONFIG',
      'FIREBASE_TOKEN',
      'GCLOUD_PROJECT',
    ]) delete environment[name];

    const result = spawnSync(process.execPath, [
      join(repositoryRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      'server.ts',
    ], {
      cwd: repositoryRoot,
      env: environment,
      encoding: 'utf8',
      timeout: 10_000,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /DHBW test mode requires/);
    assert.equal(existsSync(databasePath), false);
    assert.doesNotMatch(result.stdout, /DHBW Gym Community server running/);
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});
