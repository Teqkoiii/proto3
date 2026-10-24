import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Check,
  Dumbbell,
  MessageSquare,
  Minimize2,
  Send,
  Sparkles,
  Users,
  X,
} from 'lucide-react';
import {
  sendChatMessage,
  subscribeToMessages,
  type CloudChatMessage,
  type CloudConversation,
} from '../../services/communityChatService';
import { gymRepository, type CommunityMember } from '../../services/gymRepository';

const QUICK_PROMPTS = [
  'Bin in 10 Min da! 💪',
  'Heute Brust & Trizeps?',
  'Lust auf eine gemeinsame Session?',
  'Super, bis gleich im Gym!',
];

export function ChatDrawer({
  isOpen,
  onClose,
  currentUserId,
  currentUserName,
  activePartner,
  conversations,
  onSelectPartner,
  onNavigateToLogin,
}: {
  isOpen: boolean;
  onClose: () => void;
  currentUserId: string;
  currentUserName: string;
  activePartner: CommunityMember | null;
  conversations: CloudConversation[];
  onSelectPartner: (partner: CommunityMember | null) => void;
  onNavigateToLogin: () => void;
}) {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [otherParticipantUid, setOtherParticipantUid] = useState<string | undefined>();
  const [messages, setMessages] = useState<CloudChatMessage[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Initialize or fetch conversation when activePartner changes
  useEffect(() => {
    let active = true;
    if (!activePartner || !currentUserId) {
      setConversationId(null);
      setOtherParticipantUid(undefined);
      setMessages([]);
      return;
    }

    setConversationId(null);
    setOtherParticipantUid(undefined);
    setMessages([]);
    const existing = conversations.find((conversation) => (
      conversation.participantIds.includes(currentUserId) &&
      conversation.participantIds.includes(activePartner.id)
    ));
    if (existing) {
      setConversationId(existing.id);
      setOtherParticipantUid(activePartner.id);
    } else {
      void gymRepository.createCommunityConversation(activePartner.id).then(
        ({ conversationId: convId, otherParticipantUid: partnerUid }) => {
          if (active) {
            setConversationId(convId);
            setOtherParticipantUid(partnerUid);
          }
        },
      ).catch((error: unknown) => {
        if (active) {
          console.error('Unable to open community chat', error);
          setConversationId(null);
          setOtherParticipantUid(undefined);
        }
      });
    }

    return () => {
      active = false;
    };
  }, [activePartner, currentUserId]);

  // Subscribe to real-time messages
  useEffect(() => {
    if (!conversationId) return;
    const unsub = subscribeToMessages(conversationId, (msgs) => {
      setMessages(msgs);
    });
    return () => unsub();
  }, [conversationId]);

  // Scroll to bottom on new message
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  if (!isOpen) return null;

  const handleSend = async (customText?: string) => {
    const toSend = customText || text;
    if (!toSend.trim() || !conversationId || sending) return;

    setSending(true);
    try {
      await sendChatMessage(
        conversationId,
        currentUserId,
        currentUserName,
        toSend.trim(),
        otherParticipantUid,
      );
      if (!customText) setText('');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="chat-drawer-container surface" role="dialog" aria-label="Gym Chat">
      {/* Header */}
      <div className="chat-drawer-header">
        <div className="flex items-center gap-2">
          {activePartner && (
            <button
              type="button"
              className="icon-button"
              onClick={() => onSelectPartner(null)}
              aria-label="Zurück zur Chat-Übersicht"
            >
              <ArrowLeft size={16} />
            </button>
          )}
          <div className="chat-header-avatar" aria-hidden="true">
            {activePartner ? (
              `${activePartner.firstName[0] || ''}${activePartner.lastNameInitial || ''}`
            ) : (
              <MessageSquare size={16} />
            )}
          </div>
          <div>
            <h3 className="chat-header-title">
              {activePartner
                ? `${activePartner.firstName} ${activePartner.lastNameInitial}.`
                : 'Gym Community Chat'}
            </h3>
            <p className="chat-header-subtitle">
              {activePartner
                ? activePartner.activeNow
                  ? '🟢 Jetzt im Gym'
                  : activePartner.courseOfStudy || 'DHBW Bad Mergentheim'
                : 'Echtzeit-Nachrichten'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Chat schließen"
          >
            <X size={17} />
          </button>
        </div>
      </div>

      {/* Body: Login prompt, Conversation List or Messages */}
      {!currentUserId ? (
        <div className="chat-login-prompt">
          <MessageSquare size={36} className="chat-login-icon" />
          <h4 className="chat-login-title">Live-Chat & Cloud-Sync</h4>
          <p className="chat-login-desc">
            Melde dich mit deinem verifizierten DHBW-Konto an, um in Echtzeit mit deinen Trainingspartnern am Campus Bad Mergentheim zu chatten.
          </p>
          <button
            type="button"
            className="button button-primary compact-button mt-4"
            onClick={onNavigateToLogin}
          >
            Zum DHBW-Login
          </button>
        </div>
      ) : !activePartner ? (
        <div className="chat-conversations-list">
          <p className="text-xs text-slate-400 px-4 pt-3 pb-1">
            Wähle einen Trainingspartner aus der Community oder antworte auf bestehende Nachrichten:
          </p>

          {conversations.length === 0 ? (
            <div className="p-6 text-center text-xs text-slate-400">
              <MessageSquare size={28} className="mx-auto mb-2 text-slate-500 opacity-60" />
              <p>Noch keine Unterhaltungen.</p>
              <p className="mt-1 text-slate-500">
                Klicke in der Community auf "Nachricht" bei einem Partner, um einen Chat zu starten!
              </p>
            </div>
          ) : (
            <ul className="chat-conv-items">
              {conversations.map((c) => {
                const otherUid = c.participantIds.find((id) => id !== currentUserId) || '';
                const otherName = c.participantNames?.[otherUid] || 'Trainingspartner';
                return (
                  <li
                    key={c.id}
                    className="chat-conv-row"
                    onClick={() => {
                      onSelectPartner({
                        id: otherUid,
                        firstName: otherName.split(' ')[0] || otherName,
                        lastNameInitial: otherName.split(' ')[1]?.replace('.', '') || '',
                        courseOfStudy: 'DHBW Bad Mergentheim',
                        trainingGoals: [],
                        preferredTimes: [],
                        interests: [],
                        bio: '',
                        isPublicPresence: true,
                        activeNow: false,
                        plannedNext: null,
                        isSelf: false,
                      });
                    }}
                  >
                    <div className="chat-header-avatar">
                      {otherName.slice(0, 2).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <strong className="text-xs font-semibold text-slate-200 truncate">
                          {otherName}
                        </strong>
                        {c.lastMessageAt && (
                          <span className="text-[10px] text-slate-500">
                            {new Date(c.lastMessageAt).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-slate-400 truncate mt-0.5">
                        {c.lastMessageText || 'Chat starten...'}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : (
        <div className="chat-messages-area">
          <div className="chat-messages-scroll">
            {messages.length === 0 ? (
              <div className="p-4 text-center text-xs text-slate-400 my-auto">
                <Dumbbell size={22} className="mx-auto mb-2 text-cyan-400 opacity-80" />
                <p>Beginne die Unterhaltung mit {activePartner.firstName}!</p>
                <p className="text-[11px] text-slate-500 mt-1">
                  Mache einen Terminvorschlag oder frage nach dem heutigen Trainingsplan.
                </p>
              </div>
            ) : (
              messages.map((m) => {
                const isMe = m.senderId === currentUserId;
                return (
                  <div
                    key={m.id}
                    className={`chat-bubble-wrapper ${isMe ? 'is-self' : 'is-partner'}`}
                  >
                    {!isMe && <span className="chat-bubble-sender">{m.senderName}</span>}
                    <div className={`chat-bubble ${isMe ? 'bubble-self' : 'bubble-partner'}`}>
                      <p className="chat-bubble-text">{m.text}</p>
                      <span className="chat-bubble-time">
                        {new Date(m.createdAt).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </div>
                  </div>
                );
              })
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Quick reply chips */}
          <div className="chat-quick-prompts">
            {QUICK_PROMPTS.map((p) => (
              <button
                key={p}
                type="button"
                className="chat-prompt-chip"
                onClick={() => void handleSend(p)}
                disabled={sending}
              >
                {p}
              </button>
            ))}
          </div>

          {/* Input Bar */}
          <form
            className="chat-input-bar"
            onSubmit={(e) => {
              e.preventDefault();
              void handleSend();
            }}
          >
            <input
              type="text"
              className="chat-text-input"
              placeholder={`Nachricht an ${activePartner.firstName} schreiben...`}
              value={text}
              maxLength={500}
              onChange={(e) => setText(e.target.value)}
            />
            <button
              type="submit"
              className="chat-send-button"
              disabled={!text.trim() || sending}
              aria-label="Nachricht senden"
            >
              <Send size={15} />
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
