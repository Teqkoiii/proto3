import express, { type NextFunction, type Request, type Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { verifyFirebaseIdToken, type VerifiedFirebaseIdentity } from './firebaseAuth.ts';
import { GymAppRepository } from './gymAppRepository.ts';
import { GymAppService, GymDomainError, isDhbwEmail } from './gymAppService.ts';

const COOKIE_NAME = 'gym_app_session';

export interface PartnerNotificationWrite {
  recipientUid: string;
  senderUid: string;
  type: 'partner_request' | 'partner_accepted';
  title: string;
  message: string;
  resourceId: string;
  createdAt: string;
}

export interface CommunityConversationWrite {
  id: string;
  participantIds: string[];
  participantNames: Record<string, string>;
  createdAt: string;
}

export interface CommunityConversationDto {
  id: string;
  participantIds: string[];
  participantNames: Record<string, string>;
  createdAt: string;
  lastMessageText?: string;
  lastMessageAt?: string;
  lastSenderId?: string;
}

export interface CommunityChatMessageDto {
  id: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  text: string;
  createdAt: string;
}

export interface CommunityNotificationDto {
  id: string;
  userId: string;
  senderId: string;
  type: 'partner_request' | 'partner_accepted' | 'new_message' | 'slot_reminder' | 'gym_alert';
  title: string;
  message: string;
  read: boolean;
  linkUrl?: string;
  resourceId?: string;
  eventId?: string;
  createdAt: string;
}

export type PartnerNotificationStatus = 'sent' | 'unavailable' | 'failed';

interface GymApiOptions {
  secureCookies?: boolean;
  allowedOrigins?: string[];
  maxCheckInHours?: number;
  now?: () => number;
  firebaseTokenVerifier?: (token: string) => Promise<VerifiedFirebaseIdentity>;
  partnerNotificationWriter?: (notification: PartnerNotificationWrite) => Promise<void>;
  communityConversationWriter?: (conversation: CommunityConversationWrite) => Promise<void>;
  communityConversationReader?: (userUid: string) => Promise<CommunityConversationDto[]>;
  communityMessageReader?: (userUid: string, conversationId: string) => Promise<CommunityChatMessageDto[] | null>;
  communityNotificationReader?: (userUid: string) => Promise<CommunityNotificationDto[]>;
}

interface GymSessionRequest extends Request {
  principalId?: string;
  firebaseIdentity?: VerifiedFirebaseIdentity;
}

function getCookie(request: Request, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    return /^[a-f0-9]{64}$/.test(value) ? value : undefined;
  }
  return undefined;
}

function clearLegacySessionCookie(response: Response, secure: boolean, crossOriginCookies: boolean): void {
  const sameSite = crossOriginCookies ? 'None' : 'Strict';
  response.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=${sameSite}; Path=/; Max-Age=0${secure ? '; Secure' : ''}`);
}

function asyncRoute(handler: (request: GymSessionRequest, response: Response) => Promise<void>) {
  return (request: GymSessionRequest, response: Response, next: NextFunction) => {
    handler(request, response).catch(next);
  };
}

function asyncMiddleware(handler: (request: GymSessionRequest, response: Response, next: NextFunction) => Promise<void>) {
  return (request: GymSessionRequest, response: Response, next: NextFunction) => {
    handler(request, response, next).catch(next);
  };
}

export function createGymAppApi(database: DatabaseSync, options: GymApiOptions = {}) {
  const secureCookies = options.secureCookies ?? false;
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const crossOriginCookies = allowedOrigins.size > 0;
  if (crossOriginCookies && !secureCookies) throw new Error('Cross-origin app cookies require secureCookies');
  const service = new GymAppService(new GymAppRepository(database), {
    maxCheckInHours: options.maxCheckInHours ?? 8,
    now: options.now,
  });
  const verifyToken = options.firebaseTokenVerifier ?? verifyFirebaseIdToken;
  const deliverPartnerNotification = async (
    actorPrincipalId: string,
    actorUid: string,
    recipientPrincipalId: string,
    notification: Omit<PartnerNotificationWrite, 'recipientUid' | 'senderUid' | 'createdAt'>,
  ): Promise<PartnerNotificationStatus> => {
    const senderUid = service.getFirebaseUidForPrincipal(actorPrincipalId);
    const recipientUid = service.getFirebaseUidForPrincipal(recipientPrincipalId);
    if (!options.partnerNotificationWriter || !recipientUid) return 'unavailable';
    if (!senderUid || senderUid !== actorUid) {
      console.error('[Community notification] Partner notification sender mapping is inconsistent');
      return 'failed';
    }
    try {
      await options.partnerNotificationWriter({
        ...notification,
        recipientUid,
        senderUid,
        createdAt: new Date(options.now?.() ?? Date.now()).toISOString(),
      });
      return 'sent';
    } catch (error) {
      console.error('[Community notification] Partner notification delivery failed', {
        type: notification.type,
        errorType: error instanceof Error ? error.name : 'unknown',
      });
      return 'failed';
    }
  };

  const sampleOccupancy = () => {
    try {
      service.getOccupancy('60m');
    } catch (error) {
      console.error(
        '[Occupancy-Sampling]',
        error instanceof Error ? error.message : error,
      );
    }
  };

  sampleOccupancy();
  const occupancySamplingTimer = setInterval(sampleOccupancy, 30_000);
  occupancySamplingTimer.unref();

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '12kb', type: 'application/json' }));
  app.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  app.use((request, response, next) => {
    const origin = request.get('Origin');
    // Compare the complete origin, including scheme and host. X-Forwarded-Host
    // is not trusted because a client may supply it when proxy stripping is unknown.
    const effectiveHost = request.get('host')?.toLowerCase();
    const expectedProtocol = secureCookies ? 'https:' : 'http:';
    let sameOrigin = false;
    if (origin) {
      try {
        const parsedOrigin = new URL(origin);
        sameOrigin = parsedOrigin.protocol === expectedProtocol &&
          parsedOrigin.host.toLowerCase() === effectiveHost;
      } catch {
        sameOrigin = false;
      }
    }
    const allowed = !origin || sameOrigin || allowedOrigins.has(origin);
    if (!allowed) {
      response.status(403).json({ error: 'origin is not allowed' });
      return;
    }
    if (origin && !sameOrigin && allowedOrigins.has(origin)) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Access-Control-Allow-Credentials', 'true');
      response.setHeader('Vary', 'Origin');
    }
    if (request.method === 'OPTIONS') {
      if (!origin || (sameOrigin || allowedOrigins.has(origin))) {
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        response.status(204).end();
      } else {
        response.status(403).end();
      }
      return;
    }
    next();
  });

  const getVerifiedIdentity = async (request: GymSessionRequest, response: Response): Promise<VerifiedFirebaseIdentity | undefined> => {
    const authorization = request.get('Authorization');
    const match = authorization?.match(/^Bearer ([^\s]+)$/i);
    if (!match) {
      response.status(401).json({ error: 'Firebase bearer token required' });
      return undefined;
    }

    let identity: VerifiedFirebaseIdentity;
    try {
      identity = await verifyToken(match[1] ?? '');
    } catch {
      response.status(401).json({ error: 'Firebase bearer token is invalid or revoked' });
      return undefined;
    }
    if (!identity || typeof identity.uid !== 'string' || identity.uid.trim().length === 0 ||
        identity.uid.length > 255 || typeof identity.emailVerified !== 'boolean' ||
        (identity.email !== null && typeof identity.email !== 'string')) {
      response.status(401).json({ error: 'Firebase identity is invalid' });
      return undefined;
    }
    if (!identity.emailVerified) {
      response.status(403).json({ error: 'verified DHBW email address required' });
      return undefined;
    }
    if (!identity.email || !isDhbwEmail(identity.email)) {
      response.status(403).json({ error: 'DHBW email address required' });
      return undefined;
    }

    return identity;
  };

  const requireFirebaseIdentity = asyncMiddleware(async (request, response, next) => {
    const identity = await getVerifiedIdentity(request, response);
    if (!identity) return;
    request.firebaseIdentity = identity;
    next();
  });

  const requireSession = asyncMiddleware(async (request, response, next) => {
    const identity = request.firebaseIdentity ?? await getVerifiedIdentity(request, response);
    if (!identity) return;
    request.firebaseIdentity = identity;
    request.principalId = await service.resolveFirebasePrincipal(identity);
    next();
  });

  app.post('/api/gym/auth/link', requireFirebaseIdentity, asyncRoute(async (request, response) => {
    const identity = request.firebaseIdentity;
    if (!identity) {
      response.status(401).json({ error: 'Firebase bearer token required' });
      return;
    }
    const body = typeof request.body === 'object' && request.body !== null
      ? request.body as Record<string, unknown>
      : {};
    const legacySessionToken = getCookie(request, COOKIE_NAME);
    const legacySessionPrincipal = legacySessionToken
      ? service.resolvePrincipal(legacySessionToken)
      : undefined;
    const principalId = await service.resolveFirebasePrincipal(
      identity,
      legacySessionToken,
      body.legacyPassword,
    );
    service.retireLegacySessions(principalId);
    if (legacySessionToken && legacySessionPrincipal === principalId && !service.resolvePrincipal(legacySessionToken)) {
      clearLegacySessionCookie(response, secureCookies, crossOriginCookies);
    }
    response.json(service.getSession(principalId, identity.email));
  }));

  app.get('/api/gym/session', requireFirebaseIdentity, requireSession, (request: GymSessionRequest, response) => {
    response.json(service.getSession(request.principalId!, request.firebaseIdentity?.email));
  });

  app.post(['/api/gym/register', '/api/gym/login'], (_request, response) => {
    response.status(410).json({ error: 'use Firebase Authentication' });
  });

  app.post('/api/gym/logout', requireSession, (request: GymSessionRequest, response) => {
    const legacySessionToken = getCookie(request, COOKIE_NAME);
    if (legacySessionToken && service.consumeLegacySession(legacySessionToken, request.principalId!)) {
      clearLegacySessionCookie(response, secureCookies, crossOriginCookies);
    }
    response.status(204).end();
  });

  app.get('/api/gym/occupancy', (request, response) => response.json(service.getOccupancy(request.query.range, { cleanup: false, recordSample: false })));

  app.post('/api/gym/check-in', requireSession, (request: GymSessionRequest, response) => {
    response.json(service.checkIn(request.principalId!));
  });

  app.post('/api/gym/check-out', requireSession, (request: GymSessionRequest, response) => {
    response.json(service.checkOut(request.principalId!));
  });

  app.get('/api/gym/availability', (request, response) => {
    response.json(service.getAvailability(request.query.startAt, Number(request.query.durationMinutes)));
  });

  app.get('/api/gym/bookings', (request, response) => {
    response.json(service.listBookingSlots(request.query.from, request.query.to, { cleanup: false }));
  });

  app.get('/api/gym/calendar/events', requireSession, (request: GymSessionRequest, response) => {
    response.json(service.getCalendarEvents(request.principalId!, request.query.from, request.query.to));
  });

  app.get('/api/gym/profile/community', requireSession, (request: GymSessionRequest, response) => {
    response.json({ profile: service.getCommunityProfile(request.principalId!) });
  });

  app.put('/api/gym/profile/community', requireSession, (request: GymSessionRequest, response) => {
    response.json({ profile: service.updateCommunityProfile(request.principalId!, request.body) });
  });

  app.get('/api/gym/community/members', requireSession, (request: GymSessionRequest, response) => {
    response.json({ members: service.listCommunityMembers(request.principalId!) });
  });

  app.post('/api/gym/community/conversations', requireSession, asyncRoute(async (request, response) => {
    if (!options.communityConversationWriter) {
      throw new GymDomainError('community chat is unavailable', 503);
    }
    const conversation = service.getCommunityConversation(request.principalId!, request.body);
    const { otherParticipantUid, ...conversationWrite } = conversation;
    await options.communityConversationWriter(conversationWrite);
    response.json({
      conversationId: conversation.id,
      otherParticipantUid,
    });
  }));

  app.get('/api/gym/community/conversations', requireSession, asyncRoute(async (request, response) => {
    if (!options.communityConversationReader) {
      throw new GymDomainError('community chat is unavailable', 503);
    }
    const conversations = await options.communityConversationReader(request.firebaseIdentity!.uid);
    response.json({ conversations });
  }));

  app.get('/api/gym/community/conversations/:conversationId/messages', requireSession, asyncRoute(async (request, response) => {
    if (!options.communityMessageReader) {
      throw new GymDomainError('community chat is unavailable', 503);
    }
    const conversationId = request.params.conversationId ?? '';
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(conversationId)) {
      throw new GymDomainError('conversation not found', 404);
    }
    const messages = await options.communityMessageReader(request.firebaseIdentity!.uid, conversationId);
    if (messages === null) {
      throw new GymDomainError('conversation not found', 404);
    }
    response.json({ messages });
  }));

  app.get('/api/gym/community/notifications', requireSession, asyncRoute(async (request, response) => {
    if (!options.communityNotificationReader) {
      throw new GymDomainError('community notifications are unavailable', 503);
    }
    const notifications = await options.communityNotificationReader(request.firebaseIdentity!.uid);
    response.json({ notifications });
  }));

  app.get('/api/gym/community/partner-requests', requireSession, (request: GymSessionRequest, response) => {
    response.json({ requests: service.listPartnerRequests(request.principalId!) });
  });

  app.post('/api/gym/community/partner-requests', requireSession, asyncRoute(async (request, response) => {
    const principalId = request.principalId!;
    const firebaseUid = request.firebaseIdentity!.uid;
    const result = service.createPartnerRequest(principalId, request.body);
    const context = service.getPartnerRequestNotificationContext(principalId, result.id);
    const notificationStatus = await deliverPartnerNotification(
      principalId,
      firebaseUid,
      context.receiverId,
      {
        type: 'partner_request',
        title: 'Neue Partner-Anfrage!',
        message: `${context.senderName} möchte mit dir im DHBW Gym trainieren.`,
        resourceId: context.id,
      },
    );
    response.status(201).json({ ...result, notificationStatus });
  }));

  app.put('/api/gym/community/partner-requests/:id', requireSession, asyncRoute(async (request, response) => {
    const principalId = request.principalId!;
    const firebaseUid = request.firebaseIdentity!.uid;
    const result = service.updatePartnerRequestStatus(principalId, request.params.id ?? '', request.body);
    let notificationStatus: PartnerNotificationStatus = 'unavailable';
    if (result.status === 'accepted') {
      const context = service.getPartnerRequestNotificationContext(principalId, result.id);
      notificationStatus = await deliverPartnerNotification(
        principalId,
        firebaseUid,
        context.senderId,
        {
          type: 'partner_accepted',
          title: 'Partner-Anfrage angenommen!',
          message: `${context.receiverName} hat deine Anfrage angenommen. Schreib direkt eine Nachricht im Chat!`,
          resourceId: context.id,
        },
      );
    }
    response.json({ ...result, notificationStatus });
  }));

  app.get('/api/gym/my/bookings', requireSession, (request: GymSessionRequest, response) => {
    response.json({ bookings: service.listMyBookings(request.principalId!) });
  });

  app.post('/api/gym/bookings', requireSession, (request: GymSessionRequest, response) => {
    const result = service.createBooking(request.principalId!, request.body);
    response.status(201).json({ booking: result.booking, ...result.availability });
  });

  app.put('/api/gym/my/bookings/:id', requireSession, (request: GymSessionRequest, response) => {
    response.json({ booking: service.updateBooking(request.principalId!, request.params.id ?? '', request.body) });
  });

  app.delete('/api/gym/my/bookings/:id', requireSession, (request: GymSessionRequest, response) => {
    service.cancelBooking(request.principalId!, request.params.id ?? '');
    response.status(204).end();
  });

  app.get('/api/gym/visits', requireSession, (request: GymSessionRequest, response) => {
    response.json(service.listVisits(request.principalId!, request.query.from, request.query.to));
  });

  app.get('/api/gym/workouts', requireSession, (request: GymSessionRequest, response) => {
    response.json(service.listWorkouts(request.principalId!));
  });

  app.post('/api/gym/workouts', requireSession, (request: GymSessionRequest, response) => {
    response.status(201).json(service.createWorkout(request.principalId!, request.body));
  });

  app.delete('/api/gym/workouts/:id', requireSession, (request: GymSessionRequest, response) => {
    service.deleteWorkout(request.principalId!, request.params.id ?? '');
    response.status(204).end();
  });

  app.get('/api/gym/plans', requireSession, (request: GymSessionRequest, response) => {
    response.json(service.listTrainingPlans(request.principalId!));
  });

  app.post('/api/gym/plans', requireSession, (request: GymSessionRequest, response) => {
    response.status(201).json(service.createTrainingPlan(request.principalId!, request.body));
  });

  app.put('/api/gym/plans/:id', requireSession, (request: GymSessionRequest, response) => {
    service.updateTrainingPlan(request.principalId!, request.params.id ?? '', request.body);
    response.status(204).end();
  });

  app.delete('/api/gym/plans/:id', requireSession, (request: GymSessionRequest, response) => {
    service.deleteTrainingPlan(request.principalId!, request.params.id ?? '');
    response.status(204).end();
  });

  app.get('/api/gym/goals', requireSession, (request: GymSessionRequest, response) => {
    response.json(service.getWeeklyGoal(request.principalId!));
  });

  app.put('/api/gym/goals', requireSession, (request: GymSessionRequest, response) => {
    response.json(service.setWeeklyGoal(request.principalId!, request.body));
  });

  app.post('/api/gym/profile/recover', requireFirebaseIdentity, requireSession, (_request, response) => {
    response.status(410).json({ error: 'recovery codes cannot be used to sign in; use Firebase Authentication' });
  });

  app.delete('/api/gym/my/data', requireSession, (request: GymSessionRequest, response) => {
    service.deletePersonalData(request.principalId!);
    response.status(204).end();
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof GymDomainError) {
      response.status(error.status).json({ error: error.message });
      return;
    }
    if (error instanceof SyntaxError) {
      response.status(400).json({ error: 'invalid JSON body' });
      return;
    }
    response.status(500).json({ error: 'internal server error' });
  });

  return app;
}
