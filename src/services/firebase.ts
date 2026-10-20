import {
  connectFirestoreEmulator,
  getFirestore,
  doc,
  getDocFromServer,
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
  setDoc,
  updateDoc,
  deleteDoc,
  getDocs,
  getDoc,
  serverTimestamp,
} from 'firebase/firestore';
import { auth } from './firebaseAuth';
import {
  firebaseApp,
  firebaseFirestoreDatabaseId,
  firebaseFirestoreEmulatorHost,
} from './firebaseApp';
export { getCurrentFirebaseUser, logoutFirebase, subscribeToAuth } from './firebaseAuth';

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

// CRITICAL: Specifying the custom firestoreDatabaseId from configuration
export const db = getFirestore(firebaseApp, firebaseFirestoreDatabaseId);
if (firebaseFirestoreEmulatorHost) {
  const [host, portValue] = firebaseFirestoreEmulatorHost.split(':');
  const port = Number(portValue);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('VITE_FIREBASE_FIRESTORE_EMULATOR_HOST must be a host:port pair');
  }
  connectFirestoreEmulator(db, host, port);
}
export { auth };

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((p) => ({
          providerId: p.providerId,
          email: p.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// Test connectivity on initial boot as required by skill guidelines
async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.warn('Firebase client is offline. Cloud features may wait for network.');
    }
  }
}
void testConnection();
