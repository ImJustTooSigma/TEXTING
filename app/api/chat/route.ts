import { NextResponse } from "next/server";

type Role = "me" | "friend";

type ChatMessage = {
  id: string;
  sender: Role;
  text?: string;
  imageDataUrl?: string;
  createdAt: number;
  seenBy: Role[];
  replyToId?: string;
  replySender?: Role;
  replyPreview?: string;
};

type PresenceMap = Record<Role, number>;
type TypingMap = Record<Role, number>;

const MESSAGE_LIMIT = 1000;
const REPLY_PREVIEW_LIMIT = 120;
const ONLINE_WINDOW_MS = 8000;
const TYPING_WINDOW_MS = 4000;

const messageStore = globalThis as typeof globalThis & {
  __privateOneChat?: ChatMessage[];
  __privatePresence?: PresenceMap;
  __privateTyping?: TypingMap;
};

function getMessages() {
  if (!messageStore.__privateOneChat) {
    messageStore.__privateOneChat = [];
  }

  // Backward compatibility: old in-memory messages may miss seenBy/reply fields.
  messageStore.__privateOneChat = messageStore.__privateOneChat.map((message) => {
    const safeSeenBy =
      Array.isArray(message.seenBy) &&
      message.seenBy.every((entry) => entry === "me" || entry === "friend")
        ? message.seenBy
        : [message.sender];

    return {
      ...message,
      seenBy: safeSeenBy,
      replyToId: message.replyToId,
      replySender: message.replySender,
      replyPreview: message.replyPreview,
    };
  });

  return messageStore.__privateOneChat;
}

function getPresence() {
  if (!messageStore.__privatePresence) {
    messageStore.__privatePresence = {
      me: 0,
      friend: 0,
    };
  }
  return messageStore.__privatePresence;
}

function getTyping() {
  if (!messageStore.__privateTyping) {
    messageStore.__privateTyping = {
      me: 0,
      friend: 0,
    };
  }
  return messageStore.__privateTyping;
}

function getOnlineMap() {
  const now = Date.now();
  const presence = getPresence();
  return {
    me: now - presence.me <= ONLINE_WINDOW_MS,
    friend: now - presence.friend <= ONLINE_WINDOW_MS,
  };
}

function getTypingMap() {
  const now = Date.now();
  const typing = getTyping();
  return {
    me: now - typing.me <= TYPING_WINDOW_MS,
    friend: now - typing.friend <= TYPING_WINDOW_MS,
  };
}

function isRole(value: string | null): value is Role {
  return value === "me" || value === "friend";
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const viewerParam = url.searchParams.get("viewer");
  const viewer = isRole(viewerParam) ? viewerParam : null;

  if (viewer) {
    getPresence()[viewer] = Date.now();

    for (const message of getMessages()) {
      if (message.sender !== viewer && !message.seenBy.includes(viewer)) {
        message.seenBy.push(viewer);
      }
    }
  }

  return NextResponse.json({
    messages: getMessages(),
    online: getOnlineMap(),
    typing: getTypingMap(),
  });
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    sender?: Role;
    text?: string;
    imageDataUrl?: string;
    replyToId?: string;
  };
  const sender = body.sender;
  const text = body.text?.trim() ?? "";
  const imageDataUrl = body.imageDataUrl?.trim() ?? "";
  const hasImage = imageDataUrl.startsWith("data:image/");

  if ((sender !== "me" && sender !== "friend") || (!text && !hasImage)) {
    return NextResponse.json(
      { error: "Invalid payload" },
      {
        status: 400,
      },
    );
  }

  let replySender: Role | undefined;
  let replyPreview: string | undefined;

  if (body.replyToId) {
    const source = getMessages().find((message) => message.id === body.replyToId);
    if (source) {
      replySender = source.sender;
      replyPreview = source.text
        ? source.text.slice(0, REPLY_PREVIEW_LIMIT)
        : "Photo";
    }
  }

  const next: ChatMessage = {
    id: crypto.randomUUID(),
    sender,
    text: text ? text.slice(0, MESSAGE_LIMIT) : undefined,
    imageDataUrl: hasImage ? imageDataUrl : undefined,
    createdAt: Date.now(),
    seenBy: [sender],
    replyToId: body.replyToId,
    replySender,
    replyPreview,
  };

  const messages = getMessages();
  messages.push(next);
  messageStore.__privateOneChat = messages.slice(-250);
  getPresence()[sender] = Date.now();
  getTyping()[sender] = 0;

  return NextResponse.json({
    messages: getMessages(),
    online: getOnlineMap(),
    typing: getTypingMap(),
  });
}

export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  const clear = url.searchParams.get("clear");

  if (clear === "true") {
    messageStore.__privateOneChat = [];
    return NextResponse.json({ messages: [], online: getOnlineMap(), typing: getTypingMap() });
  }

  if (!id) {
    return NextResponse.json(
      { error: "Missing id" },
      {
        status: 400,
      },
    );
  }

  messageStore.__privateOneChat = getMessages().filter((message) => message.id !== id);
  return NextResponse.json({
    messages: getMessages(),
    online: getOnlineMap(),
    typing: getTypingMap(),
  });
}

export async function PATCH(request: Request) {
  const body = (await request.json()) as { role?: Role; isTyping?: boolean };
  const role = body.role;
  if (role !== "me" && role !== "friend") {
    return NextResponse.json(
      { error: "Invalid role" },
      {
        status: 400,
      },
    );
  }

  getPresence()[role] = Date.now();
  getTyping()[role] = body.isTyping ? Date.now() : 0;

  return NextResponse.json({
    messages: getMessages(),
    online: getOnlineMap(),
    typing: getTypingMap(),
  });
}
