import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  GymApiError,
  gymRepository,
  type ActiveCheckInItem,
  type CalendarEventItem,
  type CommunityMember,
  type CommunityProfile,
  type GymAvailability,
  type GymBooking,
  type GymSession,
  type GymVisit,
  type OccupancyRange,
  type OccupancySnapshot,
  type SharedBookingSlot,
  type TrainingPartnerRequest,
  type WorkoutLog,
} from '../../services/gymRepository';
import { auth, subscribeToAuth } from '../../services/firebase';
import {
  subscribeToConversations,
  subscribeToNotifications,
  sendNotification,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  type CloudConversation,
  type CloudNotification,
} from '../../services/communityChatService';
import { AppFrame, InlineNotice, type GymPage } from './components';
import { Dashboard } from './Dashboard';
import { Calendar } from './Calendar';
import { Community } from './Community';
import { Training } from './Training';
import { Progress } from './Progress';
import { Profile } from './Profile';
import { NotificationCenter } from './NotificationCenter';
import { ChatDrawer } from './ChatDrawer';
import { MessageSquare } from 'lucide-react';
import './gym.css';

export function GymApp() {
  const [page, setPage] = useState<GymPage>('dashboard');
  const [loading, setLoading] = useState(true);
  const [online, setOnline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [session, setSession] = useState<GymSession | null>(null);
  const [occupancy, setOccupancy] = useState<OccupancySnapshot | null>(null);
  const [occupancyRange, setOccupancyRange] = useState<OccupancyRange>('24h');
  const [bookings, setBookings] = useState<GymBooking[]>([]);
  const [sharedSlots, setSharedSlots] = useState<SharedBookingSlot[]>([]);
  const [visits, setVisits] = useState<GymVisit[]>([]);
  const [workouts, setWorkouts] = useState<WorkoutLog[]>([]);
  const [weeklyGoal, setWeeklyGoal] = useState(3);
  const [availability, setAvailability] = useState<GymAvailability | null>(null);

  // Community & Live Calendar states
  const [calendarEvents, setCalendarEvents] = useState<CalendarEventItem[]>([]);
  const [activeCheckIns, setActiveCheckIns] = useState<ActiveCheckInItem[]>([]);
  const [communityProfile, setCommunityProfile] = useState<CommunityProfile | null>(null);
  const [communityMembers, setCommunityMembers] = useState<CommunityMember[]>([]);
  const [partnerRequests, setPartnerRequests] = useState<TrainingPartnerRequest[]>([]);

  // Cloud Chat & Notifications states
  const [firebaseUserId, setFirebaseUserId] = useState<string>('');
  const [firebaseAuthenticated, setFirebaseAuthenticated] = useState(false);
  const firebaseUserIdRef = useRef('');
  const [cloudDataUserId, setCloudDataUserId] = useState('');
  const [conversations, setConversations] = useState<CloudConversation[]>([]);
  const [notifications, setNotifications] = useState<CloudNotification[]>([]);
  const [localNotifications, setLocalNotifications] = useState<CloudNotification[]>([]);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [activeChatPartner, setActiveChatPartner] = useState<CommunityMember | null>(null);

  const activeNotifications = useMemo(() => {
    if (!firebaseUserId) return localNotifications;
    return cloudDataUserId === firebaseUserId ? notifications : [];
  }, [cloudDataUserId, firebaseUserId, notifications, localNotifications]);
  const activeConversations = useMemo(
    () => firebaseUserId && cloudDataUserId === firebaseUserId ? conversations : [],
    [cloudDataUserId, conversations, firebaseUserId],
  );

  // Initialize Firebase Auth & observe authentication state
  useEffect(() => {
    const unsub = subscribeToAuth((user) => {
      const nextUserId = user?.emailVerified ? user.uid : '';
      if (firebaseUserIdRef.current !== nextUserId) {
        firebaseUserIdRef.current = nextUserId;
        setCloudDataUserId('');
        setConversations([]);
        setNotifications([]);
        setLocalNotifications([]);
        setIsChatOpen(false);
        setActiveChatPartner(null);
      }
      setFirebaseAuthenticated(Boolean(user?.emailVerified));
      setFirebaseUserId(nextUserId);
    });
    return () => unsub();
  }, []);

  // Subscribe to real-time conversations & notifications in Firestore ONLY when Firebase Auth is ready
  useEffect(() => {
    if (!firebaseUserId) return;
    const unsubConv = subscribeToConversations(firebaseUserId, (items) => {
      if (firebaseUserIdRef.current !== firebaseUserId || auth.currentUser?.uid !== firebaseUserId) return;
      setCloudDataUserId(firebaseUserId);
      setConversations(items);
    });
    const unsubNotif = subscribeToNotifications(firebaseUserId, (items) => {
      if (firebaseUserIdRef.current !== firebaseUserId || auth.currentUser?.uid !== firebaseUserId) return;
      setCloudDataUserId(firebaseUserId);
      setNotifications(items);
    });
    return () => {
      unsubConv();
      unsubNotif();
    };
  }, [firebaseUserId]);

  const refreshAll = useCallback(async () => {
    if (!firebaseUserId) {
      setSession(null);
      setBookings([]);
      setVisits([]);
      setWorkouts([]);
      setCommunityProfile(null);
      setCommunityMembers([]);
      setPartnerRequests([]);
      setCalendarEvents([]);
      setActiveCheckIns([]);
      setOnline(true);
      setError(null);
      setLoading(false);
      return;
    }
    try {
      await gymRepository.linkFirebaseAccount();
      const currentSession = await gymRepository.getSession();
      const [
        currentOccupancy,
        shared,
        mine,
        calData,
        cProfile,
        cMembers,
        pRequests,
        currentVisits,
        currentWorkouts,
        currentGoal,
      ] = await Promise.all([
        gymRepository.getOccupancy(occupancyRange),
        gymRepository.getBookings(),
        gymRepository.getMyBookings(),
        gymRepository.getCalendarEvents(),
        gymRepository.getCommunityProfile().catch(() => null),
        gymRepository.getCommunityMembers().catch(() => []),
        gymRepository.getPartnerRequests().catch(() => []),
        gymRepository.getVisits(),
        gymRepository.getWorkouts(),
        gymRepository.getWeeklyGoal(),
      ]);

      setSession(currentSession);
      setOccupancy(currentOccupancy);
      setSharedSlots(shared.slots);
      setBookings(mine);
      setCalendarEvents(calData.events);
      setActiveCheckIns(calData.activeCheckIns);
      setCommunityProfile(cProfile);
      setCommunityMembers(cMembers);
      setPartnerRequests(pRequests);
      setVisits(currentVisits);
      setWorkouts(currentWorkouts);
      setWeeklyGoal(currentGoal);
      setOnline(true);
      setError(null);
    } catch (caught) {
      setOnline(false);
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, [firebaseUserId, occupancyRange]);

  const refreshLivePresence = useCallback(async () => {
    if (!firebaseUserId) return;
    try {
      const [current, currentSession, calData] = await Promise.all([
        gymRepository.getOccupancy(occupancyRange),
        gymRepository.getSession(),
        gymRepository.getCalendarEvents(),
      ]);
      setOccupancy(current);
      setSession(currentSession);
      setCalendarEvents(calData.events);
      setActiveCheckIns(calData.activeCheckIns);
      setOnline(true);
    } catch (caught) {
      setOnline(false);
      setError(errorMessage(caught));
    }
  }, [occupancyRange]);

  // Smart polling: every 15s + on window focus / tab visibility change
  useEffect(() => {
    void refreshAll();
    const timer = window.setInterval(() => void refreshLivePresence(), 15_000);
    const onFocus = () => {
      if (document.visibilityState === 'visible') void refreshAll();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [refreshAll, refreshLivePresence]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // Automatic Slot-Reminder Check: If upcoming booking in next 2 hours
  useEffect(() => {
    if (!firebaseUserId || bookings.length === 0) return;
    const now = Date.now();
    const upcoming = bookings.find((b) => {
      const startMs = new Date(b.startsAt).getTime();
      const diffMinutes = (startMs - now) / (1000 * 60);
      return diffMinutes > 0 && diffMinutes <= 120;
    });

    if (upcoming) {
      const existingReminder = notifications.some(
        (n) => n.type === 'slot_reminder' && n.message.includes(upcoming.title || 'Training'),
      );
      if (!existingReminder) {
        void sendNotification(firebaseUserId, {
          type: 'slot_reminder',
          title: '⏰ Erinnerung: Dein Gym-Slot beginnt bald!',
          message: `Dein geplantes Training "${upcoming.title || 'Workout'}" startet in Kürze.`,
          linkUrl: '/calendar',
        }).catch(() => undefined);
      }
    }
  }, [bookings, firebaseUserId, notifications]);

  const runMutation = useCallback(
    async (operation: () => Promise<void>, successMessage: string): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        await operation();
        await refreshAll();
        setToast(successMessage);
        return true;
      } catch (caught) {
        setError(errorMessage(caught));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [refreshAll],
  );

  const handlePresence = useCallback(
    (present: boolean) =>
      runMutation(
        () => gymRepository.setCheckedIn(present),
        present ? 'Du bist im Gym eingecheckt.' : 'Du wurdest erfolgreich ausgecheckt.',
      ),
    [runMutation],
  );

  const handleCreateBooking = useCallback(
    (input: { startsAt: string; durationMinutes: number; title?: string; entryType?: 'planned' | 'reservation' }) =>
      runMutation(
        async () => {
          await gymRepository.createBooking(input);
          // Create a reminder notification
          if (firebaseUserId) {
            void sendNotification(firebaseUserId, {
              type: 'slot_reminder',
              title: 'Gym-Slot eingetragen',
              message: `Deine Trainingszeit für ${new Date(input.startsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} Uhr wurde reserviert.`,
              linkUrl: '/calendar',
            }).catch(() => undefined);
          }
        },
        input.entryType === 'reservation' ? 'Deine Trainingszeit wurde reserviert.' : 'Geplante Anwesenheit eingetragen.',
      ),
    [firebaseUserId, runMutation],
  );

  const handleDeleteBooking = useCallback(
    (id: string) =>
      runMutation(
        () => gymRepository.deleteBooking(id),
        'Eintrag entfernt.',
      ),
    [runMutation],
  );

  const handleUpdateBooking = useCallback(
    (id: string, input: { startsAt: string; durationMinutes: number; title?: string; entryType?: 'planned' | 'reservation' }) =>
      runMutation(
        async () => {
          const updatedBooking = await gymRepository.updateBooking(id, input);
          setBookings((current) => current.map((booking) => (
            booking.id === id ? updatedBooking : booking
          )));
          setCalendarEvents((current) => current.map((event) => (
            event.id === id
              ? { ...event, ...updatedBooking, entryType: input.entryType ?? event.entryType }
              : event
          )));
        },
        'Trainingszeit aktualisiert.',
      ),
    [runMutation],
  );

  const handleCreateWorkout = useCallback(
    (input: Omit<WorkoutLog, 'id'>) =>
      runMutation(
        () => gymRepository.createWorkout(input),
        'Training gespeichert.',
      ),
    [runMutation],
  );

  const handleDeleteWorkout = useCallback(
    (id: string) =>
      runMutation(
        () => gymRepository.deleteWorkout(id),
        'Training gelöscht.',
      ),
    [runMutation],
  );

  const handleGoal = useCallback(
    (value: number) =>
      runMutation(
        async () => {
          await gymRepository.setWeeklyGoal(value);
        },
        'Wochenziel aktualisiert.',
      ),
    [runMutation],
  );

  const handleAvailability = useCallback(async (startAt: string, duration: number) => {
    try {
      setAvailability(await gymRepository.getAvailability(startAt, duration));
    } catch {
      setAvailability(null);
    }
  }, []);

  const handleSaveProfile = useCallback(
    async (updated: Partial<CommunityProfile>) => {
      setBusy(true);
      setError(null);
      try {
        const saved = await gymRepository.updateCommunityProfile(updated);
        setCommunityProfile(saved);
        await refreshAll();
        setToast('Community-Profil gespeichert.');
      } catch (caught) {
        setError(errorMessage(caught));
      } finally {
        setBusy(false);
      }
    },
    [refreshAll],
  );

  const handleSendPartnerRequest = useCallback(
    async (receiverId: string, note?: string, proposedDate?: string) => {
      setBusy(true);
      setError(null);
      try {
        const result = await gymRepository.sendPartnerRequest(receiverId, note, proposedDate);
        await refreshAll();
        setToast(result.notificationStatus === 'sent'
          ? 'Trainingspartner-Anfrage gesendet.'
          : result.notificationStatus === 'unavailable'
          ? 'Trainingspartner-Anfrage gesendet. Eine Benachrichtigung ist derzeit nicht verfügbar.'
          : 'Trainingspartner-Anfrage gesendet, die Benachrichtigung konnte aber nicht zugestellt werden.');
      } catch (caught) {
        setError(errorMessage(caught));
      } finally {
        setBusy(false);
      }
    },
    [communityProfile, refreshAll],
  );

  const handleRespondPartnerRequest = useCallback(
    async (id: string, status: 'accepted' | 'declined' | 'cancelled') => {
      setBusy(true);
      setError(null);
      try {
        const result = await gymRepository.respondToPartnerRequest(id, status);
        await refreshAll();
        setToast(
          status === 'accepted'
            ? result.notificationStatus === 'sent'
              ? 'Partner-Anfrage angenommen.'
              : result.notificationStatus === 'unavailable'
              ? 'Partner-Anfrage angenommen. Eine Benachrichtigung ist derzeit nicht verfügbar.'
              : 'Partner-Anfrage angenommen, die Benachrichtigung konnte aber nicht zugestellt werden.'
            : status === 'declined'
            ? 'Anfrage abgelehnt.'
            : 'Anfrage zurückgezogen.',
        );
      } catch (caught) {
        setError(errorMessage(caught));
      } finally {
        setBusy(false);
      }
    },
    [communityProfile, partnerRequests, refreshAll],
  );

  const handleTriggerTestSlotReminder = useCallback(async () => {
    if (firebaseUserId) {
      await sendNotification(firebaseUserId, {
        type: 'slot_reminder',
        title: '⏰ Erinnerung: Gym-Slot in 30 Minuten!',
        message: 'Dein gebuchter Trainings-Slot im DHBW Gym Campus Bad Mergentheim beginnt gleich. Schnapp dir deine Trainingsschuhe!',
        linkUrl: '/calendar',
      });
    } else {
      const mockNotif: CloudNotification = {
        id: `notif_${Date.now()}`,
        userId: 'local_user',
        senderId: 'local_user',
        type: 'slot_reminder',
        title: '⏰ Erinnerung: Gym-Slot in 30 Minuten!',
        message: 'Dein gebuchter Trainings-Slot im DHBW Gym Campus Bad Mergentheim beginnt gleich. Schnapp dir deine Trainingsschuhe!',
        read: false,
        linkUrl: '/calendar',
        createdAt: new Date().toISOString(),
      };
      setLocalNotifications((prev) => [mockNotif, ...prev]);
    }
    setToast('Slot-Erinnerung simuliert!');
  }, [firebaseUserId]);

  const handleOpenChat = useCallback((member: CommunityMember) => {
    setActiveChatPartner(member);
    setIsChatOpen(true);
  }, []);

  const handleRegister = useCallback(
    async (data: { email: string; password: string; firstName?: string; lastNameInitial?: string; courseOfStudy?: string }) => {
      setBusy(true);
      setError(null);
      try {
        await gymRepository.registerWithDhbw(data);
        setToast('Bitte bestätige deine E-Mail-Adresse über den Link in deinem Postfach. Danach kannst du dich anmelden.');
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const handleLogin = useCallback(
    async (email: string, pass: string) => {
      setBusy(true);
      setError(null);
      try {
        await gymRepository.login(email, pass);
        await refreshAll();
        setToast('Erfolgreich angemeldet!');
      } finally {
        setBusy(false);
      }
    },
    [refreshAll],
  );

  const handleResendVerificationEmail = useCallback(
    async (email: string, password: string) => {
      setBusy(true);
      setError(null);
      try {
        await gymRepository.resendVerificationEmail(email, password);
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const handleLogout = useCallback(async () => {
    setBusy(true);
    try {
      await gymRepository.logout();
      setToast('Abgemeldet.');
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }, []);

  const handleLinkExisting = useCallback(async (legacyPassword: string) => {
    setBusy(true);
    setError(null);
    try {
      await gymRepository.linkFirebaseAccount(legacyPassword);
      await refreshAll();
      setToast('Dein bestehendes Profil wurde sicher verknüpft.');
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }, [refreshAll]);

  const handleDeleteData = useCallback(() => {
    if (
      !window.confirm(
        'Alle deine Trainingsdaten, Profilangaben, Reservierungen und Partner-Anfragen wirklich löschen?',
      )
    ) {
      return;
    }
    void runMutation(async () => {
      await gymRepository.deletePersonalData();
      setPage('dashboard');
    }, 'Deine persönlichen App-Daten wurden vollständig gelöscht.');
  }, [runMutation]);

  if (loading) {
    return (
      <div className="app-loading" role="status">
        <span className="loading-mark" />
        <p>DHBW Gym Hub wird verbunden …</p>
      </div>
    );
  }

  return (
    <AppFrame
      page={page}
      onNavigate={setPage}
      headerActions={
        <NotificationCenter
          notifications={activeNotifications}
          isCloudConnected={Boolean(firebaseUserId)}
          onMarkRead={(id) => {
            if (firebaseUserId) {
              void markNotificationAsRead(firebaseUserId, id);
            } else {
              setLocalNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
            }
          }}
          onMarkAllRead={() => {
            if (firebaseUserId) {
              void markAllNotificationsAsRead(firebaseUserId, notifications);
            } else {
              setLocalNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
            }
          }}
          onTriggerTestSlotReminder={handleTriggerTestSlotReminder}
          onNavigate={setPage}
          onOpenChat={(pId, pName) => {
            const found = communityMembers.find((m) => m.id === pId) || {
              id: pId,
              firstName: pName.split(' ')[0] || pName,
              lastNameInitial: pName.split(' ')[1]?.replace('.', '') || '',
              courseOfStudy: 'DHBW Bad Mergentheim',
              trainingGoals: [],
              preferredTimes: [],
              interests: [],
              bio: '',
              isPublicPresence: true,
              activeNow: false,
              plannedNext: null,
              isSelf: false,
            };
            handleOpenChat(found);
          }}
        />
      }
    >
      {!online && firebaseUserId && (
        <InlineNotice tone="warning">
          Der Gym-Server ist nicht erreichbar. Angezeigte Daten können veraltet sein; Check-in,
          Reservierungen und Speichern sind derzeit deaktiviert.
        </InlineNotice>
      )}
      {!firebaseUserId && (
        <InlineNotice tone="warning">
          Melde dich mit deinem verifizierten DHBW-Konto an, um auf dein Profil und deine Trainingsdaten zuzugreifen.
        </InlineNotice>
      )}

      {page === 'dashboard' && (
        <Dashboard
          session={session}
          occupancy={occupancy}
          occupancyRange={occupancyRange}
          onOccupancyRangeChange={setOccupancyRange}
          bookings={bookings}
          workouts={workouts}
          weeklyGoal={weeklyGoal}
          online={online}
          busy={busy}
          error={error}
          onPresence={handlePresence}
          onNavigate={setPage}
        />
      )}

      {page === 'calendar' && (
        <Calendar
          session={session}
          calendarEvents={calendarEvents}
          activeCheckIns={activeCheckIns}
          visits={visits}
          workouts={workouts}
          availability={availability}
          online={online}
          busy={busy}
          error={error}
          onCreateBooking={handleCreateBooking}
          onUpdateBooking={handleUpdateBooking}
          onDeleteBooking={handleDeleteBooking}
          onCheckAvailability={handleAvailability}
          onPresence={handlePresence}
          onNavigate={setPage}
        />
      )}

      {page === 'community' && (
        <Community
          members={communityMembers}
          requests={partnerRequests}
          myProfile={communityProfile}
          online={online}
          busy={busy}
          error={error}
          onSendRequest={handleSendPartnerRequest}
          onRespondRequest={handleRespondPartnerRequest}
          onNavigateToProfile={() => setPage('profile')}
          onOpenChat={handleOpenChat}
        />
      )}

      {page === 'training' && (
        <Training
          workouts={workouts}
          busy={busy}
          error={error}
          online={online}
          onCreate={handleCreateWorkout}
          onDelete={handleDeleteWorkout}
        />
      )}

      {page === 'progress' && (
        <Progress
          workouts={workouts}
          weeklyGoal={weeklyGoal}
          busy={busy}
          error={error}
          online={online}
          onUpdateGoal={handleGoal}
        />
      )}

      {page === 'profile' && (
        <Profile
          session={session}
          firebaseAuthenticated={firebaseAuthenticated}
          profile={communityProfile}
          online={online}
          busy={busy}
          error={error}
          onDeleteData={handleDeleteData}
          onSaveProfile={handleSaveProfile}
          onRegister={handleRegister}
          onLogin={handleLogin}
          onResendVerificationEmail={handleResendVerificationEmail}
          onLogout={handleLogout}
          onLinkExisting={handleLinkExisting}
        />
      )}

      {/* Floating Messenger Button */}
      {!isChatOpen && (
        <button
          type="button"
          className="floating-chat-trigger"
          onClick={() => setIsChatOpen(true)}
          aria-label="Gym Chat öffnen"
        >
          <MessageSquare size={17} />
          <span>Chat</span>
          {activeConversations.length > 0 && (
            <span className="badge-count">{activeConversations.length}</span>
          )}
        </button>
      )}

      {/* Integrated Real-Time Chat Drawer */}
      <ChatDrawer
        isOpen={isChatOpen}
        onClose={() => setIsChatOpen(false)}
        currentUserId={firebaseUserId}
        currentUserName={
          communityProfile?.firstName
            ? `${communityProfile.firstName} ${communityProfile.lastNameInitial ? `${communityProfile.lastNameInitial}.` : ''}`
            : 'Du'
        }
        activePartner={activeChatPartner}
        conversations={activeConversations}
        onSelectPartner={setActiveChatPartner}
        onNavigateToLogin={() => setPage('profile')}
      />

      <footer className="gym-footer">
        <span>DHBW Bad Mergentheim · Campus-Gym Community</span>
        <span>Smart-Polling alle 15 Sekunden aktiv · Cloud-Sync bereit</span>
      </footer>

      <div className="toast-region" aria-live="polite" aria-atomic="true">
        {toast && <div className="toast-message">{toast}</div>}
      </div>
    </AppFrame>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof GymApiError) {
    if (error.status === 0) return error.message;
    if (error.status === 409 && error.message.includes('previous password')) {
      return 'Ein bestehendes Profil mit dieser E-Mail benötigt zum Verknüpfen das bisherige App-Passwort.';
    }
    if (error.status === 409 && error.message.includes('already linked')) {
      return 'Dieses Firebase-Konto oder Profil ist bereits mit einem anderen Konto verknüpft.';
    }
    if (error.status === 409) return 'Diese Zeit hast du bereits geplant oder eine Anfrage existiert bereits.';
    if (error.status === 401)
      return error.message === 'previous account password is incorrect'
        ? 'Das bisherige App-Passwort ist nicht korrekt.'
        : 'Deine Firebase-Anmeldung ist abgelaufen oder ungültig.';
    if (error.status === 429) return 'Zu viele Versuche. Bitte warte kurz und versuche es erneut.';
    if (error.status === 400) return error.message || 'Bitte prüfe die eingegebenen Daten.';
  }
  return error instanceof Error
    ? error.message
    : 'Das hat gerade nicht funktioniert. Bitte versuche es noch einmal.';
}
