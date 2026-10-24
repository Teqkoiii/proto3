import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const databaseDirectory = mkdtempSync(join(tmpdir(), 'proto3-gym-auth-test-'));
const databasePath = join(databaseDirectory, 'gym-app-test.sqlite3');
const isolatedEnvFile = join(databaseDirectory, '.env');
writeFileSync(isolatedEnvFile, '');
if (existsSync(databasePath)) throw new Error('The isolated test database path unexpectedly already exists');

const emulatorProjectId = 'demo-gym-auth-test';
const apiHost = '127.0.0.1';
const apiPort = '43127';
const environment = {
  ...process.env,
  NODE_ENV: 'development',
  HOST: apiHost,
  PORT: apiPort,
  FIREBASE_PROJECT_ID: emulatorProjectId,
  FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
  GYM_APP_DATABASE_PATH: databasePath,
  DOTENV_CONFIG_PATH: isolatedEnvFile,
  VITE_FIREBASE_PROJECT_ID: emulatorProjectId,
  VITE_FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
  VITE_FIREBASE_FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
  VITE_FIREBASE_FIRESTORE_DATABASE_ID: '(default)',
};
delete environment.GOOGLE_APPLICATION_CREDENTIALS;
delete environment.FIREBASE_CONFIG;
delete environment.GCLOUD_PROJECT;
delete environment.FIREBASE_TOKEN;
delete environment.GEMINI_API_KEY;
delete environment.GOOGLE_API_KEY;

if (environment.NODE_ENV === 'production' || environment.FIREBASE_PROJECT_ID !== emulatorProjectId) {
  throw new Error('Refusing to start the isolated API with a non-test project');
}

console.info(`Starting local test API at http://${apiHost}:${apiPort}`);
console.info(`Using isolated empty test database: ${databasePath}`);
console.info(`Firebase project: ${emulatorProjectId} (local emulators only)`);

const child = spawn(process.execPath, [
  join(repositoryRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
  'server.ts',
], {
  cwd: repositoryRoot,
  env: environment,
  stdio: 'inherit',
});

let stopping = false;
function stop(signal) {
  if (!stopping) {
    stopping = true;
    child.kill(signal);
  }
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
child.on('error', (error) => {
  console.error('Could not start the isolated test API:', error.message);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  if (signal && !stopping) {
    console.error(`The isolated test API exited unexpectedly with signal ${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? (stopping ? 0 : 1);
});
