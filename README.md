# DHBW Gym Community

A community and training platform for DHBW Bad Mergentheim with workout planning, progress tracking, a weekly calendar, and community features.

## Requirements

- Node.js
- npm

## Run locally

```powershell
npm ci
npm run dev
```

## Checks

```powershell
npm run lint
npm test
npm run build
```

## Configuration

Required environment variables are documented in `.env.example`. Store real keys only in a local, untracked `.env` file. Never publish API keys, passwords, or other credentials.

## Isolated Firebase test setup

The emulator commands use the non-routable `demo-gym-auth-test` project ID. They do not deploy Firestore rules or contact a live Firebase project.

```powershell
npm.cmd run test:firebase
```

This starts the local Auth and Firestore emulators, runs the rules and Auth integration tests, and stops the emulators afterward. The Auth Emulator exposes verification action codes instead of sending real email. The test applies the code locally and verifies that unverified login is rejected. Google OAuth is not provided by the Auth Emulator; its client flow is tested with an injected sign-in stub, not a real Google account.

To run the app/API against the emulators:

```powershell
npm.cmd run test:api:isolated
```

The API binds only to `127.0.0.1:43127` and creates a fresh SQLite database under the operating system's temporary directory. The script forces the `demo-gym-auth-test` project and local Auth/Firestore emulator hosts, uses an empty isolated `.env`, removes Google/Firebase credential environment overrides in its child process, and avoids Application Default Credentials while using the Auth Emulator. It never opens `data/gym-app.sqlite3`. Keep this process running while exercising the app, then stop it with Ctrl+C. The temporary test database is retained for inspection; its path is printed at startup.

The emulator setup requires no Firebase Console project or credentials. For a later, separate live test project, manually:

1. Create a new Firebase project specifically for testing; do not reuse the production project or its database.
2. Register a web app in that project and configure the client Firebase settings from that app. Set the server's `FIREBASE_PROJECT_ID` to exactly the same project ID.
3. In Authentication, enable Email/Password and Google providers. Configure the verification-email template and the Google OAuth consent screen/provider before testing those live flows.
4. Add only the required local/test web origins to Authentication's authorized domains. Confirm the approved DHBW email-domain allowlist with the institution; Firebase authorized domains are not a substitute for the server and Firestore domain checks.
5. Provide server credentials only through the hosting platform's secret/identity mechanism or a protected local credential file outside the repository. Never put an Admin private key in `.env`, client configuration, or source control.
6. Point the API at a newly created, empty test SQLite database and verify the resolved path before starting the API. Do not copy production SQLite or Firestore data into the test environment.
7. Review `firestore.rules` and run the emulator tests before any separately approved rules deployment. No command in this repository deploys the rules.

### Local DHBW test project (not configured until you opt in)

The existing `firebase-applet-config.json` and `.env.example` still target the original Firebase project. Do not edit or replace them for testing. A separate, ignored `.env.dhbw-test.local` is used only by the explicit `npm.cmd run dev:dhbw-test` launcher. The launcher requires both project IDs to be exactly `dhbw-gym-test`, the Web App sender ID to match `93969186943`, a loopback host, a database path outside `data/`, and an explicit ADC confirmation. It refuses a service-account JSON environment override and does not run against the Firebase Emulator. It has a `--check` mode that validates local settings without starting the server or contacting Firebase.

1. In Firebase Console, use the project picker and confirm **dhbw-gym-test** (project number **93969186943**). Do not select or edit `reverberant-athlete-1c70r`.
2. Open **Project settings** (gear next to Project Overview) → **General** → **Your apps**. If no web app exists, use **Add app** → web icon, register a test-only nickname, and do not enable Hosting. Open that app's Firebase SDK setup and copy its Firebase config locally. Do not paste it into chat or source control.
3. Copy `.env.dhbw-test.local.example` to `.env.dhbw-test.local`. Fill in the API key, App ID, and Auth domain from the test web app. Confirm that Firestore uses `(default)`; named databases are rejected because the Admin notification writer currently uses `(default)`. Keep `FIREBASE_PROJECT_ID` and `VITE_FIREBASE_PROJECT_ID` equal to `dhbw-gym-test`; keep the sender ID equal to `93969186943`. The API key is browser configuration, not an Admin credential, but the local file should still remain untracked.
4. In **Authentication** → **Sign-in method** (or **Providers**, depending on Console UI), confirm **Email/Password** is enabled. Use **Authentication** → **Templates** to review the verification email. Do not enable Google until the test OAuth client and authorized test domains have been deliberately configured.
5. In **Authentication** → **Settings** → **Authorized domains**, add only the exact local test hostname needed. This setting does not replace the server's DHBW email allowlist. Obtain institutional confirmation of the allowed email domains before inviting students.
6. For server identity, use a separate Google user/ADC identity dedicated to the test project, authenticated locally with `gcloud auth application-default login`. In **Google Cloud Console** select **dhbw-gym-test** → **IAM & Admin** → **IAM** and verify the exact principal. It should have no access to the old project. Grant only the Firebase Auth read permission needed for revocation/user lookup (a narrowly scoped Firebase Auth Viewer role or verified custom role), plus the Firestore permissions required to create notifications and transactionally read/create conversations. Add Service Usage Consumer only if the API requires it. Do not create or download a service-account key. Verify the active ADC principal and its project IAM grants before setting `DHBW_TEST_CREDENTIALS_CONFIRMED=dhbw-gym-test` in the ignored local file. Do not rely on the configured `gcloud` CLI project alone as proof of ADC identity.
7. Choose a new path outside the repository's `data` directory for `GYM_APP_DATABASE_PATH`. The example uses `%LOCALAPPDATA%` explicitly expanded as a Windows path. The launcher refuses an existing database unless you inspect it and explicitly set `DHBW_TEST_DATABASE_REUSE=1`; it never deletes or resets it. Do not copy production data.
8. Before starting anything, run `npm.cmd run dev:dhbw-test -- --check`. It only checks structure, prints safe project/database identifiers, and does not connect or launch a server. Review the resolved path; only then, when you intentionally want a live test, run `npm.cmd run dev:dhbw-test`. The app binds to `127.0.0.1`. Stop with Ctrl+C. No live test has been started as part of this setup.

The test launcher is not a replacement for reviewing Console IAM or the Firestore rules. Partner requests are stored in SQLite through the authenticated API; direct client reads are participant-scoped and direct client writes are denied. Community discovery exposes only public profiles (plus the caller's own profile). Conversation creation is performed by an authenticated server endpoint: the server maps stable profile IDs to linked Firebase UIDs and permits the target only when their profile is public or an accepted partner request exists. Direct client conversation creation is denied, while reading and messaging remain participant-scoped. Review these changes and run the emulator rules tests before any separately approved publication.

Partner requests are authorized and persisted by the authenticated SQLite API. After a successful create or accept operation, the backend derives both Firebase UIDs from its verified identity and existing SQLite account mapping, then writes the Firestore notification through Firebase Admin. Client Firestore rules do not permit partner-request notifications; they are not weakened. If the recipient has no linked Firebase account, delivery is reported as unavailable. The backend creates conversations idempotently with a Firestore transaction; clients can only access existing conversations and messages when they are participants. New-message notifications are constrained to an existing message sent by the authenticated participant.

## Authentication and existing profiles

The Gym API accepts Firebase ID tokens as `Authorization: Bearer ...` and verifies them server-side with Firebase Admin, including the token-revocation check. Configure `FIREBASE_PROJECT_ID` and the server's Firebase Admin Application Default Credentials. The browser supports Google and email/password sign-in; the server requires a verified email on an allowed DHBW domain.

Existing SQLite profiles and their training, booking, visit, and goal data keep their existing `principalId`. A Firebase account can be linked to an existing profile only with the previous account password or a valid legacy app session; an email match alone is not proof. Recovery codes and legacy session cookies do not authenticate API requests. Back up the SQLite database before deploying the cutover.

The Gym API and Firestore rules use the same explicit DHBW email-domain allowlist (`bad-mergentheim.dhbw.de`, `badmergentheim.dhbw.de`, `dhbw-mannheim.de`, `dhbw-mosbach.de`, `dhbw-stuttgart.de`, `dhbw.de`, `heilbronn.dhbw.de`, and `lehre.dhbw-mannheim.de`). Confirm the applicable domains with DHBW before testing. Add a campus domain only after independently verifying that DHBW controls it, and update both `server/gymAppService.ts` and `firestore.rules` together. Validate Firestore rules with the Firebase Emulator before deployment.

## Project status

This application is under development. Before public use, hosting, database operations, authentication, privacy, and production configuration must be reviewed.
