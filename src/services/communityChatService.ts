import {
  doc,
  setDoc,
  updateDoc,
  type Unsubscribe,
} from 'firebase/firestore';
import { auth, db, handleFirestoreError, OperationType } from './firebase';
import type { CommunityMember, CommunityProfile } from './gymRepository';

export interface MatchRecommendation {
  member: CommunityMember;
  score: number; // 0 - 100%
  reasons: string[];
  sharedGoals: string[];
  sharedTimes: string[];
  sameStudy: boolean;
}

export interface CloudConversation {
  id: string;
  participantIds: string[];
  participantNames: Record<string, string>;
  lastMessageText?: string;
  lastMessageAt?: string;
  lastSenderId?: string;
  createdAt: string;
}

export interface CloudChatMessage {
  id: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  text: string;
  createdAt: string;
}

export interface CloudNotification {
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

/**
 * Calculates a match score (0-100%) and matching reasons between two profiles.
 */
export function calculateMatch(
  me: CommunityProfile | null,
  other: CommunityMember,
): MatchRecommendation {
  const reasons: string[] = [];
  const sharedGoals: string[] = [];
  const sharedTimes: string[] = [];

  if (!me) {
    return {
      member: other,
      score: 50,
      reasons: ['Vervollständige dein Profil für genaue Empfehlungen'],
      sharedGoals: [],
      sharedTimes: [],
      sameStudy: false,
    };
  }

  let score = 20; // Base score for fellow DHBW student

  // 1. Shared Training Goals (up to 45 pts)
  const myGoals = me.trainingGoals || [];
  const otherGoals = other.trainingGoals || [];
  for (const g of myGoals) {
    if (otherGoals.some((og) => og.toLowerCase() === g.toLowerCase())) {
      sharedGoals.push(g);
    }
  }
  if (sharedGoals.length > 0) {
    const goalPoints = Math.min(45, sharedGoals.length * 20);
    score += goalPoints;
    reasons.push(`Gemeinsame Ziele: ${sharedGoals.join(', ')}`);
  }

  // 2. Shared Preferred Workout Times (up to 25 pts)
  const myTimes = me.preferredTimes || [];
  const otherTimes = other.preferredTimes || [];
  for (const t of myTimes) {
    if (otherTimes.some((ot) => ot.toLowerCase() === t.toLowerCase())) {
      sharedTimes.push(t);
    }
  }
  if (sharedTimes.length > 0) {
    score += 25;
    reasons.push(`Gleiches Zeitfenster: ${sharedTimes.join(', ')}`);
  }

  // 3. Course of study (10 pts)
  const sameStudy =
    Boolean(me.courseOfStudy && other.courseOfStudy) &&
    me.courseOfStudy.trim().toLowerCase() === other.courseOfStudy.trim().toLowerCase();
  if (sameStudy) {
    score += 10;
    reasons.push(`Gleicher Studiengang: ${other.courseOfStudy}`);
  }

  // 4. Live presence or active gym status (up to 10 pts)
  if (other.activeNow) {
    score += 10;
    reasons.push('Gerade live im Gym anwesend!');
  } else if (other.plannedNext) {
    score += 5;
    reasons.push('Hat bereits geplante Sessions');
  }

  const finalScore = Math.min(100, Math.max(30, score));

  if (reasons.length === 0) {
    reasons.push('Gemeinsamer DHBW Campus Bad Mergentheim');
  }

  return {
    member: other,
    score: finalScore,
    reasons,
    sharedGoals,
    sharedTimes,
    sameStudy,
  };
}

/**
 * Get sorted recommendations for current user
 */
export function getMatchRecommendations(
  myProfile: CommunityProfile | null,
  members: CommunityMember[],
): MatchRecommendation[] {
  return members
    .filter((m) => !m.isSelf)
    .map((m) => calculateMatch(myProfile, m))
    .sort((a, b) => b.score - a.score);
}

/**
 * Firestore Conversations & Real-Time Chat
 */
function startCommunityApiPolling<T>(
  endpoint: string,
  firebaseUid: string,
  firestorePath: string,
  resultKey: string,
  onUpdate: (items: T[]) => void,
): Unsubscribe {
  let active = true;
  let requestInFlight = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const refresh = async (): Promise<void> => {
    const user = auth.currentUser;
    if (!active || !user || user.uid !== firebaseUid) {
      active = false;
      if (timer !== undefined) clearTimeout(timer);
      return;
    }
    if (requestInFlight) return;
    requestInFlight = true;
    try {
      const token = await user.getIdToken();
      if (!active || auth.currentUser?.uid !== firebaseUid) return;
      const response = await fetch(endpoint, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
        cache: 'no-store',
      });
      if (!response.ok) {
        throw new Error(`Community API request failed with status ${response.status}`);
      }
      const payload: unknown = await response.json();
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload) ||
          !(resultKey in payload) || !Array.isArray((payload as Record<string, unknown>)[resultKey])) {
        throw new Error('Community API returned an invalid response');
      }
      if (active && auth.currentUser?.uid === firebaseUid) {
        onUpdate((payload as Record<string, unknown>)[resultKey] as T[]);
      }
    } catch (error) {
      if (active) {
        console.error('[Community API]', {
          path: firestorePath,
          error: error instanceof Error ? error.message : 'unknown error',
        });
      }
    } finally {
      requestInFlight = false;
      if (active && auth.currentUser?.uid === firebaseUid) {
        timer = setTimeout(() => void refresh(), 5_000);
      } else {
        active = false;
      }
    }
  };

  void refresh();
  return () => {
    active = false;
    if (timer !== undefined) clearTimeout(timer);
  };
}

/**
 * Community lists are served by the authenticated API. Polling preserves the existing
 * subscription interface while preventing Firestore list queries from exposing raw documents.
 */
export function subscribeToConversations(
  userId: string,
  onUpdate: (conversations: CloudConversation[]) => void,
): Unsubscribe {
  if (!auth.currentUser || !userId || auth.currentUser.uid !== userId) return () => {};
  return startCommunityApiPolling<CloudConversation>(
    '/api/gym/community/conversations',
    userId,
    'conversations',
    'conversations',
    (conversations) => {
      conversations.sort((a, b) => (b.lastMessageAt || b.createdAt || '').localeCompare(a.lastMessageAt || a.createdAt || ''));
      onUpdate(conversations);
    },
  );
}

export function subscribeToMessages(
  conversationId: string,
  onUpdate: (messages: CloudChatMessage[]) => void,
): Unsubscribe {
  const user = auth.currentUser;
  if (!user || !conversationId) return () => {};
  return startCommunityApiPolling<CloudChatMessage>(
    `/api/gym/community/conversations/${encodeURIComponent(conversationId)}/messages`,
    user.uid,
    `conversations/${conversationId}/messages`,
    'messages',
    (messages) => {
      messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      onUpdate(messages);
    },
  );
}

export async function sendChatMessage(
  conversationId: string,
  senderId: string,
  senderName: string,
  text: string,
  otherUserId?: string,
): Promise<CloudChatMessage> {
  const msgId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const now = new Date().toISOString();
  const path = `conversations/${conversationId}/messages/${msgId}`;

  const messageDoc: CloudChatMessage = {
    id: msgId,
    conversationId,
    senderId,
    senderName,
    text: text.trim(),
    createdAt: now,
  };

  try {
    // The message write is the critical path. Return as soon as it is stored so
    // quick replies do not wait for conversation-preview and notification writes.
    await setDoc(doc(db, 'conversations', conversationId, 'messages', msgId), messageDoc);
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
    throw err;
  }

  // These writes are secondary: keep the send action responsive while updating
  // the conversation preview and delivering a notification in the background.
  void updateDoc(doc(db, 'conversations', conversationId), {
    lastMessageText: text.trim().slice(0, 100),
    lastMessageAt: now,
    lastSenderId: senderId,
  }).catch((err: unknown) => {
    console.error('[Community chat] Conversation preview update failed', err);
  });

  if (otherUserId && otherUserId !== senderId) {
    void sendNotification(otherUserId, {
      type: 'new_message',
      title: `Neue Nachricht von ${senderName}`,
      message: text.trim().slice(0, 100),
      linkUrl: `/chat/${conversationId}`,
      resourceId: conversationId,
      eventId: msgId,
    }).catch((err: unknown) => {
      console.error('[Community chat] Message notification failed', err);
    });
  }

  return messageDoc;
}

/**
 * Firestore Real-Time Notifications & Slot Reminders
 */
export function subscribeToNotifications(
  userId: string,
  onUpdate: (notifications: CloudNotification[]) => void,
): Unsubscribe {
  if (!auth.currentUser || !userId || auth.currentUser.uid !== userId) return () => {};
  return startCommunityApiPolling<CloudNotification>(
    '/api/gym/community/notifications',
    userId,
    `users/${userId}/notifications`,
    'notifications',
    (notifications) => {
      notifications.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      onUpdate(notifications);
    },
  );
}

export async function sendNotification(
  userId: string,
  notification: Omit<CloudNotification, 'id' | 'userId' | 'senderId' | 'read' | 'createdAt'>,
): Promise<void> {
  const senderId = auth.currentUser?.uid;
  if (!senderId) throw new Error('Firebase user must be signed in to send a notification');
  // Message notifications use the message ID so the same message cannot create duplicate notifications.
  const notifId = notification.type === 'new_message' && notification.eventId
    ? notification.eventId
    : `notif_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  const path = `users/${userId}/notifications/${notifId}`;

  const payload: CloudNotification = {
    id: notifId,
    userId,
    senderId,
    type: notification.type,
    title: notification.title,
    message: notification.message,
    read: false,
    linkUrl: notification.linkUrl,
    resourceId: notification.resourceId,
    eventId: notification.eventId,
    createdAt: now,
  };

  try {
    await setDoc(doc(db, 'users', userId, 'notifications', notifId), payload);
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export async function markNotificationAsRead(userId: string, notificationId: string): Promise<void> {
  const path = `users/${userId}/notifications/${notificationId}`;
  try {
    await updateDoc(doc(db, 'users', userId, 'notifications', notificationId), {
      read: true,
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function markAllNotificationsAsRead(userId: string, notifications: CloudNotification[]): Promise<void> {
  const unread = notifications.filter((n) => !n.read);
  await Promise.all(
    unread.map((n) => markNotificationAsRead(userId, n.id).catch(() => undefined)),
  );
}
