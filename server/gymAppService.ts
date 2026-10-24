import { createHash, randomUUID } from 'node:crypto';
import {
  GymAppRepository,
  type BookingAvailability,
  type BookingRecord,
  type TrainingPlanRecord,
  type WorkoutRecord,
  type CommunityProfileRecord,
  type TrainingPartnerRequestRecord,
} from './gymAppRepository.ts';
import { verifyPasswordOrDummy } from './password.ts';
import type { VerifiedFirebaseIdentity } from './firebaseAuth.ts';

const VISIT_RETENTION_DAYS = 90;
const RESERVATION_DURATIONS = new Set([30, 60, 90, 120]);
const OCCUPANCY_RANGES: Record<string, number> = {
  '60m': 60 * 60_000,
  '3h': 3 * 60 * 60_000,
  '24h': 24 * 60 * 60_000,
  '7d': 7 * 86400_000,
};
const EMAIL_PATTERN = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i;
const DHBW_EMAIL_DOMAINS = new Set([
  'bad-mergentheim.dhbw.de',
  'badmergentheim.dhbw.de',
  'dhbw-mannheim.de',
  'dhbw-mosbach.de',
  'dhbw-stuttgart.de',
  'dhbw.de',
  'heilbronn.dhbw.de',
  'lehre.dhbw-mannheim.de',
  'lehre.mosbach.dhbw.de',
  'mosbach.dhbw.de',
]);

export function isDhbwEmail(email: string): boolean {
  if (!EMAIL_PATTERN.test(email)) return false;
  const parts = email.toLowerCase().split('@');
  if (parts.length !== 2) return false;
  return DHBW_EMAIL_DOMAINS.has(parts[1] ?? '');
}

export class GymDomainError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'GymDomainError';
    this.status = status;
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function normalizeEmail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const email = value.trim().toLowerCase();
  if (email.length < 5 || email.length > 254 || !EMAIL_PATTERN.test(email)) return undefined;
  return email;
}

export class GymAppService {
  private readonly repository: GymAppRepository;
  private readonly options: {
    maxCheckInHours: number;
    now?: () => number;
  };

  constructor(
    repository: GymAppRepository,
    options: {
      maxCheckInHours: number;
      now?: () => number;
    },
  ) {
    this.repository = repository;
    this.options = options;
    if (!Number.isFinite(options.maxCheckInHours) || options.maxCheckInHours < 1 || options.maxCheckInHours > 24) {
      throw new Error('maxCheckInHours must be between 1 and 24');
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  cleanupExpiredData(): void {
    const timestamp = this.now();
    this.repository.cleanupExpiredData(
      new Date(timestamp).toISOString(),
      new Date(timestamp - VISIT_RETENTION_DAYS * 86400_000).toISOString(),
      new Date(timestamp - 30 * 86400_000).toISOString(),
    );
  }

  resolvePrincipal(token: string | undefined): string | undefined {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return undefined;
    this.cleanupExpiredData();
    return this.repository.findSession(hashToken(token), new Date(this.now()).toISOString())?.principalId;
  }

  consumeLegacySession(token: string, principalId: string): boolean {
    return this.repository.consumeSessionForPrincipal(
      hashToken(token),
      principalId,
      new Date(this.now()).toISOString(),
    );
  }

  retireLegacySessions(principalId: string): void {
    this.repository.deleteSessionsForPrincipal(principalId);
  }

  getSession(principalId: string, email: string | null = null) {
    const timestamp = this.now();
    const checkIn = this.repository.getCheckIn(principalId, new Date(timestamp).toISOString());
    const account = this.repository.getLocalAccount(principalId);
    return {
      identity: 'firebase-account' as const,
      email: email ?? account?.email ?? null,
      checkedInAt: checkIn?.checkedInAt ?? null,
      checkInExpiresAt: checkIn?.expiresAt ?? null,
      maxCheckInHours: this.options.maxCheckInHours,
      serverTime: new Date(timestamp).toISOString(),
    };
  }

  async resolveFirebasePrincipal(
    identity: VerifiedFirebaseIdentity,
    legacySessionToken?: string,
    legacyPassword?: unknown,
  ): Promise<string> {
    if (!identity.uid || identity.uid.length > 255 || !identity.email || !identity.emailVerified ||
        !isDhbwEmail(identity.email)) {
      throw new GymDomainError('a verified DHBW Firebase account is required', 403);
    }

    const existingPrincipal = this.repository.findPrincipalForVerifiedAccount('firebase', identity.uid);
    if (existingPrincipal) {
      if (legacySessionToken && this.resolvePrincipal(legacySessionToken) === existingPrincipal) {
        this.consumeLegacySession(legacySessionToken, existingPrincipal);
      }
      return existingPrincipal;
    }

    const email = normalizeEmail(identity.email);
    if (!email) throw new GymDomainError('a valid verified email address is required', 403);

    const credentials = this.repository.findLocalCredentialsByEmail(email);
    const sessionPrincipal = this.resolvePrincipal(legacySessionToken);
    let principalId: string;
    let sessionProofToken: string | undefined;

    if (credentials) {
      const sessionProvesAccount = sessionPrincipal === credentials.principalId;
      if (sessionProvesAccount) sessionProofToken = legacySessionToken;
      if (!sessionProvesAccount) {
        if (legacyPassword === undefined) {
          throw new GymDomainError('existing profile requires its previous password to link', 409);
        }
        if (typeof legacyPassword !== 'string' || legacyPassword.length < 10 || legacyPassword.length > 128 ||
            !await verifyPasswordOrDummy(legacyPassword, credentials.passwordHash)) {
          throw new GymDomainError('previous account password is incorrect', 401);
        }
      }
      principalId = credentials.principalId;
    } else if (sessionPrincipal) {
      const sessionEmail = this.repository.getLocalAccount(sessionPrincipal)?.email;
      if (sessionEmail && sessionEmail !== email) {
        throw new GymDomainError('the previous session belongs to a different account', 403);
      }
      principalId = sessionPrincipal;
      sessionProofToken = legacySessionToken;
    } else {
      return this.repository.createOrGetFirebasePrincipal(identity.uid, new Date(this.now()).toISOString());
    }

    try {
      this.repository.linkAnonymousProfileToVerifiedAccount(
        principalId,
        'firebase',
        identity.uid,
        new Date(this.now()).toISOString(),
        sessionProofToken ? hashToken(sessionProofToken) : undefined,
      );
    } catch (error) {
      if (error instanceof Error && /legacy session is invalid or expired/i.test(error.message)) {
        throw new GymDomainError('the previous app session expired; sign in again to link this profile', 401);
      }
      if (error instanceof Error && /already linked|already exists/i.test(error.message)) {
        throw new GymDomainError('this Firebase account or profile is already linked elsewhere', 409);
      }
      throw error;
    }

    return principalId;
  }

  getOccupancy(
    rangeValue: unknown = '24h',
    options: { cleanup?: boolean; recordSample?: boolean } = {},
  ) {
    const timestamp = this.now();
    const refreshedAt = new Date(timestamp).toISOString();
    if (options.cleanup !== false) this.cleanupExpiredData();
    const count = this.repository.occupancy(refreshedAt);
    if (options.recordSample !== false) this.repository.recordOccupancySample(refreshedAt, count);
    const range = typeof rangeValue === 'string' && rangeValue in OCCUPANCY_RANGES ? rangeValue : '24h';
    const from = new Date(timestamp - OCCUPANCY_RANGES[range]).toISOString();
    return {
      count,
      plannedNow: this.repository.plannedOverlapping(refreshedAt),
      refreshedAt,
      source: 'self-reported-manual-check-ins' as const,
      disclaimer: 'User-reported occupancy from app check-ins. This is not a verified visitor count and not an access decision.',
      maxCheckInHours: this.options.maxCheckInHours,
      history: {
        range,
        points: this.repository.listOccupancyHistory(from, refreshedAt),
      },
    };
  }

  checkIn(principalId: string) {
    const timestamp = this.now();
    const result = this.repository.checkIn(
      principalId,
      new Date(timestamp).toISOString(),
      new Date(timestamp + this.options.maxCheckInHours * 60 * 60 * 1000).toISOString(),
    );
    const occupancy = this.repository.occupancy(new Date(timestamp).toISOString());
    this.repository.recordOccupancySample(new Date(timestamp).toISOString(), occupancy);
    return { ...result, maxCheckInHours: this.options.maxCheckInHours };
  }

  checkOut(principalId: string) {
    const checkedOutAt = new Date(this.now()).toISOString();
    this.repository.checkOut(principalId, checkedOutAt);
    const occupancy = this.repository.occupancy(checkedOutAt);
    this.repository.recordOccupancySample(checkedOutAt, occupancy);
    return { checkedInAt: null, checkedOutAt };
  }

  getAvailability(startAt: unknown, durationMinutes: unknown): { startAt: string; endAt: string } & BookingAvailability {
    if (!isDate(startAt) || typeof durationMinutes !== 'number' || !RESERVATION_DURATIONS.has(durationMinutes)) {
      throw new GymDomainError('valid startAt and durationMinutes are required', 400);
    }
    const startMs = Date.parse(startAt);
    if (startMs < this.now()) throw new GymDomainError('availability must be checked for a future time', 400);
    const normalizedStart = new Date(startMs).toISOString();
    const endAt = new Date(startMs + durationMinutes * 60_000).toISOString();
    return { startAt: normalizedStart, endAt, ...this.repository.availability(normalizedStart, endAt) };
  }

  listBookingSlots(fromValue: unknown, toValue: unknown) {
    const now = this.now();
    const from = isDate(fromValue) ? new Date(Date.parse(fromValue)).toISOString() : new Date(now).toISOString();
    const to = isDate(toValue) ? new Date(Date.parse(toValue)).toISOString() : new Date(now + 30 * 86400_000).toISOString();
    if (Date.parse(to) <= Date.parse(from) || Date.parse(to) - Date.parse(from) > 90 * 86400_000) {
      throw new GymDomainError('booking window must be between 0 and 90 days', 400);
    }
    this.cleanupExpiredData();
    return {
      slots: this.repository.listBookingSlots(from, to),
      capacityConfigured: false,
      bookingMeaning: 'planned-visit' as const,
    };
  }

  createBooking(principalId: string, input: unknown): { booking: BookingRecord; availability: BookingAvailability } {
    const parsed = this.parseBookingInput(input);
    const timestamp = this.now();
    if (parsed.startMs < timestamp || parsed.startMs > timestamp + 90 * 86400_000) {
      throw new GymDomainError('booking must start within the next 90 days', 400);
    }
    const booking: Omit<BookingRecord, 'status'> = {
      id: randomUUID(),
      startsAt: new Date(parsed.startMs).toISOString(),
      endsAt: new Date(parsed.startMs + parsed.durationMinutes * 60_000).toISOString(),
      title: parsed.title,
      entryType: parsed.entryType,
    };
    const result = this.repository.createBooking(principalId, booking, new Date(timestamp).toISOString());
    if ('duplicate' in result) throw new GymDomainError('you already have this time planned', 409);
    return { booking: { ...booking, status: 'planned', entryType: parsed.entryType }, availability: result.availability };
  }

  updateBooking(principalId: string, id: string, input: unknown): BookingRecord {
    const parsed = this.parseBookingInput(input);
    const timestamp = this.now();
    if (parsed.startMs < timestamp || parsed.startMs > timestamp + 90 * 86400_000) {
      throw new GymDomainError('booking must start within the next 90 days', 400);
    }
    const result = this.repository.updateBooking(principalId, id, {
      startsAt: new Date(parsed.startMs).toISOString(),
      endsAt: new Date(parsed.startMs + parsed.durationMinutes * 60_000).toISOString(),
      title: parsed.title,
      entryType: parsed.entryType,
    }, new Date(timestamp).toISOString());
    if (result === 'missing') throw new GymDomainError('planned visit not found', 404);
    if (result === 'duplicate') throw new GymDomainError('you already have this time planned', 409);
    return result;
  }

  listMyBookings(principalId: string) {
    this.cleanupExpiredData();
    return this.repository.listMyBookings(principalId);
  }

  cancelBooking(principalId: string, id: string): void {
    if (!this.repository.cancelBooking(principalId, id, new Date(this.now()).toISOString())) {
      throw new GymDomainError('planned visit not found', 404);
    }
  }

  getCommunityProfile(principalId: string): CommunityProfileRecord {
    const existing = this.repository.getCommunityProfile(principalId);
    if (existing) return existing;
    const account = this.repository.getLocalAccount(principalId);
    let defaultFirst = 'DHBW';
    let defaultInitial = 'S';
    if (account?.email) {
      const namePart = account.email.split('@')[0];
      const subParts = namePart.split('.');
      if (subParts[0]) {
        defaultFirst = subParts[0].charAt(0).toUpperCase() + subParts[0].slice(1);
      }
      if (subParts[1]) {
        defaultInitial = subParts[1].charAt(0).toUpperCase();
      }
    }
    const defaultProfile: CommunityProfileRecord = {
      principalId,
      firstName: defaultFirst,
      lastNameInitial: defaultInitial,
      courseOfStudy: 'Campus Bad Mergentheim',
      trainingGoals: ['Allgemeine Fitness & Cardio'],
      preferredTimes: ['Nachmittags (15:00 - 18:00)'],
      interests: ['Regelmäßige Gym-Buddies'],
      bio: '',
      isPublicPresence: true,
      updatedAt: new Date(this.now()).toISOString(),
    };
    this.repository.upsertCommunityProfile(defaultProfile);
    return defaultProfile;
  }

  updateCommunityProfile(principalId: string, input: unknown): CommunityProfileRecord {
    if (!isRecord(input)) throw new GymDomainError('invalid profile data', 400);
    const existing = this.getCommunityProfile(principalId);

    const firstName = typeof input.firstName === 'string' && input.firstName.trim().length > 0
      ? input.firstName.trim().slice(0, 40)
      : existing.firstName;

    const lastNameInitial = typeof input.lastNameInitial === 'string' && input.lastNameInitial.trim().length > 0
      ? input.lastNameInitial.trim().slice(0, 1).toUpperCase()
      : existing.lastNameInitial;

    const courseOfStudy = typeof input.courseOfStudy === 'string'
      ? input.courseOfStudy.trim().slice(0, 80)
      : existing.courseOfStudy;

    const trainingGoals = Array.isArray(input.trainingGoals)
      ? input.trainingGoals.filter((g): g is string => typeof g === 'string' && g.trim().length > 0).slice(0, 10)
      : existing.trainingGoals;

    const preferredTimes = Array.isArray(input.preferredTimes)
      ? input.preferredTimes.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).slice(0, 10)
      : existing.preferredTimes;

    const interests = Array.isArray(input.interests)
      ? input.interests.filter((i): i is string => typeof i === 'string' && i.trim().length > 0).slice(0, 10)
      : existing.interests;

    const bio = typeof input.bio === 'string'
      ? input.bio.trim().slice(0, 300)
      : existing.bio;

    const isPublicPresence = typeof input.isPublicPresence === 'boolean'
      ? input.isPublicPresence
      : existing.isPublicPresence;

    const updated: CommunityProfileRecord = {
      principalId,
      firstName,
      lastNameInitial,
      courseOfStudy,
      trainingGoals,
      preferredTimes,
      interests,
      bio,
      isPublicPresence,
      updatedAt: new Date(this.now()).toISOString(),
    };
    this.repository.upsertCommunityProfile(updated);
    return updated;
  }

  listCommunityMembers(principalId: string) {
    this.cleanupExpiredData();
    const nowIso = new Date(this.now()).toISOString();
    return this.repository.listCommunityMembers(principalId, nowIso);
  }

  getCalendarEvents(principalId: string, fromValue?: unknown, toValue?: unknown) {
    this.cleanupExpiredData();
    const timestamp = this.now();
    const from = isDate(fromValue) ? new Date(Date.parse(fromValue)).toISOString() : new Date(timestamp - 86400_000).toISOString();
    const to = isDate(toValue) ? new Date(Date.parse(toValue)).toISOString() : new Date(timestamp + 30 * 86400_000).toISOString();
    const events = this.repository.listCalendarEvents(from, to, principalId);
    const activeCheckIns = this.repository.listActiveCheckInsWithIdentity(new Date(timestamp).toISOString(), principalId);
    return {
      events,
      activeCheckIns,
      serverTime: new Date(timestamp).toISOString(),
    };
  }

  createPartnerRequest(senderId: string, input: unknown) {
    if (!isRecord(input) || typeof input.receiverId !== 'string' || !input.receiverId.trim()) {
      throw new GymDomainError('receiverId is required', 400);
    }
    const receiverId = input.receiverId.trim();
    if (receiverId === senderId) {
      throw new GymDomainError('cannot send a partner request to yourself', 400);
    }
    const receiverProfile = this.repository.getCommunityProfile(receiverId);
    if (!receiverProfile?.isPublicPresence) {
      throw new GymDomainError('community member not found', 404);
    }
    const note = typeof input.note === 'string' ? input.note.trim().slice(0, 200) : '';
    const proposedDate = isDate(input.proposedDate) ? new Date(Date.parse(input.proposedDate)).toISOString() : null;
    const timestamp = this.now();
    const id = randomUUID();
    this.repository.createPartnerRequest({
      id,
      senderId,
      receiverId,
      proposedDate,
      note,
      status: 'pending',
      createdAt: new Date(timestamp).toISOString(),
      updatedAt: new Date(timestamp).toISOString(),
    });
    return { id, status: 'pending' as const };
  }

  listPartnerRequests(principalId: string) {
    this.cleanupExpiredData();
    return this.repository.listPartnerRequests(principalId);
  }

  getFirebaseUidForPrincipal(principalId: string): string | undefined {
    return this.repository.findFirebaseUidForPrincipal(principalId);
  }

  getCommunityConversation(principalId: string, input: unknown) {
    if (!isRecord(input) || typeof input.partnerPrincipalId !== 'string' || !input.partnerPrincipalId.trim()) {
      throw new GymDomainError('partnerPrincipalId is required', 400);
    }
    const partnerPrincipalId = input.partnerPrincipalId.trim();
    if (partnerPrincipalId === principalId) {
      throw new GymDomainError('cannot start a conversation with yourself', 400);
    }

    const partnerProfile = this.repository.getCommunityProfile(partnerPrincipalId);
    const isAcceptedPartner = this.repository.hasAcceptedPartnerRequestBetween(principalId, partnerPrincipalId);
    if (!partnerProfile || (!partnerProfile.isPublicPresence && !isAcceptedPartner)) {
      throw new GymDomainError('community member not found', 404);
    }

    const currentUid = this.repository.findFirebaseUidForPrincipal(principalId);
    const partnerUid = this.repository.findFirebaseUidForPrincipal(partnerPrincipalId);
    if (!currentUid || !partnerUid || currentUid === partnerUid) {
      throw new GymDomainError('community member is not available for chat', 409);
    }

    const participantIds = [currentUid, partnerUid].sort();
    const id = `conv_${createHash('sha256').update(JSON.stringify(participantIds)).digest('hex')}`;
    const currentProfile = this.repository.getCommunityProfile(principalId);
    const displayName = (profile: CommunityProfileRecord | undefined, fallback: string) => (
      profile?.firstName
        ? `${profile.firstName} ${profile.lastNameInitial ? `${profile.lastNameInitial}.` : ''}`.trim().slice(0, 60)
        : fallback
    );

    return {
      id,
      participantIds,
      participantNames: {
        [currentUid]: displayName(currentProfile, 'DHBW Student'),
        [partnerUid]: displayName(partnerProfile, 'DHBW Student'),
      },
      createdAt: new Date(this.now()).toISOString(),
      otherParticipantUid: partnerUid,
    };
  }

  getPartnerRequestNotificationContext(principalId: string, requestId: string) {
    const request = this.repository.getPartnerRequestNotificationContext(requestId);
    if (!request || (request.senderId !== principalId && request.receiverId !== principalId)) {
      throw new GymDomainError('partner request not found', 404);
    }
    return request;
  }

  updatePartnerRequestStatus(principalId: string, id: string, actionInput: unknown) {
    if (!isRecord(actionInput) || typeof actionInput.status !== 'string') {
      throw new GymDomainError('status action is required', 400);
    }
    const status = actionInput.status;
    if (status !== 'accepted' && status !== 'declined' && status !== 'cancelled') {
      throw new GymDomainError('status must be accepted, declined, or cancelled', 400);
    }
    const ok = this.repository.updatePartnerRequestStatus(id, principalId, status, new Date(this.now()).toISOString());
    if (!ok) {
      throw new GymDomainError('partner request not found or not in pending state', 404);
    }
    return { id, status };
  }

  listVisits(principalId: string, fromValue: unknown, toValue: unknown) {
    this.cleanupExpiredData();
    const timestamp = this.now();
    const from = isDate(fromValue) ? new Date(Date.parse(fromValue)).toISOString() : new Date(timestamp - VISIT_RETENTION_DAYS * 86400_000).toISOString();
    const to = isDate(toValue) ? new Date(Date.parse(toValue)).toISOString() : new Date(timestamp + 86400_000).toISOString();
    if (Date.parse(to) <= Date.parse(from) || Date.parse(to) - Date.parse(from) > 400 * 86400_000) {
      throw new GymDomainError('visit window is invalid', 400);
    }
    return { visits: this.repository.listVisits(principalId, from, to), retentionDays: VISIT_RETENTION_DAYS };
  }

  listWorkouts(principalId: string): { workouts: WorkoutRecord[] } {
    this.cleanupExpiredData();
    return { workouts: this.repository.listWorkouts(principalId) };
  }

  createWorkout(principalId: string, input: unknown): { id: string } {
    if (!isRecord(input) || typeof input.title !== 'string' || input.title.trim().length < 1 || input.title.length > 80 ||
        !isDate(input.occurredAt) || !Array.isArray(input.exercises) || input.exercises.length < 1 || input.exercises.length > 30) {
      throw new GymDomainError('workout needs a title, date and at least one exercise', 400);
    }
    if (input.notes !== undefined && (typeof input.notes !== 'string' || input.notes.length > 500)) {
      throw new GymDomainError('workout notes must be at most 500 characters', 400);
    }
    const timestamp = this.now();
    const occurredAtMs = Date.parse(input.occurredAt);
    if (occurredAtMs > timestamp + 60_000 || occurredAtMs < timestamp - 365 * 86400_000) {
      throw new GymDomainError('workout date must be within the past year and not in the future', 400);
    }
    const exercises = input.exercises as unknown[];
    const validExercises = exercises.every((exercise) => isRecord(exercise) &&
      typeof exercise.name === 'string' && exercise.name.trim().length > 0 && exercise.name.length <= 80 &&
      Array.isArray(exercise.sets) && exercise.sets.length > 0 && exercise.sets.length <= 20 &&
      exercise.sets.every((set) => isRecord(set) && Number.isInteger(set.reps) && Number(set.reps) > 0 && Number(set.reps) <= 100 &&
        typeof set.weightKg === 'number' && Number.isFinite(set.weightKg) && set.weightKg >= 0 && set.weightKg <= 500));
    if (!validExercises) throw new GymDomainError('exercise sets need valid repetitions and weights', 400);

    const workout: WorkoutRecord = {
      id: randomUUID(),
      title: input.title.trim(),
      occurredAt: new Date(occurredAtMs).toISOString(),
      notes: typeof input.notes === 'string' ? input.notes.trim() : '',
      exercises: exercises.map((exercise) => {
        const item = exercise as { name: string; sets: Array<{ reps: number; weightKg: number }> };
        return { name: item.name.trim(), sets: item.sets.map((set) => ({ reps: set.reps, weightKg: set.weightKg })) };
      }),
    };
    this.repository.createWorkout(principalId, workout, new Date(timestamp).toISOString());
    return { id: workout.id };
  }

  deleteWorkout(principalId: string, id: string): void {
    if (!this.repository.deleteWorkout(principalId, id)) throw new GymDomainError('workout not found', 404);
  }

  listTrainingPlans(principalId: string): { plans: TrainingPlanRecord[] } {
    return { plans: this.repository.listTrainingPlans(principalId) };
  }

  createTrainingPlan(principalId: string, input: unknown): { id: string } {
    const plan = this.parseTrainingPlan(input, randomUUID());
    this.repository.createTrainingPlan(principalId, plan, new Date(this.now()).toISOString());
    return { id: plan.id };
  }

  updateTrainingPlan(principalId: string, id: string, input: unknown): void {
    if (!this.repository.updateTrainingPlan(principalId, this.parseTrainingPlan(input, id), new Date(this.now()).toISOString())) {
      throw new GymDomainError('training plan not found', 404);
    }
  }

  deleteTrainingPlan(principalId: string, id: string): void {
    if (!this.repository.deleteTrainingPlan(principalId, id)) throw new GymDomainError('training plan not found', 404);
  }

  getWeeklyGoal(principalId: string): { weeklySessions: number } {
    return { weeklySessions: this.repository.getWeeklyGoal(principalId) };
  }

  setWeeklyGoal(principalId: string, input: unknown): { weeklySessions: number } {
    const weeklySessions = isRecord(input) ? input.weeklySessions : undefined;
    if (typeof weeklySessions !== 'number' || !Number.isInteger(weeklySessions) || weeklySessions < 1 || weeklySessions > 14) {
      throw new GymDomainError('weeklySessions must be an integer between 1 and 14', 400);
    }
    this.repository.setWeeklyGoal(principalId, weeklySessions, new Date(this.now()).toISOString());
    return { weeklySessions };
  }

  deletePersonalData(principalId: string): void {
    this.repository.deletePersonalData(principalId);
  }

  private parseBookingInput(input: unknown): { startMs: number; durationMinutes: number; title: string; entryType: 'planned' | 'reservation' } {
    if (!isRecord(input) || !isDate(input.startsAt) || typeof input.durationMinutes !== 'number' ||
        !RESERVATION_DURATIONS.has(input.durationMinutes) ||
        (input.title !== undefined && (typeof input.title !== 'string' || input.title.length > 80))) {
      throw new GymDomainError('booking needs a valid start time, duration and optional short title', 400);
    }
    const entryType = input.entryType === 'reservation' ? 'reservation' : 'planned';
    return {
      startMs: Date.parse(input.startsAt),
      durationMinutes: input.durationMinutes,
      title: typeof input.title === 'string' ? input.title.trim() : '',
      entryType,
    };
  }

  private parseTrainingPlan(input: unknown, id: string): TrainingPlanRecord {
    if (!isRecord(input) || typeof input.name !== 'string' || input.name.trim().length < 1 || input.name.length > 80 ||
        (input.notes !== undefined && (typeof input.notes !== 'string' || input.notes.length > 500)) ||
        !Array.isArray(input.exercises) || input.exercises.length < 1 || input.exercises.length > 30) {
      throw new GymDomainError('training plan needs a name and at least one exercise', 400);
    }
    const exercises = input.exercises.map((exercise) => {
      if (!isRecord(exercise) || typeof exercise.name !== 'string' || exercise.name.trim().length < 1 || exercise.name.length > 80) {
        throw new GymDomainError('training plan exercises need a name', 400);
      }
      const targetSets = exercise.targetSets === undefined ? undefined : Number(exercise.targetSets);
      const targetReps = exercise.targetReps === undefined ? undefined : Number(exercise.targetReps);
      const targetWeightKg = exercise.targetWeightKg === undefined ? undefined : Number(exercise.targetWeightKg);
      if (targetSets !== undefined && (!Number.isInteger(targetSets) || targetSets < 1 || targetSets > 20)) {
        throw new GymDomainError('training plan sets must be between 1 and 20', 400);
      }
      if (targetReps !== undefined && (!Number.isInteger(targetReps) || targetReps < 1 || targetReps > 100)) {
        throw new GymDomainError('training plan repetitions must be between 1 and 100', 400);
      }
      if (targetWeightKg !== undefined && (!Number.isFinite(targetWeightKg) || targetWeightKg < 0 || targetWeightKg > 500)) {
        throw new GymDomainError('training plan weights must be between 0 and 500', 400);
      }
      return { name: exercise.name.trim(), targetSets, targetReps, targetWeightKg };
    });
    return { id, name: input.name.trim(), notes: typeof input.notes === 'string' ? input.notes.trim() : '', exercises };
  }
}
