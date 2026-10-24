import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import test, { type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { GymAppRepository } from './gymAppRepository.ts';
import { createGymAppApi } from './gym-app-api.ts';
import { hashPassword } from './password.ts';

function firebaseToken(uid: string, email = `${uid}@dhbw.de`, emailVerified = true): string {
  return Buffer.from(JSON.stringify({ uid, email, emailVerified })).toString('base64url');
}

async function startApi(t: TestContext, options: {
  secureCookies?: boolean;
  allowedOrigins?: string[];
  firebaseTokenVerifier?: (token: string) => Promise<{ uid: string; email: string | null; emailVerified: boolean }>;
  communityConversationWriter?: (conversation: { id: string; participantIds: string[]; participantNames: Record<string, string>; createdAt: string; title?: string }) => Promise<void>;
} = {}) {
  const database = new DatabaseSync(':memory:');
  const server = createServer(createGymAppApi(database, {
    secureCookies: options.secureCookies ?? false,
    allowedOrigins: options.allowedOrigins,
    communityConversationWriter: options.communityConversationWriter,
    firebaseTokenVerifier: options.firebaseTokenVerifier ?? (async (token) => {
      if (token === 'revoked-token') throw new Error('token has been revoked');
      try {
        return JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as {
          uid: string;
          email: string | null;
          emailVerified: boolean;
        };
      } catch {
        throw new Error('invalid fake token');
      }
    }),
  }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    database.close();
  });
  return { baseUrl: `http://127.0.0.1:${address.port}`, database };
}

async function createAuthenticatedClient(baseUrl: string, uid: string, options: { email?: string; cookie?: string; legacyPassword?: string } = {}) {
  const token = firebaseToken(uid, options.email ?? `${uid}@dhbw.de`);
  const linkResponse = await fetch(`${baseUrl}/api/gym/auth/link`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(options.cookie ? { cookie: options.cookie } : {}),
    },
    body: JSON.stringify(options.legacyPassword ? { legacyPassword: options.legacyPassword } : {}),
  });
  assert.equal(linkResponse.status, 200);
  const session = await linkResponse.json() as Record<string, unknown>;
  assert.equal(session.identity, 'firebase-account');
  assert.equal('principalId' in session, false, 'server profile IDs must not be exposed to the browser');
  return {
    token,
    async request(path: string, init: RequestInit = {}) {
      return fetch(`${baseUrl}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...init.headers,
        },
      });
    },
  };
}

async function createLegacyProfile(database: DatabaseSync, options: { email?: string; password?: string } = {}) {
  const token = 'a'.repeat(64);
  const now = new Date().toISOString();
  const repository = new GymAppRepository(database);
  const principalId = repository.createAnonymousPrincipal(
    createHash('sha256').update(token).digest('hex'),
    now,
    new Date(Date.now() + 86_400_000).toISOString(),
  );
  if (options.email && options.password) {
    repository.createLocalCredentials(principalId, options.email, await hashPassword(options.password), now);
  }
  return { token, principalId, repository };
}

test('public occupancy and booking-slot reads do not trigger cleanup or write history samples', async (t) => {
  const { baseUrl, database } = await startApi(t);
  const legacy = await createLegacyProfile(database);
  const sessionHash = createHash('sha256').update(legacy.token).digest('hex');
  database.prepare('UPDATE app_sessions SET expires_at = ? WHERE session_hash = ?')
    .run(new Date(Date.now() - 60_000).toISOString(), sessionHash);
  database.prepare('UPDATE occupancy_samples SET sampled_at = ?')
    .run(new Date(Date.now() - 120_000).toISOString());

  const beforeSamples = (database.prepare('SELECT COUNT(*) AS count FROM occupancy_samples').get() as { count: number }).count;
  for (let i = 0; i < 3; i += 1) {
    const response = await fetch(`${baseUrl}/api/gym/occupancy?range=24h`);
    assert.equal(response.status, 200);
    const snapshot = await response.json() as {
      count: number;
      source: string;
      history: { points: unknown[] };
    };
    assert.equal(snapshot.count, 0, 'the public snapshot must still return the current occupancy');
    assert.equal(snapshot.source, 'self-reported-manual-check-ins');
    assert.ok(Array.isArray(snapshot.history.points), 'the public endpoint must continue returning history points');
    const bookingsResponse = await fetch(`${baseUrl}/api/gym/bookings`);
    assert.equal(bookingsResponse.status, 200);
    const bookingSnapshot = await bookingsResponse.json() as { slots: unknown[]; capacityConfigured: boolean };
    assert.ok(Array.isArray(bookingSnapshot.slots), 'the public booking endpoint must continue returning slots');
    assert.equal(bookingSnapshot.capacityConfigured, false);
  }
  const afterSamples = (database.prepare('SELECT COUNT(*) AS count FROM occupancy_samples').get() as { count: number }).count;
  const expiredSessionRows = (database.prepare('SELECT COUNT(*) AS count FROM app_sessions WHERE session_hash = ?')
    .get(sessionHash) as { count: number }).count;

  assert.equal(afterSamples, beforeSamples, 'public GET requests must not create occupancy history samples');
  assert.equal(expiredSessionRows, 1, 'public GET requests must not trigger database cleanup');
});

test('manual check-in is shared, idempotent, and scoped to the server session', async (t) => {
  const { baseUrl } = await startApi(t);
  assert.equal((await fetch(`${baseUrl}/api/gym/check-in`, { method: 'POST' })).status, 401);
  const first = await createAuthenticatedClient(baseUrl, 'first');
  const second = await createAuthenticatedClient(baseUrl, 'second');

  assert.equal((await first.request('/api/gym/occupancy').then((response) => response.json()) as { count: number }).count, 0);
  const firstCheckIn = await first.request('/api/gym/check-in', { method: 'POST' });
  assert.equal(firstCheckIn.status, 200);
  const timestamp = (await firstCheckIn.json() as { checkedInAt: string }).checkedInAt;
  await first.request('/api/gym/check-in', { method: 'POST' });
  assert.equal((await first.request('/api/gym/visits').then((response) => response.json()) as { visits: unknown[] }).visits.length, 1);
  assert.equal((await second.request('/api/gym/session').then((response) => response.json()) as { checkedInAt: string | null }).checkedInAt, null);
  assert.equal((await second.request('/api/gym/occupancy').then((response) => response.json()) as { count: number }).count, 1);

  const checkOut = await first.request('/api/gym/check-out', { method: 'POST' });
  assert.equal(checkOut.status, 200);
  assert.equal((await first.request('/api/gym/occupancy').then((response) => response.json()) as { count: number }).count, 0);
  const visits = (await first.request('/api/gym/visits').then((response) => response.json()) as { visits: Array<{ checkedInAt: string; checkedOutAt: string | null }> }).visits;
  assert.equal(visits[0]?.checkedInAt, timestamp);
  assert.ok(visits[0]?.checkedOutAt);
});

test('reservations are shared as aggregate slots, never limited by capacity, and private records cannot be accessed across profiles', async (t) => {
  const { baseUrl } = await startApi(t);
  const owner = await createAuthenticatedClient(baseUrl, 'booking-owner');
  const other = await createAuthenticatedClient(baseUrl, 'booking-other');
  const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  const created = await owner.request('/api/gym/bookings', {
    method: 'POST',
    body: JSON.stringify({ startsAt, durationMinutes: 60, title: 'Krafttraining' }),
  });
  assert.equal(created.status, 201);
  const booking = (await created.json() as { booking: { id: string } }).booking;
  const shared = await other.request('/api/gym/bookings').then((response) => response.json()) as {
    slots: Array<{ reserved: number; availablePlaces: number | null }>;
  };
  assert.equal(shared.slots[0]?.reserved, 1);
  assert.equal(shared.slots[0]?.availablePlaces, null);
  assert.equal((await other.request('/api/gym/my/bookings').then((response) => response.json()) as { bookings: unknown[] }).bookings.length, 0);
  assert.equal((await other.request(`/api/gym/my/bookings/${booking.id}`, { method: 'DELETE' })).status, 404);
  const otherBooking = await other.request('/api/gym/bookings', {
    method: 'POST',
    body: JSON.stringify({ startsAt, durationMinutes: 60 }),
  });
  assert.equal(otherBooking.status, 201, 'a second profile must be able to book the same time');
  const afterOther = await otherBooking.json() as { reserved: number; capacity: number | null; availablePlaces: number | null };
  assert.equal(afterOther.reserved, 2);
  assert.equal(afterOther.capacity, null);
  assert.equal(afterOther.availablePlaces, null);
  assert.equal((await owner.request('/api/gym/bookings', {
    method: 'POST',
    body: JSON.stringify({ startsAt, durationMinutes: 60 }),
  })).status, 409, 'only the same profile booking the identical slot twice is a duplicate');
});

test('workouts and goals persist per Firebase profile and can be deleted by their owner', async (t) => {
  const { baseUrl } = await startApi(t);
  const owner = await createAuthenticatedClient(baseUrl, 'workout-owner');
  const other = await createAuthenticatedClient(baseUrl, 'workout-other');
  const workout = {
    title: 'Ganzkörper',
    occurredAt: new Date().toISOString(),
    exercises: [{ name: 'Kniebeuge', sets: [{ reps: 8, weightKg: 40 }, { reps: 8, weightKg: 45 }] }],
  };

  const created = await owner.request('/api/gym/workouts', { method: 'POST', body: JSON.stringify(workout) });
  assert.equal(created.status, 201);
  const id = (await created.json() as { id: string }).id;
  assert.equal((await owner.request('/api/gym/workouts').then((response) => response.json()) as { workouts: unknown[] }).workouts.length, 1);
  assert.equal((await other.request('/api/gym/workouts').then((response) => response.json()) as { workouts: unknown[] }).workouts.length, 0);
  assert.equal((await other.request(`/api/gym/workouts/${id}`, { method: 'DELETE' })).status, 404);

  assert.equal((await owner.request('/api/gym/goals', { method: 'PUT', body: JSON.stringify({ weeklySessions: 4 }) })).status, 200);
  assert.equal((await owner.request('/api/gym/goals').then((response) => response.json()) as { weeklySessions: number }).weeklySessions, 4);
  assert.equal((await other.request('/api/gym/goals').then((response) => response.json()) as { weeklySessions: number }).weeklySessions, 3);
  assert.equal((await owner.request('/api/gym/my/data', { method: 'DELETE' })).status, 204);
  assert.equal((await owner.request('/api/gym/workouts').then((response) => response.json()) as { workouts: unknown[] }).workouts.length, 0);
});

test('valid, missing, invalid, and revoked Firebase tokens are handled securely', async (t) => {
  const { baseUrl } = await startApi(t);
  const validToken = firebaseToken('valid-user');
  const requestWithToken = (token: string) => fetch(`${baseUrl}/api/gym/session`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal((await requestWithToken(validToken)).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/gym/session`)).status, 401);
  assert.equal((await requestWithToken('not-a-token')).status, 401);
  assert.equal((await requestWithToken('revoked-token')).status, 401);
});

test('concurrent first-time Firebase requests resolve to one stable principal', async (t) => {
  const { baseUrl, database } = await startApi(t);
  const token = firebaseToken('concurrent-user');
  const link = () => fetch(`${baseUrl}/api/gym/auth/link`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  const responses = await Promise.all([link(), link()]);
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  const repository = new GymAppRepository(database);
  const principal = repository.findPrincipalForVerifiedAccount('firebase', 'concurrent-user');
  assert.ok(principal);
  assert.equal(
    (database.prepare('SELECT COUNT(*) AS count FROM gym_principals WHERE account_id = (SELECT id FROM gym_accounts WHERE provider = ? AND subject = ?)').get('firebase', 'concurrent-user') as { count: number }).count,
    1,
  );
});

test('Firebase identity must have a verified email on an allowed DHBW domain', async (t) => {
  const { baseUrl } = await startApi(t);
  const unverified = await fetch(`${baseUrl}/api/gym/session`, {
    headers: { authorization: `Bearer ${firebaseToken('unverified', 'unverified@dhbw.de', false)}` },
  });
  assert.equal(unverified.status, 403);
  const wrongDomain = await fetch(`${baseUrl}/api/gym/session`, {
    headers: { authorization: `Bearer ${firebaseToken('external', 'user@example.com')}` },
  });
  assert.equal(wrongDomain.status, 403);
  const lookalikeDomain = await fetch(`${baseUrl}/api/gym/session`, {
    headers: { authorization: `Bearer ${firebaseToken('lookalike', 'user@dhbw-attacker.de')}` },
  });
  assert.equal(lookalikeDomain.status, 403);
});

test('legacy cookies cannot authenticate protected routes and recovery codes cannot sign in', async (t) => {
  const { baseUrl } = await startApi(t);
  const cookie = `gym_app_session=${'b'.repeat(64)}`;
  const protectedRoutes: Array<{ method: string; path: string; body?: unknown }> = [
    { method: 'GET', path: '/api/gym/session' },
    { method: 'POST', path: '/api/gym/logout' },
    { method: 'POST', path: '/api/gym/check-in' },
    { method: 'POST', path: '/api/gym/check-out' },
    { method: 'GET', path: '/api/gym/calendar/events' },
    { method: 'GET', path: '/api/gym/profile/community' },
    { method: 'PUT', path: '/api/gym/profile/community', body: {} },
    { method: 'GET', path: '/api/gym/community/members' },
    { method: 'GET', path: '/api/gym/community/partner-requests' },
    { method: 'POST', path: '/api/gym/community/partner-requests', body: {} },
    { method: 'PUT', path: '/api/gym/community/partner-requests/request-id', body: {} },
    { method: 'GET', path: '/api/gym/my/bookings' },
    { method: 'POST', path: '/api/gym/bookings', body: {} },
    { method: 'PUT', path: '/api/gym/my/bookings/booking-id', body: {} },
    { method: 'DELETE', path: '/api/gym/my/bookings/booking-id' },
    { method: 'GET', path: '/api/gym/visits' },
    { method: 'GET', path: '/api/gym/workouts' },
    { method: 'POST', path: '/api/gym/workouts', body: {} },
    { method: 'DELETE', path: '/api/gym/workouts/workout-id' },
    { method: 'GET', path: '/api/gym/plans' },
    { method: 'POST', path: '/api/gym/plans', body: {} },
    { method: 'PUT', path: '/api/gym/plans/plan-id', body: {} },
    { method: 'DELETE', path: '/api/gym/plans/plan-id' },
    { method: 'GET', path: '/api/gym/goals' },
    { method: 'PUT', path: '/api/gym/goals', body: {} },
    { method: 'POST', path: '/api/gym/profile/recover', body: { recoveryCode: 'A'.repeat(43) } },
    { method: 'DELETE', path: '/api/gym/my/data' },
  ];
  for (const route of protectedRoutes) {
    const headers: Record<string, string> = { cookie };
    if (route.body) headers['content-type'] = 'application/json';
    const response = await fetch(`${baseUrl}${route.path}`, {
      method: route.method,
      headers,
      ...(route.body ? { body: JSON.stringify(route.body) } : {}),
    });
    assert.equal(response.status, 401, `${route.method} ${route.path} must reject cookie-only access`);
  }

  const linkWithoutToken = await fetch(`${baseUrl}/api/gym/auth/link`, { method: 'POST', body: '{}' });
  assert.equal(linkWithoutToken.status, 401);
  assert.equal((await fetch(`${baseUrl}/api/gym/profile/recovery-code`, { method: 'POST' })).status, 404);
  for (const path of ['/api/gym/register', '/api/gym/login']) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'legacy@dhbw.de', password: 'old-password' }),
    });
    assert.equal(response.status, 410, `${path} must remain disabled`);
    assert.equal(response.headers.get('set-cookie'), null);
  }

  const client = await createAuthenticatedClient(baseUrl, 'recovery-user');
  const recover = await client.request('/api/gym/profile/recover', {
    method: 'POST',
    body: JSON.stringify({ recoveryCode: 'A'.repeat(43) }),
  });
  assert.equal(recover.status, 410);
  assert.equal(recover.headers.get('set-cookie'), null);
});

test('legacy profiles migrate only with a matching legacy session or previous password', async (t) => {
  const { baseUrl, database } = await startApi(t);
  const email = 'existing@dhbw.de';
  const previousPassword = 'previous-password';
  const legacy = await createLegacyProfile(database, { email, password: previousPassword });
  const now = new Date();
  const nowIso = now.toISOString();
  const bookingStart = new Date(now.getTime() + 7 * 86_400_000).toISOString();
  legacy.repository.createWorkout(legacy.principalId, {
    id: 'migration-workout',
    title: 'Existing workout',
    occurredAt: nowIso,
    notes: '',
    exercises: [{ name: 'Squat', sets: [{ reps: 5, weightKg: 80 }] }],
  }, nowIso);
  legacy.repository.createTrainingPlan(legacy.principalId, {
    id: 'migration-plan',
    name: 'Existing plan',
    notes: 'Keep this plan',
    exercises: [{ name: 'Deadlift', targetSets: 3, targetReps: 5, targetWeightKg: 90 }],
  }, nowIso);
  legacy.repository.upsertCommunityProfile({
    principalId: legacy.principalId,
    firstName: 'Existing',
    lastNameInitial: 'P',
    courseOfStudy: 'Informatik',
    trainingGoals: ['strength'],
    preferredTimes: ['morning'],
    interests: ['lifting'],
    bio: 'Existing profile',
    isPublicPresence: true,
    updatedAt: nowIso,
  });
  legacy.repository.setWeeklyGoal(legacy.principalId, 5, nowIso);
  legacy.repository.createBooking(legacy.principalId, {
    id: 'migration-booking',
    startsAt: bookingStart,
    endsAt: new Date(Date.parse(bookingStart) + 60 * 60_000).toISOString(),
    title: 'Existing booking',
    entryType: 'reservation',
  }, nowIso);
  legacy.repository.checkIn(
    legacy.principalId,
    nowIso,
    new Date(now.getTime() + 8 * 60 * 60_000).toISOString(),
  );
  const token = firebaseToken('existing-firebase-uid', email);

  const emailOnly = await fetch(`${baseUrl}/api/gym/auth/link`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ principalId: legacy.principalId }),
  });
  assert.equal(emailOnly.status, 409, 'an email match or client principalId is not proof of ownership');
  const suppliedPrincipal = await fetch(`${baseUrl}/api/gym/auth/link`, {
    method: 'POST',
    headers: { authorization: `Bearer ${firebaseToken('unrelated-user', 'unrelated@dhbw.de')}`, 'content-type': 'application/json' },
    body: JSON.stringify({ principalId: legacy.principalId }),
  });
  assert.equal(suppliedPrincipal.status, 200);
  const storedPrincipal = legacy.repository.findPrincipalForVerifiedAccount('firebase', 'unrelated-user');
  assert.notEqual(storedPrincipal, legacy.principalId, 'the server must ignore client-supplied principalId');
  const invalidProof = await fetch(`${baseUrl}/api/gym/auth/link`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ legacyPassword: 'wrong-password' }),
  });
  assert.equal(invalidProof.status, 401);

  const linked = await createAuthenticatedClient(baseUrl, 'existing-firebase-uid', { email, legacyPassword: previousPassword });
  assert.equal((await linked.request('/api/gym/workouts').then((response) => response.json()) as { workouts: Array<{ id: string }> }).workouts[0]?.id, 'migration-workout');
  assert.equal((await linked.request('/api/gym/plans').then((response) => response.json()) as { plans: Array<{ id: string; name: string }> }).plans[0]?.id, 'migration-plan');
  const migratedProfile = await linked.request('/api/gym/profile/community').then((response) => response.json()) as {
    profile: { firstName: string; bio: string };
  };
  assert.equal(migratedProfile.profile.firstName, 'Existing');
  assert.equal(migratedProfile.profile.bio, 'Existing profile');
  assert.equal((await linked.request('/api/gym/my/bookings').then((response) => response.json()) as { bookings: Array<{ id: string }> }).bookings[0]?.id, 'migration-booking');
  assert.equal((await linked.request('/api/gym/visits').then((response) => response.json()) as { visits: unknown[] }).visits.length, 1);
  assert.equal((await linked.request('/api/gym/goals').then((response) => response.json()) as { weeklySessions: number }).weeklySessions, 5);
  assert.equal((await linked.request('/api/gym/session').then((response) => response.json()) as { checkedInAt: string | null }).checkedInAt, nowIso);
  assert.equal((await fetch(`${baseUrl}/api/gym/auth/link`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ legacyPassword: previousPassword }),
  })).status, 200, 'a linked Firebase UID resolves to the same profile on subsequent requests');
  const duplicateIdentity = await fetch(`${baseUrl}/api/gym/auth/link`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${firebaseToken('second-firebase-uid', email)}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ legacyPassword: previousPassword }),
  });
  assert.equal(duplicateIdentity.status, 409, 'an existing profile cannot be reassigned to a second Firebase UID');
});

test('a legacy session cannot link a Firebase account with a different email', async (t) => {
  const { baseUrl, database } = await startApi(t);
  const legacy = await createLegacyProfile(database, { email: 'old-address@dhbw.de', password: 'previous-password' });
  const response = await fetch(`${baseUrl}/api/gym/auth/link`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${firebaseToken('different-email-uid', 'new-address@dhbw.de')}`,
      cookie: `gym_app_session=${legacy.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 403);
  assert.equal(legacy.repository.findPrincipalForVerifiedAccount('firebase', 'different-email-uid'), undefined);
  assert.ok(legacy.repository.findSession(
    createHash('sha256').update(legacy.token).digest('hex'),
    new Date().toISOString(),
  ), 'a failed linking attempt must not consume the legacy session');
});

test('parallel attempts cannot link one legacy profile to two Firebase identities', async (t) => {
  const { baseUrl, database } = await startApi(t);
  const email = 'parallel-link@dhbw.de';
  const legacy = await createLegacyProfile(database, { email, password: 'previous-password' });
  const link = (uid: string) => fetch(`${baseUrl}/api/gym/auth/link`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${firebaseToken(uid, email)}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ legacyPassword: 'previous-password' }),
  });

  const responses = await Promise.all([link('parallel-uid-one'), link('parallel-uid-two')]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  assert.equal(
    (database.prepare('SELECT COUNT(*) AS count FROM gym_accounts WHERE provider = ?').get('firebase') as { count: number }).count,
    1,
    'only one Firebase account may claim the legacy principal',
  );
  assert.ok(legacy.repository.findPrincipalForVerifiedAccount('firebase', 'parallel-uid-one') ||
    legacy.repository.findPrincipalForVerifiedAccount('firebase', 'parallel-uid-two'));
});

test('a valid previous session can migrate its own profile without enabling cookie fallback', async (t) => {
  const { baseUrl, database } = await startApi(t);
  const legacy = await createLegacyProfile(database);
  const secondLegacyToken = 'd'.repeat(64);
  legacy.repository.createSession(
    createHash('sha256').update(secondLegacyToken).digest('hex'),
    legacy.principalId,
    new Date().toISOString(),
    new Date(Date.now() + 86_400_000).toISOString(),
  );
  legacy.repository.createWorkout(legacy.principalId, {
    id: 'session-migration-workout',
    title: 'Session workout',
    occurredAt: new Date().toISOString(),
    notes: '',
    exercises: [{ name: 'Row', sets: [{ reps: 8, weightKg: 40 }] }],
  }, new Date().toISOString());
  const token = firebaseToken('session-migration', 'session-migration@dhbw.de');
  const cookie = `gym_app_session=${legacy.token}`;
  assert.equal((await fetch(`${baseUrl}/api/gym/workouts`, { headers: { cookie } })).status, 401);
  const linked = await fetch(`${baseUrl}/api/gym/auth/link`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      cookie,
    },
  });
  assert.equal(linked.status, 200);
  assert.match(linked.headers.get('set-cookie') ?? '', /Max-Age=0/);
  assert.equal(legacy.repository.findSession(
    createHash('sha256').update(legacy.token).digest('hex'),
    new Date().toISOString(),
  ), undefined, 'a migrated legacy session is retired');
  assert.equal(legacy.repository.findSession(
    createHash('sha256').update(secondLegacyToken).digest('hex'),
    new Date().toISOString(),
  ), undefined, 'all legacy sessions for the migrated profile are retired');
  const client = {
    request: (path: string) => fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } }),
  };
  assert.equal((await client.request('/api/gym/workouts').then((response) => response.json()) as { workouts: Array<{ id: string }> }).workouts[0]?.id, 'session-migration-workout');
  const activeSessionToken = 'c'.repeat(64);
  legacy.repository.createSession(
    createHash('sha256').update(activeSessionToken).digest('hex'),
    legacy.principalId,
    new Date().toISOString(),
    new Date(Date.now() + 86_400_000).toISOString(),
  );
  const logout = await fetch(`${baseUrl}/api/gym/logout`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, cookie: `gym_app_session=${activeSessionToken}` },
  });
  assert.equal(logout.status, 204);
  assert.match(logout.headers.get('set-cookie') ?? '', /Max-Age=0/);
  assert.equal(legacy.repository.findSession(
    createHash('sha256').update(activeSessionToken).digest('hex'),
    new Date().toISOString(),
  ), undefined);
  assert.equal((await fetch(`${baseUrl}/api/gym/workouts`, {
    headers: { cookie: `gym_app_session=${activeSessionToken}` },
  })).status, 401);
});

test('group conversations validate unique DHBW members and store all participant names', async (t) => {
  const written: Array<{ id: string; participantIds: string[]; participantNames: Record<string, string>; createdAt: string; title?: string }> = [];
  const { baseUrl, database } = await startApi(t, {
    communityConversationWriter: async (conversation) => { written.push(conversation); },
  });
  const owner = await createAuthenticatedClient(baseUrl, 'group-owner');
  const firstMember = await createAuthenticatedClient(baseUrl, 'group-member-one');
  const secondMember = await createAuthenticatedClient(baseUrl, 'group-member-two');
  await Promise.all([
    owner.request('/api/gym/profile/community'),
    firstMember.request('/api/gym/profile/community'),
    secondMember.request('/api/gym/profile/community'),
  ]);
  const repository = new GymAppRepository(database);
  const firstPrincipal = repository.findPrincipalForVerifiedAccount('firebase', 'group-member-one');
  const secondPrincipal = repository.findPrincipalForVerifiedAccount('firebase', 'group-member-two');
  assert.ok(firstPrincipal);
  assert.ok(secondPrincipal);

  const invalid = await owner.request('/api/gym/community/groups', {
    method: 'POST',
    body: JSON.stringify({ participantPrincipalIds: [firstPrincipal, firstPrincipal], title: 'Doppelt' }),
  });
  assert.equal(invalid.status, 400);
  assert.equal(written.length, 0);

  const created = await owner.request('/api/gym/community/groups', {
    method: 'POST',
    body: JSON.stringify({ participantPrincipalIds: [firstPrincipal, secondPrincipal], title: 'Frühschicht' }),
  });
  assert.equal(created.status, 201);
  const payload = await created.json() as { conversationId: string; participantIds: string[] };
  assert.match(payload.conversationId, /^group_/);
  assert.equal(payload.participantIds.length, 3);
  assert.equal(written.length, 1);
  assert.equal(written[0]?.title, 'Frühschicht');
  assert.equal(Object.keys(written[0]?.participantNames ?? {}).length, 3);
});

test('availability never reports a capacity or place limit', async (t) => {
  const { baseUrl } = await startApi(t);
  const client = await createAuthenticatedClient(baseUrl, 'availability-user');
  const startsAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
  const query = new URLSearchParams({ startAt: startsAt, durationMinutes: '60' });
  const availability = await client.request(`/api/gym/availability?${query}`).then((response) => response.json()) as {
    capacity: number | null;
    availablePlaces: number | null;
  };
  assert.equal(availability.capacity, null);
  assert.equal(availability.availablePlaces, null);
});

test('cross-origin preflight allows Firebase bearer authorization for exact origins', async (t) => {
  const allowedOrigin = 'capacitor://localhost';
  const { baseUrl } = await startApi(t, { secureCookies: true, allowedOrigins: [allowedOrigin] });
  const token = firebaseToken('cors-user');
  const session = await fetch(`${baseUrl}/api/gym/session`, {
    headers: { Origin: allowedOrigin, authorization: `Bearer ${token}` },
  });
  assert.equal(session.status, 200);
  assert.equal(session.headers.get('access-control-allow-origin'), allowedOrigin);
  assert.equal(session.headers.get('access-control-allow-credentials'), 'true');
  assert.equal(session.headers.get('set-cookie'), null);

  const preflight = await fetch(`${baseUrl}/api/gym/check-in`, {
    method: 'OPTIONS',
    headers: {
      Origin: allowedOrigin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization, content-type',
    },
  });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-headers') ?? '', /Authorization/i);

  const rejected = await fetch(`${baseUrl}/api/gym/check-in`, {
    method: 'POST',
    headers: {
      Origin: 'https://untrusted.example',
      'X-Forwarded-Host': 'untrusted.example',
      'X-Forwarded-Proto': 'https',
    },
  });
  assert.equal(rejected.status, 403);
});

test('recovery code cannot establish a session even when a valid Firebase session exists', async (t) => {
  const { baseUrl } = await startApi(t);
  const client = await createAuthenticatedClient(baseUrl, 'recovery-bypass-user');
  const response = await client.request('/api/gym/profile/recover', {
    method: 'POST',
    body: JSON.stringify({ recoveryCode: 'A'.repeat(43) }),
  });
  assert.equal(response.status, 410);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal((await client.request('/api/gym/profile/recovery-code', { method: 'POST' })).status, 404);
});

test('booking updates are owner-scoped and reject invalid or unauthenticated payloads', async (t) => {
  const { baseUrl } = await startApi(t);
  const owner = await createAuthenticatedClient(baseUrl, 'booking-update-owner');
  const other = await createAuthenticatedClient(baseUrl, 'booking-update-other');
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
  const afterBlocked = (await owner.request('/api/gym/my/bookings').then((response) => response.json()) as {
    bookings: Array<{ id: string; startsAt: string; endsAt: string; title: string; status: string; entryType: string }>;
  }).bookings.find((item) => item.id === booking.id);
  assert.deepEqual(afterBlocked, {
    id: booking.id,
    startsAt: updatedAt,
    endsAt: new Date(Date.parse(updatedAt) + 90 * 60 * 1000).toISOString(),
    title: 'Neu',
    status: 'planned',
    entryType: 'reservation',
  });

  const invalid = await owner.request(`/api/gym/my/bookings/${booking.id}`, {
    method: 'PUT',
    body: JSON.stringify({ startsAt: createdAt, durationMinutes: 'invalid', title: 'Fehler', entryType: 'planned' }),
  });
  assert.equal(invalid.status, 400);
  const afterInvalid = (await owner.request('/api/gym/my/bookings').then((response) => response.json()) as {
    bookings: Array<{ id: string; startsAt: string; endsAt: string; title: string; status: string; entryType: string }>;
  }).bookings.find((item) => item.id === booking.id);
  assert.deepEqual(afterInvalid, afterBlocked);
});

test('untrusted Origin cannot bypass the allowlist by spoofing X-Forwarded-Host', async (t) => {
  const { baseUrl } = await startApi(t, { secureCookies: true, allowedOrigins: ['capacitor://localhost'] });
  const token = firebaseToken('origin-spoof-user');
  const response = await fetch(`${baseUrl}/api/gym/check-in`, {
    method: 'POST',
    headers: {
      Origin: 'https://untrusted.example',
      'X-Forwarded-Host': 'untrusted.example',
      authorization: `Bearer ${token}`,
    },
  });
  assert.equal(response.status, 403);
});

test('same host with a different scheme is not treated as same-origin', async (t) => {
  const { baseUrl } = await startApi(t);
  const token = firebaseToken('origin-scheme-user');
  const requestHost = new URL(baseUrl).host;
  const response = await fetch(`${baseUrl}/api/gym/session`, {
    headers: {
      Origin: `https://${requestHost}`,
      authorization: `Bearer ${token}`,
    },
  });
  assert.equal(response.status, 403);
});
