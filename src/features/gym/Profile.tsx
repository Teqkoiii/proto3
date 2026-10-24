import { useState } from 'react';
import {
  Eye,
  EyeOff,
  GraduationCap,
  Lock,
  LogOut,
  Mail,
  Save,
  ShieldCheck,
  Target,
  Trash2,
  User,
  UserCheck,
} from 'lucide-react';
import type { CommunityProfile, GymSession } from '../../services/gymRepository';
import { Field, InlineNotice, PageHeading, SectionTitle } from './components';

const DHBW_BAD_MERGENTHEIM_STUDY_PROGRAMS = [
  'BWL – Handel',
  'BWL – Food Management',
  'BWL – International Business',
  'BWL – International Retail Management',
  'Wirtschaftsingenieurwesen',
  'Pflege',
  'Sonstiger Studiengang',
] as const;

const AVAILABLE_GOALS = [
  'Hypertrophie (Muskelaufbau)',
  'Kraftsport (Powerlifting)',
  'Ausdauer & Cardio',
  'Calisthenics & Bodyweight',
  'Rückengesundheit & Mobilität',
];

const AVAILABLE_TIMES = [
  'Morgens (06:00 – 10:00)',
  'Mittags (11:30 – 14:00)',
  'Nachmittags (15:00 – 18:00)',
  'Abends (18:00 – 22:00)',
];

export function Profile({
  session,
  firebaseAuthenticated,
  profile,
  online,
  busy,
  error,
  onDeleteData,
  onSaveProfile,
  onRegister,
  onLogin,
  onResendVerificationEmail,
  onLogout,
  onLinkExisting,
}: {
  session: GymSession | null;
  firebaseAuthenticated: boolean;
  profile: CommunityProfile | null;
  online: boolean;
  busy: boolean;
  error: string | null;
  onDeleteData: () => void;
  onSaveProfile: (updated: Partial<CommunityProfile>) => Promise<void>;
  onRegister: (data: { email: string; password: string; firstName?: string; lastNameInitial?: string; courseOfStudy?: string }) => Promise<void>;
  onLogin: (email: string, password: string) => Promise<void>;
  onResendVerificationEmail: (email: string, password: string) => Promise<void>;
  onLogout: () => Promise<void>;
  onLinkExisting: (legacyPassword: string) => Promise<void>;
}) {
  // Community profile states
  const [firstName, setFirstName] = useState(profile?.firstName ?? '');
  const [lastNameInitial, setLastNameInitial] = useState(profile?.lastNameInitial ?? '');
  const [courseOfStudy, setCourseOfStudy] = useState(
    DHBW_BAD_MERGENTHEIM_STUDY_PROGRAMS.includes(profile?.courseOfStudy as (typeof DHBW_BAD_MERGENTHEIM_STUDY_PROGRAMS)[number])
      ? profile?.courseOfStudy ?? ''
      : profile?.courseOfStudy ? 'Sonstiger Studiengang' : '',
  );
  const [selectedGoals, setSelectedGoals] = useState<string[]>(profile?.trainingGoals ?? []);
  const [selectedTimes, setSelectedTimes] = useState<string[]>(profile?.preferredTimes ?? []);
  const [bio, setBio] = useState(profile?.bio ?? '');
  const [isPublicPresence, setIsPublicPresence] = useState(profile?.isPublicPresence ?? true);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileSuccess, setProfileSuccess] = useState<string | null>(null);

  // Auth states
  const [authMode, setAuthMode] = useState<'view' | 'login' | 'register'>('view');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  const [legacyPassword, setLegacyPassword] = useState('');

  const toggleGoal = (goal: string) => {
    setSelectedGoals((prev) =>
      prev.includes(goal) ? prev.filter((g) => g !== goal) : [...prev, goal],
    );
  };

  const toggleTime = (time: string) => {
    setSelectedTimes((prev) =>
      prev.includes(time) ? prev.filter((t) => t !== time) : [...prev, time],
    );
  };

  const handleProfileSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setProfileSaving(true);
    setProfileSuccess(null);
    try {
      await onSaveProfile({
        firstName: firstName.trim(),
        lastNameInitial: lastNameInitial.trim().slice(0, 1).toUpperCase(),
        courseOfStudy: courseOfStudy.trim(),
        trainingGoals: selectedGoals,
        preferredTimes: selectedTimes,
        bio: bio.trim(),
        isPublicPresence,
      });
      setProfileSuccess('Dein Community-Profil wurde erfolgreich gespeichert.');
    } finally {
      setProfileSaving(false);
    }
  };

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthBusy(true);
    setAuthError(null);
    try {
      if (authMode === 'register') {
        await onRegister({
          email: authEmail.trim(),
          password: authPassword,
        });
        setAuthNotice('Bitte bestätige deine E-Mail-Adresse über den Firebase-Link in deinem Postfach. Danach kannst du dich anmelden.');
      } else {
        await onLogin(authEmail.trim(), authPassword);
        setAuthNotice(null);
      }
      setAuthMode('view');
      setAuthEmail('');
      setAuthPassword('');
    } catch (caught) {
      setAuthError(authErrorMessage(caught));
    } finally {
      setAuthBusy(false);
    }
  };

  const handleResendVerification = async () => {
    setAuthBusy(true);
    setAuthError(null);
    setAuthNotice(null);
    try {
      await onResendVerificationEmail(authEmail.trim(), authPassword);
      setAuthNotice('Die Bestätigungs-E-Mail wurde erneut angefordert. Prüfe auch den Spam-Ordner.');
      setAuthPassword('');
    } catch (caught) {
      setAuthError(authErrorMessage(caught));
    } finally {
      setAuthBusy(false);
    }
  };

  return (
    <>
      <PageHeading
        eyebrow="DEIN KONTO & DATENSCHUTZ"
        title="Profil & Einstellungen"
        description="Passe deine Trainingsinteressen, deine Sichtbarkeit im gemeinsamen Kalender und deine DHBW-Kennung an."
      />

      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      {authError && <InlineNotice tone="error">{authError}</InlineNotice>}
      {profileSuccess && <InlineNotice tone="success">{profileSuccess}</InlineNotice>}
      {authNotice && <InlineNotice tone="success">{authNotice}</InlineNotice>}

      <div className="profile-grid">
        {/* 1. Community Profile Form */}
        <section className="surface profile-card">
          <div className="panel-topline">
            <span className="icon-badge">
              <UserCheck size={19} aria-hidden="true" />
            </span>
            <span className="panel-label">Community-Profil</span>
          </div>

          <SectionTitle title="Trainingsprofil & Interessen" />
          <p className="muted-copy">
            Diese Angaben helfen anderen DHBW-Studierenden, passende Trainingspartner für gemeinsame Zeiten
            zu finden.
          </p>

          <form onSubmit={handleProfileSubmit} className="stack-form mt-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Field label="Vorname">
                <input
                  type="text"
                  className="text-input"
                  required
                  maxLength={40}
                  value={firstName}
                  placeholder="z. B. Max"
                  onChange={(e) => setFirstName(e.target.value)}
                />
              </Field>
              <Field label="Nachname (wird nur als Initiale gezeigt)">
                <input
                  type="text"
                  className="text-input"
                  maxLength={1}
                  value={lastNameInitial}
                  placeholder="z. B. M"
                  onChange={(e) => setLastNameInitial(e.target.value)}
                />
              </Field>
            </div>

            <Field label="Studiengang an der DHBW Bad Mergentheim">
              <select
                className="text-input"
                value={courseOfStudy}
                onChange={(e) => setCourseOfStudy(e.target.value)}
                required
              >
                <option value="" disabled>Studiengang auswählen</option>
                {DHBW_BAD_MERGENTHEIM_STUDY_PROGRAMS.map((program) => (
                  <option key={program} value={program}>{program}</option>
                ))}
              </select>
            </Field>

            <Field label="Deine Trainingsziele">
              <div className="checkbox-chips-grid">
                {AVAILABLE_GOALS.map((goal) => {
                  const active = selectedGoals.includes(goal);
                  return (
                    <button
                      key={goal}
                      type="button"
                      className={`goal-chip-button ${active ? 'is-active' : ''}`}
                      onClick={() => toggleGoal(goal)}
                    >
                      <Target size={14} aria-hidden="true" />
                      <span>{goal}</span>
                    </button>
                  );
                })}
              </div>
            </Field>

            <Field label="Bevorzugte Trainingszeiten">
              <div className="checkbox-chips-grid">
                {AVAILABLE_TIMES.map((time) => {
                  const active = selectedTimes.includes(time);
                  return (
                    <button
                      key={time}
                      type="button"
                      className={`goal-chip-button ${active ? 'is-active' : ''}`}
                      onClick={() => toggleTime(time)}
                    >
                      <span>{time}</span>
                    </button>
                  );
                })}
              </div>
            </Field>

            <Field label="Über mich / Gym-Buddy-Gesuch">
              <textarea
                className="text-input"
                rows={2}
                maxLength={250}
                placeholder="z. B. Trainiere 3-4x pro Woche, suche jemanden zum Spotten beim Bankdrücken."
                value={bio}
                onChange={(e) => setBio(e.target.value)}
              />
            </Field>

            {/* Privacy Toggle Card */}
            <div className={`privacy-toggle-box ${isPublicPresence ? 'active' : 'private'}`}>
              <div className="toggle-info">
                <div className="flex items-center gap-2">
                  {isPublicPresence ? (
                    <Eye size={18} className="text-red-400" />
                  ) : (
                    <EyeOff size={18} className="text-amber-400" />
                  )}
                  <strong className="text-sm">
                    {isPublicPresence ? 'Öffentliche Anwesenheit aktiv' : 'Privater Modus aktiv'}
                  </strong>
                </div>
                <p className="text-xs text-slate-300 mt-1">
                  {isPublicPresence
                    ? 'Dein Vorname & Initiale (z. B. Anna S.) sind im Kalender und in der Community sichtbar.'
                    : 'Deine Einträge werden im Kalender als „Anonymer DHBW Student“ geführt. Deine Identität ist verborgen.'}
                </p>
              </div>
              <button
                type="button"
                className={`button compact-button ${isPublicPresence ? 'button-secondary' : 'button-primary'}`}
                onClick={() => setIsPublicPresence(!isPublicPresence)}
              >
                {isPublicPresence ? 'Auf Privat schalten' : 'Sichtbar machen'}
              </button>
            </div>

            <button
              type="submit"
              className="button button-primary full-width mt-3"
              disabled={profileSaving || busy || !online}
            >
              <Save size={16} aria-hidden="true" />
              <span>{profileSaving ? 'Wird gespeichert...' : 'Profil speichern'}</span>
            </button>
          </form>
        </section>

        {/* 2. DHBW Account & Authentication */}
        <section className="surface profile-card">
          <div className="panel-topline">
            <span className="icon-badge">
              <GraduationCap size={19} aria-hidden="true" />
            </span>
            <span className="panel-label">DHBW Zugang</span>
          </div>

          <SectionTitle title="DHBW Hochschul-Konto" />

          {session?.identity === 'firebase-account' && session.email ? (
            <div className="account-status-box">
              <div className="flex items-center gap-2 text-red-400 mb-2">
                <ShieldCheck size={18} />
                <span className="font-semibold text-sm">Verifizierte DHBW-E-Mail</span>
              </div>
              <p className="text-sm font-mono bg-slate-900 p-2.5 rounded-lg border border-slate-700">
                {session.email}
              </p>
              <p className="muted-copy text-xs mt-2">
                Dein Profil ist sicher mit deiner Hochschul-E-Mail verknüpft.
              </p>
              <button
                type="button"
                className="button button-secondary full-width mt-4"
                disabled={busy}
                onClick={onLogout}
              >
                <LogOut size={16} aria-hidden="true" />
                <span>Abmelden</span>
              </button>
            </div>
          ) : firebaseAuthenticated ? (
            <div className="account-anon-box">
              <p className="text-sm text-slate-300">
                Dein DHBW-Konto ist angemeldet. Um ein vorhandenes App-Profil zu übernehmen, bestätige es
                mit dem bisherigen Passwort. Eine Übereinstimmung der E-Mail-Adresse allein reicht nicht aus.
              </p>
              <form
                className="stack-form mt-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void onLinkExisting(legacyPassword);
                }}
              >
                <Field label="Bisheriges App-Passwort">
                  <input
                    type="password"
                    className="text-input"
                    minLength={10}
                    autoComplete="current-password"
                    value={legacyPassword}
                    onChange={(event) => setLegacyPassword(event.target.value)}
                    placeholder="Passwort deines bisherigen Kontos"
                    required
                  />
                </Field>
                <button
                  type="submit"
                  className="button button-primary full-width"
                  disabled={busy || legacyPassword.length < 10}
                >
                  Vorhandenes Profil verknüpfen
                </button>
              </form>
              <button
                type="button"
                className="button button-secondary full-width mt-2"
                disabled={busy}
                onClick={onLogout}
              >
                <LogOut size={16} aria-hidden="true" />
                <span>Abmelden</span>
              </button>
            </div>
          ) : authMode === 'view' ? (
            <div className="account-anon-box">
              <p className="text-sm text-slate-300">
                Melde dich mit einer verifizierten DHBW-E-Mail-Adresse an. Bestehende Profile werden nur nach
                Nachweis des bisherigen Passworts oder der vorherigen Gerätesitzung übernommen.
              </p>
              <div className="flex gap-2 mt-4">
                <button
                  type="button"
                  className="button button-primary flex-1"
                  onClick={() => setAuthMode('register')}
                >
                  <Mail size={16} />
                  <span>Registrieren</span>
                </button>
                <button
                  type="button"
                  className="button button-secondary flex-1"
                  onClick={() => setAuthMode('login')}
                >
                  <Lock size={16} />
                  <span>Anmelden</span>
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={handleAuthSubmit} className="stack-form mt-2">
              <div className="flex items-center justify-between mb-2">
                <h3 className="font-semibold text-sm">
                  {authMode === 'register' ? 'DHBW-Konto registrieren' : 'Mit DHBW-Konto anmelden'}
                </h3>
                <button
                  type="button"
                  className="text-xs text-slate-400 hover:text-white"
                  onClick={() => {
                    setAuthMode(authMode === 'register' ? 'login' : 'register');
                    setAuthError(null);
                  }}
                >
                  {authMode === 'register' ? 'Schon registriert? Anmelden' : 'Neu hier? Registrieren'}
                </button>
              </div>

              <Field label="DHBW E-Mail-Adresse" hint="z. B. @bad-mergentheim.dhbw.de oder @dhbw-*.de">
                <input
                  type="email"
                  className="text-input"
                  required
                  placeholder="name@bad-mergentheim.dhbw.de"
                  value={authEmail}
                  onChange={(e) => setAuthEmail(e.target.value)}
                />
              </Field>

              <Field label="Passwort" hint="Mindestens 10 Zeichen">
                <input
                  type="password"
                  className="text-input"
                  required
                  minLength={10}
                  placeholder="Sicheres Passwort"
                  value={authPassword}
                  onChange={(e) => setAuthPassword(e.target.value)}
                />
              </Field>

              <div className="flex gap-2 mt-2">
                <button
                  type="button"
                  className="button button-secondary flex-1"
                  onClick={() => setAuthMode('view')}
                >
                  Abbrechen
                </button>
                <button
                  type="submit"
                  className="button button-primary flex-1"
                  disabled={authBusy}
                >
                  {authBusy
                    ? 'Wird ausgeführt...'
                    : authMode === 'register'
                    ? 'Konto erstellen'
                    : 'Anmelden'}
                </button>
              </div>
              {authMode === 'login' && (
                <button
                  type="button"
                  className="text-action mt-2"
                  disabled={authBusy || !authEmail.trim() || !authPassword}
                  onClick={() => void handleResendVerification()}
                >
                  {authBusy ? 'Wird ausgeführt...' : 'Bestätigungs-E-Mail erneut senden'}
                </button>
              )}
            </form>
          )}

        </section>

        {/* 3. Privacy & DSGVO */}
        <section className="surface profile-card privacy-card">
          <span className="icon-badge">
            <ShieldCheck size={19} aria-hidden="true" />
          </span>
          <SectionTitle title="Datenschutz & Datenhoheit" />
          <ul className="privacy-list">
            <li>Ausschließlich autorisierte DHBW-Angehörige haben Zugriff auf die Plattform.</li>
            <li>
              Deine Anwesenheitssichtbarkeit ist freiwillig und kann jederzeit mit einem Klick auf privat
              gestellt werden.
            </li>
            <li>E-Mail-Adressen und private Kontaktdaten werden niemals öffentlich im Client geteilt.</li>
            <li>Besuche und Check-ins werden nach 90 Tagen automatisch gelöscht.</li>
            <li>Du hast das Recht, alle deine persönlichen Daten und Kontoeinträge vollständig zu löschen.</li>
          </ul>
          <button
            type="button"
            className="button button-danger"
            disabled={!online || busy}
            onClick={onDeleteData}
          >
            <Trash2 size={16} aria-hidden="true" />
            <span>Alle meine App-Daten löschen</span>
          </button>
        </section>
      </div>
    </>
  );
}

function authErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const code = 'code' in error && typeof error.code === 'string' ? error.code : '';
    if (code === 'auth/email-already-in-use') return 'Für diese E-Mail-Adresse gibt es bereits ein Konto. Melde dich an.';
    if (code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found') {
      return 'E-Mail-Adresse oder Passwort ist nicht korrekt.';
    }
    if (code === 'auth/weak-password') return 'Das Passwort ist zu schwach. Verwende ein längeres Passwort.';
    if (code === 'auth/invalid-email') return 'Bitte gib eine gültige E-Mail-Adresse ein.';
    if (code === 'auth/network-request-failed') return 'Der Authentifizierungsdienst ist nicht erreichbar. Bitte versuche es erneut.';
    return error.message;
  }
  return 'Die Anfrage ist fehlgeschlagen. Bitte versuche es erneut.';
}
