import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test, { type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createGymAppApi } from './gym-app-api.ts';

async function startApi(t: TestContext, options: { secureCookies?: boolean; allowedOrigins?: string[] } = {}) {
  const database = new DatabaseSync(':memory:');
  const server = createServer(createGymAppApi(database, { secureCookies: options.secureCookies ?? false, allowedOrigins: options.allowedOrigins }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    database.close();
  });
  return { baseUrl: `http://127.0.0.1:${address.port}` };
}

async function createAnonymousClient(baseUrl: string) {
  const response = await fetch(`${baseUrl}/api/gym/session`);
  assert.equal(response.status, 200);
  const session = await response.json() as Record<string, unknown>;
  assert.equal(session.identity, 'anonymous-app-profile');
  assert.equal('principalId' in session, false, 'server profile IDs must not be exposed to the browser');
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
  assert.ok(cookie, 'server should establish an HttpOnly app session');
  return {
    cookie,
    async request(path: string, init: RequestInit = {}) {
      return fetch(`${baseUrl}${path}`, {
        ...init,
        headers: { cookie, ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
      });
    },
  };
}

// Existing tests omitted for brevity.

test('booking updates are owner-scoped and reject invalid or unauthenticated payloads', async (t) => {
  const { baseUrl } = await startApi(t);
  const owner = await createAnonymousClient(baseUrl);
  const other = await createAnonymousClient(baseUrl);
  const createdAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  const created = await owner.request('/api/gym/bookings', {
    method: 'POST',
    body: JSON.stringify({ startsAt: createdAt, durationMinutes: 60, title: 'Alt', entryType: 'planned' }),
  });
  assert.equal(created.status, 201);
  const booking = (await created.json() as { booking: { id: string } }).booking;

  const missing = await owner.request('/api/gym/my/bookings/does-not-exist', {
    method: 'PUT',
    body: JSON.stringify({ startsAt: createdAt, durationMinutes: 60, title: 'Fehler', entryType: 'planned' }),
  });
  assert.equal(missing.status, 404);

  const unauthenticated = await fetch(`${baseUrl}/api/gym/my/bookings/${booking.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ startsAt: createdAt, durationMinutes: 60, title: 'Kein Zugriff', entryType: 'planned' }),
  });
  assert.equal(unauthenticated.status, 401);

  const updatedAt = new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString();
  const updated = await owner.request(`/api/gym/my/bookings/${booking.id}`, {
    method: 'PUT',
    body: JSON.stringify({ startsAt: updatedAt, durationMinutes: 90, title: 'Neu', entryType: 'reservation' }),
  });
  assert.equal(updated.status, 200);
  const payload = await updated.json() as { booking: { title: string; entryType: string; startsAt: string } };
  assert.equal(payload.booking.title, 'Neu');
  assert.equal(payload.booking.entryType, 'reservation');
  assert.equal(payload.booking.startsAt, updatedAt);

  const blocked = await other.request(`/api/gym/my/bookings/${booking.id}`, {
    method: 'PUT',
    body: JSON.stringify({ startsAt: createdAt, durationMinutes: 60, title: 'Fremd', entryType: 'planned' }),
  });
  assert.equal(blocked.status, 404);

  const invalid = await owner.request(`/api/gym/my/bookings/${booking.id}`, {
    method: 'PUT',
    body: JSON.stringify({ startsAt: createdAt, durationMinutes: 'invalid', title: 'Fehler', entryType: 'planned' }),
  });
  assert.equal(invalid.status, 400);
});

// Existing tests continue below.
