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
