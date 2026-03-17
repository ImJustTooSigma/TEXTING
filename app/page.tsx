"use client";

import {
  ChangeEvent,
  FormEvent,
  PointerEvent,
  ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

type Role = "me" | "friend";

type ChatMessage = {
  id: string;
  sender: Role;
  text?: string;
  imageDataUrl?: string;
  createdAt: number;
  seenBy?: Role[];
  replyToId?: string;
  replySender?: Role;
  replyPreview?: string;
};

type OnlineMap = Record<Role, boolean>;
type TypingMap = Record<Role, boolean>;

const LOGIN_STORAGE_KEY = "private-chat-role";
const NAME_BY_ROLE: Record<Role, string> = {
  me: "Rui Yang",
  friend: "Chloe",
};

function linkify(text: string): ReactNode[] {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const singleUrlRegex = /^https?:\/\/[^\s]+$/;
  const parts = text.split(urlRegex);
  return parts.map((part, index) => {
    if (singleUrlRegex.test(part)) {
      return (
        <a key={`${part}-${index}`} href={part} target="_blank" rel="noreferrer">
          {part}
        </a>
      );
    }
    return <span key={`${part}-${index}`}>{part}</span>;
  });
}

function formatStatus(online: boolean) {
  return online ? "ONLINE" : "OFFLINE";
}

export default function Home() {
  const [role, setRole] = useState<Role | null>(null);
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [online, setOnline] = useState<OnlineMap>({ me: false, friend: false });
  const [typing, setTyping] = useState<TypingMap>({ me: false, friend: false });
  const [draft, setDraft] = useState("");
  const [pendingImage, setPendingImage] = useState<string | null>(null);
  const [replyTarget, setReplyTarget] = useState<ChatMessage | null>(null);
  const [swipeOffsets, setSwipeOffsets] = useState<Record<string, number>>({});
  const [activeSwipeId, setActiveSwipeId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [notificationPermission, setNotificationPermission] =
    useState<NotificationPermission>("default");
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const knownIdsRef = useRef<Set<string>>(new Set());
  const firstLoadRef = useRef(true);
  const swipeSessionRef = useRef<{
    messageId: string;
    startX: number;
    startY: number;
    horizontalLocked: boolean;
  } | null>(null);
  const SWIPE_REPLY_TRIGGER = 72;
  const SWIPE_MAX_OFFSET = 98;
  const typingSentRef = useRef(false);

  useEffect(() => {
    const storedRole = window.localStorage.getItem(LOGIN_STORAGE_KEY);
    if (storedRole === "me" || storedRole === "friend") {
      setRole(storedRole);
    }
  }, []);

  useEffect(() => {
    if (!role) {
      return;
    }

    let isAlive = true;
    const refresh = async () => {
      try {
        const response = await fetch(`/api/chat?viewer=${role}`, { cache: "no-store" });
        if (!response.ok) {
          return;
        }
        const data = (await response.json()) as {
          messages?: ChatMessage[];
          online?: OnlineMap;
          typing?: TypingMap;
        };
        if (!isAlive) {
          return;
        }
        if (Array.isArray(data.messages)) {
          setMessages(data.messages);
        }
        if (data.online) {
          setOnline(data.online);
        }
        if (data.typing) {
          setTyping(data.typing);
        }
      } catch {
        // Keep existing UI state on transient sync errors.
      }
    };

    void refresh();

    const interval = window.setInterval(() => {
      void refresh();
    }, 1500);

    return () => {
      isAlive = false;
      window.clearInterval(interval);
    };
  }, [role]);

  useEffect(() => {
    if (!role) {
      return;
    }

    const draftHasText = draft.trim().length > 0;
    const postTyping = async (isTyping: boolean) => {
      try {
        const response = await fetch("/api/chat", {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            role,
            isTyping,
          }),
        });
        if (!response.ok) {
          return;
        }
        const data = (await response.json()) as { typing?: TypingMap };
        if (data.typing) {
          setTyping(data.typing);
        }
      } catch {
        // Ignore typing heartbeat failure.
      }
    };

    if (draftHasText) {
      typingSentRef.current = true;
      void postTyping(true);
      const interval = window.setInterval(() => {
        void postTyping(true);
      }, 2500);
      return () => {
        window.clearInterval(interval);
      };
    }

    if (typingSentRef.current) {
      typingSentRef.current = false;
      void postTyping(false);
    }
  }, [role, draft]);

  useEffect(() => {
    if (!role || messages.length === 0) {
      return;
    }

    if (firstLoadRef.current) {
      for (const message of messages) {
        knownIdsRef.current.add(message.id);
      }
      firstLoadRef.current = false;
      return;
    }

    for (const message of messages) {
      if (knownIdsRef.current.has(message.id)) {
        continue;
      }
      knownIdsRef.current.add(message.id);
      if (message.sender !== role && notificationPermission === "granted") {
        new Notification(`New message from ${NAME_BY_ROLE[message.sender]}`, {
          body: message.text ?? "Sent an image",
        });
      }
    }
  }, [messages, role, notificationPermission]);

  useEffect(() => {
    viewportRef.current?.scrollTo({
      top: viewportRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  useEffect(() => {
    if (typeof window !== "undefined" && "Notification" in window) {
      setNotificationPermission(Notification.permission);
    }
  }, []);

  const handleLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoginError("");
    try {
      const response = await fetch("/api/auth", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ password }),
      });

      if (!response.ok) {
        setLoginError("Wrong password.");
        return;
      }

      const data = (await response.json()) as { role: Role };
      setRole(data.role);
      window.localStorage.setItem(LOGIN_STORAGE_KEY, data.role);
      setPassword("");
      await enableNotifications();
    } catch {
      setLoginError("Login failed. Try again.");
    }
  };

  const sendMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!role || (!draft.trim() && !pendingImage)) {
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sender: role,
          text: draft.trim(),
          imageDataUrl: pendingImage,
          replyToId: replyTarget?.id,
        }),
      });

      if (response.ok) {
        setDraft("");
        setPendingImage(null);
        setReplyTarget(null);
        if (fileInputRef.current) {
          fileInputRef.current.value = "";
        }
        const data = (await response.json()) as {
          messages: ChatMessage[];
          online: OnlineMap;
          typing?: TypingMap;
        };
        setMessages(data.messages);
        setOnline(data.online);
        if (data.typing) {
          setTyping(data.typing);
        }
      }
    } finally {
      setSubmitting(false);
    }
  };

  const enableNotifications = async () => {
    if (!("Notification" in window)) {
      return;
    }
    const permission = await Notification.requestPermission();
    setNotificationPermission(permission);
    if (permission === "denied") {
      alert(
        "Notifications are blocked by the browser. Please open site settings and allow notifications.",
      );
    }
  };

  const onSelectImage = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file || !file.type.startsWith("image/")) {
      setPendingImage(null);
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === "string") {
        setPendingImage(result);
      }
    };
    reader.readAsDataURL(file);
  };

  const deleteMessage = async (id: string) => {
    const ok = window.confirm("Delete this message?");
    if (!ok) {
      return;
    }

    const response = await fetch(`/api/chat?id=${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      return;
    }
    const data = (await response.json()) as {
      messages: ChatMessage[];
      online: OnlineMap;
      typing?: TypingMap;
    };
    setMessages(data.messages);
    setOnline(data.online);
    if (data.typing) {
      setTyping(data.typing);
    }
  };

  const clearChat = async () => {
    const ok = window.confirm("Clear all chat history?");
    if (!ok) {
      return;
    }

    const response = await fetch("/api/chat?clear=true", {
      method: "DELETE",
    });
    if (!response.ok) {
      return;
    }
    const data = (await response.json()) as {
      messages: ChatMessage[];
      online: OnlineMap;
      typing?: TypingMap;
    };
    setMessages(data.messages);
    setOnline(data.online);
    if (data.typing) {
      setTyping(data.typing);
    }
    knownIdsRef.current = new Set();
    firstLoadRef.current = true;
  };

  const onSwipeStart = (messageId: string, event: PointerEvent<HTMLElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }
    swipeSessionRef.current = {
      messageId,
      startX: event.clientX,
      startY: event.clientY,
      horizontalLocked: false,
    };
    setActiveSwipeId(messageId);
  };

  const onSwipeMove = (message: ChatMessage, event: PointerEvent<HTMLElement>) => {
    const swipeSession = swipeSessionRef.current;
    if (!swipeSession || swipeSession.messageId !== message.id) {
      return;
    }

    const deltaX = event.clientX - swipeSession.startX;
    const deltaY = event.clientY - swipeSession.startY;

    if (!swipeSession.horizontalLocked) {
      if (Math.abs(deltaX) < 8 && Math.abs(deltaY) < 8) {
        return;
      }
      swipeSession.horizontalLocked = Math.abs(deltaX) >= Math.abs(deltaY);
      if (!swipeSession.horizontalLocked) {
        return;
      }
    }

    const offset = Math.max(0, Math.min(SWIPE_MAX_OFFSET, deltaX));
    setSwipeOffsets((previous) =>
      previous[message.id] === offset ? previous : { ...previous, [message.id]: offset },
    );
  };

  const onSwipeEnd = (message: ChatMessage) => {
    const offset = swipeOffsets[message.id] ?? 0;
    if (offset >= SWIPE_REPLY_TRIGGER) {
      setReplyTarget(message);
    }
    setSwipeOffsets((previous) => ({ ...previous, [message.id]: 0 }));
    setActiveSwipeId(null);
    swipeSessionRef.current = null;
  };

  const logout = () => {
    typingSentRef.current = false;
    window.localStorage.removeItem(LOGIN_STORAGE_KEY);
    setRole(null);
    setMessages([]);
    setOnline({ me: false, friend: false });
    setTyping({ me: false, friend: false });
    setReplyTarget(null);
    knownIdsRef.current = new Set();
    firstLoadRef.current = true;
  };

  if (!role) {
    return (
      <main className="auth-screen">
        <section className="auth-card">
          <h1>Private Chat</h1>
          <p>Enter your role password to join this one-on-one chat.</p>
          <form onSubmit={handleLogin}>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Password"
              required
            />
            <button type="submit">Enter Chat</button>
          </form>
          {loginError ? <span className="auth-error">{loginError}</span> : null}
        </section>
      </main>
    );
  }

  const otherRole: Role = role === "me" ? "friend" : "me";
  const otherTyping = typing[otherRole] && online[otherRole];

  return (
    <main className="chat-screen">
      <section className="chat-shell">
        <header className="chat-header">
          <div className="chat-title">
            <div className="chat-avatar">{NAME_BY_ROLE[otherRole].charAt(0)}</div>
            <div>
              <h1>{NAME_BY_ROLE[otherRole]}</h1>
              <p className={otherTyping ? "typing-indicator" : ""}>
                {otherTyping ? "typing..." : "Swipe right on any message to reply."}
              </p>
            </div>
          </div>
          <div className="header-right">
            <p className="presence-line">
              <span className={online.me ? "presence-on" : "presence-off"}>
                Rui Yang {formatStatus(online.me)}
              </span>
              <span> · </span>
              <span className={online.friend ? "presence-on" : "presence-off"}>
                Chloe {formatStatus(online.friend)}
              </span>
            </p>
            <div className="chat-actions">
              <button type="button" className="secondary-btn" onClick={enableNotifications}>
                Allow Notifications
              </button>
              <button type="button" className="secondary-btn" onClick={clearChat}>
                Clear Chat
              </button>
              <button type="button" className="logout-btn" onClick={logout}>
                Logout
              </button>
            </div>
          </div>
        </header>

        <div className="message-list" ref={viewportRef}>
          {messages.map((message) => {
            const mine = message.sender === role;
            const meSender = message.sender === "me";
            const recipient: Role = message.sender === "me" ? "friend" : "me";
            const saw = Array.isArray(message.seenBy)
              ? message.seenBy.includes(recipient)
              : false;
            const statusLabel = saw ? "Saw" : "Delivered";
            return (
              <article
                key={message.id}
                className={`message-row ${mine ? "mine" : "theirs"}`}
              >
                <div className="swipe-track">
                  <div className={`reply-indicator ${(swipeOffsets[message.id] ?? 0) > 16 ? "visible" : ""}`}>
                    ↩
                  </div>
                  <div
                    className={`swipe-content ${
                      activeSwipeId === message.id ? "swiping" : ""
                    }`}
                    style={{ transform: `translateX(${swipeOffsets[message.id] ?? 0}px)` }}
                    onPointerDown={(event) => onSwipeStart(message.id, event)}
                    onPointerMove={(event) => onSwipeMove(message, event)}
                    onPointerUp={() => onSwipeEnd(message)}
                    onPointerCancel={() => onSwipeEnd(message)}
                  >
                    <div className="message-main">
                      <div className={`bubble ${meSender ? "bubble-me" : "bubble-friend"}`}>
                        {message.replyToId ? (
                          <div className="reply-chip">
                            <strong>{message.replySender ? NAME_BY_ROLE[message.replySender] : "Reply"}</strong>
                            <span>{message.replyPreview ?? "Message"}</span>
                          </div>
                        ) : null}
                        {message.text ? <p>{linkify(message.text)}</p> : null}
                        {message.imageDataUrl ? (
                          <img
                            className="message-image"
                            src={message.imageDataUrl}
                            alt="Attached image"
                          />
                        ) : null}
                      </div>
                      <div className={`bubble-meta ${mine ? "meta-mine" : "meta-theirs"}`}>
                        <span className="meta-time">
                          {new Date(message.createdAt).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                        {mine ? <span className="meta-status">{statusLabel}</span> : null}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="delete-msg-btn"
                      aria-label="Delete message"
                      onClick={() => {
                        void deleteMessage(message.id);
                      }}
                    >
                      🗑
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>

        <form className="composer" onSubmit={sendMessage}>
          {replyTarget ? (
            <div className="reply-banner">
              <div>
                <strong>Replying to {NAME_BY_ROLE[replyTarget.sender]}</strong>
                <p>{replyTarget.text ?? "Image"}</p>
              </div>
              <button
                type="button"
                className="cancel-reply-btn"
                onClick={() => setReplyTarget(null)}
              >
                Cancel
              </button>
            </div>
          ) : null}
          <input
            type="text"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Type a message"
            maxLength={1000}
          />
          <label className="attach-btn">
            Attach
            <input ref={fileInputRef} type="file" accept="image/*" onChange={onSelectImage} />
          </label>
          {pendingImage ? <span className="attach-ready">Image ready</span> : null}
          <button type="submit" disabled={submitting}>
            Send
          </button>
        </form>
      </section>
    </main>
  );
}
