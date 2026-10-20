export interface CalendarBookingInput {
  startsAt: string;
  durationMinutes: number;
  title?: string;
  entryType?: 'planned' | 'reservation';
}

export async function submitCalendarBooking({
  bookingId,
  input,
  onCreate,
  onUpdate,
  onSuccess,
}: {
  bookingId: string | null;
  input: CalendarBookingInput;
  onCreate: (input: CalendarBookingInput) => void;
  onUpdate: (id: string, input: CalendarBookingInput) => Promise<boolean>;
  onSuccess: () => void;
}): Promise<void> {
  if (!bookingId) {
    onCreate(input);
    return;
  }

  if (await onUpdate(bookingId, input)) onSuccess();
}
