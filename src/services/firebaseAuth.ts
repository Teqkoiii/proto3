import {
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  sendEmailVerification,
  signInWithEmailAndPassword,
  signOut,
  type Auth,
  type User,
} from 'firebase/auth';
import {
  firebaseApp,
  firebaseAuthEmulatorHost,
} from './firebaseApp';

export const auth = getAuth(firebaseApp);
if (firebaseAuthEmulatorHost) {
  connectAuthEmulator(auth, `http://${firebaseAuthEmulatorHost}`, { disableWarnings: true });
}

export function createFirebaseAuthClient(clientAuth: Auth) {
  let verificationEmailResendInProgress = false;

  return {
    subscribeToAuth(onUserChanged: (user: User | null) => void) {
      return onAuthStateChanged(clientAuth, (user) => {
        if (verificationEmailResendInProgress && user) return;
        onUserChanged(user);
      });
    },

    async getCurrentFirebaseUser(): Promise<User | null> {
      if (clientAuth.currentUser) return clientAuth.currentUser;
      return new Promise((resolve) => {
        const unsubscribe = onAuthStateChanged(clientAuth, (user) => {
          unsubscribe();
          resolve(user);
        });
      });
    },

    async getFirebaseIdToken(): Promise<string | undefined> {
      if (verificationEmailResendInProgress) return undefined;
      const user = clientAuth.currentUser;
      if (!user?.emailVerified) return undefined;
      return user.getIdToken();
    },

    async registerWithEmailAndPassword(email: string, password: string): Promise<void> {
      const credential = await createUserWithEmailAndPassword(clientAuth, email, password);
      try {
        await sendEmailVerification(credential.user);
      } catch (error) {
        await signOut(clientAuth);
        throw error;
      }
      await signOut(clientAuth);
    },

    async resendVerificationEmail(email: string, password: string): Promise<void> {
      verificationEmailResendInProgress = true;
      let signedInForResend = false;
      try {
        const credential = await signInWithEmailAndPassword(clientAuth, email, password);
        signedInForResend = true;
        if (credential.user.emailVerified) {
          throw new Error('Diese E-Mail-Adresse ist bereits bestätigt.');
        }
        await sendEmailVerification(credential.user);
      } finally {
        try {
          if (signedInForResend) await signOut(clientAuth);
        } finally {
          verificationEmailResendInProgress = false;
        }
      }
    },
    async loginWithEmailAndPassword(email: string, password: string): Promise<User> {
      const credential = await signInWithEmailAndPassword(clientAuth, email, password);
      if (!credential.user.emailVerified) {
        await signOut(clientAuth);
        throw new Error('Bitte bestätige zuerst deine E-Mail-Adresse über den Link in deinem Postfach.');
      }
      return credential.user;
    },

    async logoutFirebase(): Promise<void> {
      await signOut(clientAuth);
    },
  };
}

const firebaseAuthClient = createFirebaseAuthClient(auth);
export const {
  subscribeToAuth,
  getCurrentFirebaseUser,
  getFirebaseIdToken,
  registerWithEmailAndPassword,
  resendVerificationEmail,
  loginWithEmailAndPassword,
  logoutFirebase,
} = firebaseAuthClient;
