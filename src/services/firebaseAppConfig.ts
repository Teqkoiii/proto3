export interface FirebaseTestWebConfig {
  apiKey?: string;
  appId?: string;
  authDomain?: string;
  messagingSenderId?: string;
}

export function hasFirebaseTestWebConfig(config: FirebaseTestWebConfig): boolean {
  return Boolean(config.apiKey || config.appId || config.authDomain || config.messagingSenderId);
}
