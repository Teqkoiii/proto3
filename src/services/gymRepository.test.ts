import assert from 'node:assert/strict';
import test from 'node:test';
import { createGymRepository } from './gymRepository.ts';

test('updateBooking sends the existing booking ID and returns the updated booking', async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const booking = {
    id: 'booking-123',
    startsAt: '2026-10-21T15:00:00.000Z',
    endsAt: '2026-10-21T16:00:00.000Z',
    title: 'Krafttraining',
  };
  const repository = createGymRepository(async (input, init) => {
    calls.push({ input, init });
    return new Response(JSON.stringify({ booking }), { status: 200 });
  });

  const update = {
    startsAt: booking.startsAt,
    durationMinutes: 60,
    title: booking.title,
    entryType: 'planned' as const,
  };

  const result = await repository.updateBooking('booking id/123', update);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, '/api/gym/my/bookings/booking%20id%2F123');
  assert.equal(calls[0].init?.method, 'PUT');
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), update);
  assert.deepEqual(result, booking);
});

test('central API client attaches a Firebase ID token as a bearer header', async () => {
  let capturedHeaders: HeadersInit | undefined;
  const repository = createGymRepository(async (_input, init) => {
    capturedHeaders = init?.headers;
    return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
  }, async () => 'verified-firebase-id-token');

  await repository.getSession();

  assert.equal((capturedHeaders as Record<string, string>).Authorization, 'Bearer verified-firebase-id-token');
});

test('community chat creation sends the stable profile ID to the authenticated API', async () => {
  let capturedInput = '';
  let capturedInit: RequestInit | undefined;
  const repository = createGymRepository(async (input, init) => {
    capturedInput = input;
    capturedInit = init;
    return new Response(JSON.stringify({
      conversationId: 'alice_bob',
      otherParticipantUid: 'firebase-bob',
    }), { status: 200 });
  }, async () => 'verified-firebase-id-token');

  const result = await repository.createCommunityConversation('stable-principal-bob');

  assert.equal(capturedInput, '/api/gym/community/conversations');
  assert.equal(capturedInit?.method, 'POST');
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    partnerPrincipalId: 'stable-principal-bob',
  });
  assert.equal((capturedInit?.headers as Record<string, string>).Authorization, 'Bearer verified-firebase-id-token');
  assert.deepEqual(result, {
    conversationId: 'alice_bob',
    otherParticipantUid: 'firebase-bob',
  });
});
