import { useEffect, useRef, useState } from 'react';
import {
  Bell,
  Calendar,
  CheckCheck,
  Dumbbell,
  MessageSquare,
  Sparkles,
  UserCheck,
  X,
} from 'lucide-react';
import type { CloudNotification } from '../../services/communityChatService';
import type { GymPage } from './components';

export function NotificationCenter({
  notifications,
  isCloudConnected = false,
  onMarkRead,
  onMarkAllRead,
  onTriggerTestSlotReminder,
  onNavigate,
  onOpenChat,
}: {
  notifications: CloudNotification[];
  isCloudConnected?: boolean;
  onMarkRead: (id: string) => void;
  onMarkAllRead: () => void;
  onTriggerTestSlotReminder: () => void;
  onNavigate: (page: GymPage) => void;
  onOpenChat?: (partnerId: string, partnerName: string) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const unreadCount = notifications.filter((n) => !n.read).length;

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const handleAction = (n: CloudNotification) => {
    onMarkRead(n.id);
    setIsOpen(false);
    if (n.type === 'partner_request' || n.type === 'partner_accepted') {
      onNavigate('community');
    } else if (n.type === 'slot_reminder') {
      onNavigate('calendar');
    } else if (n.type === 'new_message') {
      onNavigate('community');
    }
  };

  return (
    <div className="relative inline-block" ref={containerRef}>
      <button
        type="button"
        className="notification-trigger-button"
        onClick={() => setIsOpen((prev) => !prev)}
        aria-label={`Benachrichtigungen (${unreadCount} ungelesen)`}
        title="Benachrichtigungen & Slot-Erinnerungen"
      >
        <Bell size={18} aria-hidden="true" />
        {unreadCount > 0 && (
          <span className="notification-badge" aria-hidden="true">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {isOpen && (
        <div className="surface notification-popover" role="dialog" aria-label="Benachrichtigungscenter">
          <div className="notification-header">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-slate-100 text-sm">Benachrichtigungen</span>
              {unreadCount > 0 && (
                <span className="notification-pill-count">{unreadCount} neu</span>
              )}
            </div>
            <div className="flex items-center gap-1">
              {unreadCount > 0 && (
                <button
                  type="button"
                  className="notification-header-action"
                  onClick={onMarkAllRead}
                  title="Alle als gelesen markieren"
                >
                  <CheckCheck size={14} />
                  <span>Alle lesen</span>
                </button>
              )}
              <button
                type="button"
                className="icon-button"
                onClick={() => setIsOpen(false)}
                aria-label="Schließen"
              >
                <X size={15} />
              </button>
            </div>
          </div>

          {!isCloudConnected && (
            <div className="notification-cloud-banner">
              <span>Für Cloud-Sync mit deinem DHBW-Konto anmelden.</span>
              <button
                type="button"
                className="cloud-login-btn"
                onClick={() => {
                  setIsOpen(false);
                  onNavigate('profile');
                }}
              >
                Zum Profil
              </button>
            </div>
          )}

          {/* Quick Slot Test Action */}
          <div className="notification-quick-test">
            <button
              type="button"
              className="test-reminder-button"
              onClick={() => {
                onTriggerTestSlotReminder();
              }}
            >
              <Sparkles size={13} className="text-amber-400" />
              <span>Slot-Erinnerung simulieren</span>
            </button>
          </div>

          <div className="notification-list">
            {notifications.length === 0 ? (
              <div className="p-5 text-center text-xs text-slate-400">
                <Dumbbell size={24} className="mx-auto mb-2 text-slate-500 opacity-60" />
                <p>Keine neuen Benachrichtigungen.</p>
                <p className="mt-1 text-slate-500 text-[11px]">
                  Hier erhältst du Updates zu Partner-Anfragen, Chat-Nachrichten und Slot-Erinnerungen.
                </p>
              </div>
            ) : (
              notifications.map((n) => {
                const icon =
                  n.type === 'slot_reminder' ? (
                    <Calendar size={15} className="text-cyan-400" />
                  ) : n.type === 'new_message' ? (
                    <MessageSquare size={15} className="text-red-400" />
                  ) : n.type === 'partner_accepted' ? (
                    <UserCheck size={15} className="text-violet-400" />
                  ) : (
                    <Bell size={15} className="text-amber-400" />
                  );

                return (
                  <div
                    key={n.id}
                    className={`notification-item ${n.read ? 'is-read' : 'is-unread'}`}
                    onClick={() => handleAction(n)}
                  >
                    <div className="notification-icon-wrapper">{icon}</div>
                    <div className="notification-body">
                      <div className="flex items-center justify-between gap-1">
                        <strong className="notification-title">{n.title}</strong>
                        {!n.read && <span className="notification-unread-dot" />}
                      </div>
                      <p className="notification-text">{n.message}</p>
                      <span className="notification-time">
                        {new Date(n.createdAt).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
