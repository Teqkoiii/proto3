import assert from 'node:assert/strict';
import test from 'node:test';
import { submitCalendarBooking, type CalendarBookingInput } from './calendarBookingSubmission.ts';

const input: CalendarBookingInput = {
  startsAt: '2026-10-21T15:00:00.000Z',
  durationMinutes: 60,
  title: 'Krafttraining',
  entryType: 'planned',
};

test('editing updates the existing booking and resets the form only after success', async () => {
  const calls: string[] = [];
  let savedInput: CalendarBookingInput | undefined;
  await submitCalendarBooking({
    bookingId: 'booking-123',
    input,
    onCreate: () => calls.push('create'),
    onUpdate: async (id, updatedInput) => {
      calls.push(`update:${id}`);
      savedInput = updatedInput;
      return true;
    },
    onSuccess: () => calls.push('success'),
  });

  assert.deepEqual(calls, ['update:booking-123', 'success']);
  assert.equal(savedInput, input);
});

test('failed updates preserve the editing state and never create a duplicate', async () => {
  const calls: string[] = [];
  await submitCalendarBooking({
    bookingId: 'booking-123',
    input,
    onCreate: () => calls.push('create'),
    onUpdate: async (id) => {
      calls.push(`update:${id}`);
      return false;
    },
    onSuccess: () => calls.push('success'),
  });

  assert.deepEqual(calls, ['update:booking-123']);
});

test('new bookings still use the create handler', async () => {
  let createdInput: CalendarBookingInput | undefined;
  await submitCalendarBooking({
    bookingId: null,
    input,
    onCreate: (created) => {
      createdInput = created;
    },
    onUpdate: async () => {
      assert.fail('new bookings must not call the update handler');
    },
    onSuccess: () => assert.fail('creating a booking must not reset an edit form'),
  });

  assert.equal(createdInput, input);
});
