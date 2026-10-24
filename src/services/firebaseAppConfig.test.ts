import assert from 'node:assert/strict';
import test from 'node:test';
import { hasFirebaseTestWebConfig } from './firebaseAppConfig.ts';

test('Firestore database selection alone does not opt into a live Firebase Web App config', () => {
  assert.equal(hasFirebaseTestWebConfig({}), false);
});

test('any Firebase Web App setting requires the explicit test project selection', () => {
  for (const key of ['apiKey', 'appId', 'authDomain', 'messagingSenderId'] as const) {
    assert.equal(hasFirebaseTestWebConfig({ [key]: 'configured' }), true);
  }
});
