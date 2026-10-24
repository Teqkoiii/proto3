import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { validateDhbwTestConfig } from './dhbw-test-config.mjs';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const checkOnly = process.argv.includes('--check');
const checkConfigPath = process.env.DHBW_TEST_CONFIG_PATH;
if (checkConfigPath && !checkOnly) {
  throw new Error('DHBW_TEST_CONFIG_PATH is permitted only for offline --check validation.');
}
const configPath = checkConfigPath
  ? resolve(checkConfigPath)
  : resolve(repositoryRoot, '.env.dhbw-test.local');
const parsed = dotenv.config({ path: configPath, quiet: true });

if (parsed.error) {
  throw new Error('Missing .env.dhbw-test.local; copy the example and fill in the test project configuration.');
}

const config = parsed.parsed ?? {};
const { projectId, databasePath, firestoreDatabaseId } = validateDhbwTestConfig({
  config,
  environment: process.env,
  repositoryRoot,
});

if (checkOnly) {
  console.info('DHBW test configuration is structurally valid; no server or Firebase connection was started.');
  console.info(`Project: ${projectId}; Firestore database: ${firestoreDatabaseId}`);
  console.info(`SQLite path: ${databasePath}`);
  process.exit(0);
}

const environment = {
  ...process.env,
  ...config,
  NODE_ENV: 'development',
  HOST: '127.0.0.1',
  DOTENV_CONFIG_PATH: configPath,
  FIREBASE_PROJECT_ID: projectId,
  VITE_FIREBASE_PROJECT_ID: projectId,
  DHBW_TEST_CREDENTIALS_CONFIRMED: projectId,
};
delete environment.GOOGLE_APPLICATION_CREDENTIALS;
delete environment.GCLOUD_PROJECT;

console.info(`Starting local DHBW test API at http://127.0.0.1:${config.PORT || '43128'}`);
console.info(`Firebase project: ${projectId}`);
console.info(`SQLite database: ${databasePath}`);

const child = spawn(process.execPath, [
  resolve(repositoryRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
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
  console.error('Could not start the DHBW test API:', error.message);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  if (signal && !stopping) {
    console.error(`The DHBW test API exited unexpectedly with signal ${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? (stopping ? 0 : 1);
});
