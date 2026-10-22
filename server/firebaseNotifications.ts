import { randomUUID } from 'node:crypto';
import { getFirestore } from 'firebase-admin/firestore';
import { getFirebaseAdminApp } from './firebaseAuth.ts';
import type {
  CommunityChatMessageDto,
  CommunityConversationDto,
  CommunityConversationWrite,
  CommunityNotificationDto,
  PartnerNotificationWrite,
} from './gym-app-api.ts';

export async function writeCommunityConversation(conversation: CommunityConversationWrite): Promise<void> {
  const firestore = getFirestore(getFirebaseAdminApp());
  const reference = firestore.collection('conversations').doc(conversation.id);

  await firestore.runTransaction(async (transaction) => {
    const existing = await transaction.get(reference);
    if (existing.exists) {
      const participantIds = existing.get('participantIds');
      if (
        !Array.isArray(participantIds) ||
        participantIds.length !== conversation.participantIds.length ||
        !conversation.participantIds.every((uid) => participantIds.includes(uid))
      ) {
        throw new Error('Existing conversation has inconsistent participants');
      }
      return;
    }

    transaction.create(reference, conversation);
  });
}

export async function writePartnerNotification(notification: PartnerNotificationWrite): Promise<void> {
  const id = randomUUID();
  await getFirestore(getFirebaseAdminApp())
    .collection('users')
    .doc(notification.recipientUid)
    .collection('notifications')
    .doc(id)
    .create({
      id,
      userId: notification.recipientUid,
      senderId: notification.senderUid,
      type: notification.type,
      title: notification.title,
      message: notification.message,
      read: false,
      linkUrl: '/community',
      resourceId: notification.resourceId,
      createdAt: notification.createdAt,
    });
}


const ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
const TIMESTAMP_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$/;
const NOTIFICATION_TYPES = new Set([
  'partner_request',
  'partner_accepted',
  'new_message',
  'slot_reminder',
  'gym_alert',
]);
const CONVERSATION_KEYS = new Set([
  'id', 'participantIds', 'participantNames', 'createdAt',
  'lastMessageText', 'lastMessageAt', 'lastSenderId',
]);
const MESSAGE_KEYS = new Set([
  'id', 'conversationId', 'senderId', 'senderName', 'text', 'createdAt',
]);
const NOTIFICATION_KEYS = new Set([
  'id', 'userId', 'senderId', 'type', 'title', 'message', 'read',
  'linkUrl', 'resourceId', 'eventId', 'createdAt',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(data: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(data).every((key) => allowed.has(key));
}

function isValidId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function isValidTimestamp(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length <= 40 &&
    TIMESTAMP_PATTERN.test(value) &&
    Number.isFinite(Date.parse(value));
}

function isBoundedString(value: unknown, maxLength: number, allowEmpty = true): value is string {
  return typeof value === 'string' &&
    value.length <= maxLength &&
    (allowEmpty || value.length > 0);
}

function toSafeConversation(
  documentId: string,
  value: unknown,
  requestedUid: string,
): CommunityConversationDto | null {
  if (!isRecord(value) || !hasOnlyKeys(value, CONVERSATION_KEYS)) return null;
  if (value.id !== documentId || !isValidId(value.id)) return null;
  if (!Array.isArray(value.participantIds) || value.participantIds.length !== 2 ||
      !value.participantIds.every(isValidId) ||
      value.participantIds[0] === value.participantIds[1] ||
      !value.participantIds.includes(requestedUid)) return null;

  let participantNames: Record<string, string> = {};
  if ('participantNames' in value) {
    if (!isRecord(value.participantNames)) return null;
    const nameKeys = Object.keys(value.participantNames);
    if (nameKeys.length !== 2 || !value.participantIds.every((uid) => nameKeys.includes(uid)) ||
        !nameKeys.every((uid) => value.participantIds.includes(uid) &&
          isBoundedString(value.participantNames?.[uid], 60))) return null;
    participantNames = {
      [value.participantIds[0] as string]: value.participantNames[value.participantIds[0] as string] as string,
      [value.participantIds[1] as string]: value.participantNames[value.participantIds[1] as string] as string,
    };
  }
  if ('createdAt' in value && !isValidTimestamp(value.createdAt)) return null;
  if ('lastMessageText' in value && !isBoundedString(value.lastMessageText, 500)) return null;
  if ('lastMessageAt' in value && !isValidTimestamp(value.lastMessageAt)) return null;
  if ('lastSenderId' in value &&
      (typeof value.lastSenderId !== 'string' || !value.participantIds.includes(value.lastSenderId))) return null;

  return {
    id: documentId,
    participantIds: [...value.participantIds] as string[],
    participantNames,
    createdAt: isValidTimestamp(value.createdAt) ? value.createdAt : '',
    ...(typeof value.lastMessageText === 'string' ? { lastMessageText: value.lastMessageText } : {}),
    ...(typeof value.lastMessageAt === 'string' ? { lastMessageAt: value.lastMessageAt } : {}),
    ...(typeof value.lastSenderId === 'string' ? { lastSenderId: value.lastSenderId } : {}),
  };
}

function toSafeMessage(
  documentId: string,
  value: unknown,
  conversationId: string,
  participantIds: string[],
): CommunityChatMessageDto | null {
  if (!isRecord(value) || !hasOnlyKeys(value, MESSAGE_KEYS)) return null;
  if (value.id !== documentId || !isValidId(value.id) ||
      value.conversationId !== conversationId ||
      typeof value.senderId !== 'string' ||
      !participantIds.includes(value.senderId) ||
      !isBoundedString(value.text, 1000, false)) return null;
  if ('senderName' in value && !isBoundedString(value.senderName, 60)) return null;
  if ('createdAt' in value && !isValidTimestamp(value.createdAt)) return null;

  return {
    id: documentId,
    conversationId,
    senderId: value.senderId,
    senderName: typeof value.senderName === 'string' ? value.senderName : '',
    text: value.text,
    createdAt: isValidTimestamp(value.createdAt) ? value.createdAt : '',
  };
}

function toSafeNotification(
  documentId: string,
  value: unknown,
  requestedUid: string,
): CommunityNotificationDto | null {
  if (!isRecord(value) || !hasOnlyKeys(value, NOTIFICATION_KEYS)) return null;
  if (value.id !== documentId || !isValidId(value.id) ||
      value.userId !== requestedUid ||
      typeof value.senderId !== 'string' || !isValidId(value.senderId) ||
      typeof value.type !== 'string' || !NOTIFICATION_TYPES.has(value.type) ||
      !isBoundedString(value.title, 120) ||
      !isBoundedString(value.message, 300) ||
      typeof value.read !== 'boolean') return null;
  if ('linkUrl' in value &&
      (typeof value.linkUrl !== 'string' || value.linkUrl.length > 500 ||
       !/^\\/([a-zA-Z0-9_?=&-][a-zA-Z0-9_/?=&-]*)?$/.test(value.linkUrl))) return null;
  if ('resourceId' in value && !isValidId(value.resourceId)) return null;
  if ('eventId' in value && !isValidId(value.eventId)) return null;
  if ('createdAt' in value && !isValidTimestamp(value.createdAt)) return null;

  return {
    id: documentId,
    userId: requestedUid,
    senderId: value.senderId,
    type: value.type as CommunityNotificationDto['type'],
    title: value.title,
    message: value.message,
    read: value.read,
    ...(typeof value.linkUrl === 'string' ? { linkUrl: value.linkUrl } : {}),
    ...(typeof value.resourceId === 'string' ? { resourceId: value.resourceId } : {}),
    ...(typeof value.eventId === 'string' ? { eventId: value.eventId } : {}),
    createdAt: isValidTimestamp(value.createdAt) ? value.createdAt : '',
  };
}

export async function readCommunityConversations(userUid: string): Promise<CommunityConversationDto[]> {
  if (!isValidId(userUid)) return [];
  const firestore = getFirestore(getFirebaseAdminApp());
  const snapshot = await firestore.collection('conversations')
    .where('participantIds', 'array-contains', userUid)
    .get();

  return snapshot.docs
    .map((document) => toSafeConversation(document.id, document.data(), userUid))
    .filter((conversation): conversation is CommunityConversationDto => conversation !== null)
    .sort((a, b) => (b.lastMessageAt || b.createdAt).localeCompare(a.lastMessageAt || a.createdAt));
}

export async function readCommunityMessages(
  userUid: string,
  conversationId: string,
): Promise<CommunityChatMessageDto[] | null> {
  if (!isValidId(userUid) || !isValidId(conversationId)) return null;
  const firestore = getFirestore(getFirebaseAdminApp());
  const conversationSnapshot = await firestore.collection('conversations').doc(conversationId).get();
  if (!conversationSnapshot.exists) return null;
  const conversation = toSafeConversation(conversationSnapshot.id, conversationSnapshot.data(), userUid);
  if (!conversation) return null;

  const snapshot = await firestore.collection('conversations').doc(conversationId)
    .collection('messages').get();
  return snapshot.docs
    .map((document) => toSafeMessage(document.id, document.data(), conversationId, conversation.participantIds))
    .filter((message): message is CommunityChatMessageDto => message !== null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function readCommunityNotifications(userUid: string): Promise<CommunityNotificationDto[]> {
  if (!isValidId(userUid)) return [];
  const firestore = getFirestore(getFirebaseAdminApp());
  const snapshot = await firestore.collection('users').doc(userUid)
    .collection('notifications').get();

  return snapshot.docs
    .map((document) => toSafeNotification(document.id, document.data(), userUid))
    .filter((notification): notification is CommunityNotificationDto => notification !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
