import { randomUUID } from 'node:crypto';
import { getFirestore } from 'firebase-admin/firestore';
import { getFirebaseAdminApp } from './firebaseAuth.ts';
import type { CommunityConversationWrite, PartnerNotificationWrite } from './gym-app-api.ts';

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
