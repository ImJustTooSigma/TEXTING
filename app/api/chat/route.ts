import { createClient, SupabaseClient } from "@supabase/supabase-js";
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

type PresenceState = {
  last_seen: number;
  last_typing: number;
};

type PresenceMap = Record<Role, PresenceState>;

type MessageRow = {
  id: string;
  sender: Role;
  text: string | null;
  image_data_url: string | null;
  created_at: string;
  seen_by: string[] | null;
  reply_to_id: string | null;
  reply_sender: Role | null;
  reply_preview: string | null;
};

const MESSAGE_LIMIT = 1000;
const REPLY_PREVIEW_LIMIT = 120;
const ONLINE_WINDOW_MS = 8000;
const TYPING_WINDOW_MS = 4000;
const MESSAGE_KEEP_LIMIT = 250;

let supabaseClient: SupabaseClient | null = null;

function getSupabase() {
  if (supabaseClient) {
    return supabaseClient;
  }

  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  supabaseClient = createClient(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return supabaseClient;
}

function isRole(value: string | null | undefined): value is Role {
  return value === "me" || value === "friend";
}

function toSafeSeenBy(input: string[] | null | undefined, fallbackSender: Role): Role[] {
  const valid = Array.isArray(input)
    ? input.filter((entry): entry is Role => entry === "me" || entry === "friend")
    : [];
  if (!valid.includes(fallbackSender)) {
    valid.push(fallbackSender);
  }
  return valid;
}

function toChatMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    sender: row.sender,
    text: row.text ?? undefined,
    imageDataUrl: row.image_data_url ?? undefined,
    createdAt: new Date(row.created_at).getTime(),
    seenBy: toSafeSeenBy(row.seen_by, row.sender),
    replyToId: row.reply_to_id ?? undefined,
    replySender: row.reply_sender ?? undefined,
    replyPreview: row.reply_preview ?? undefined,
  };
}

async function loadPresenceState() {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("chat_presence")
    .select("role,last_seen,last_typing")
    .in("role", ["me", "friend"]);

  if (error) {
    throw error;
  }

  const map: PresenceMap = {
    me: { last_seen: 0, last_typing: 0 },
    friend: { last_seen: 0, last_typing: 0 },
  };

  for (const row of data ?? []) {
    if (isRole(row.role)) {
      map[row.role] = {
        last_seen: Number(row.last_seen) || 0,
        last_typing: Number(row.last_typing) || 0,
      };
    }
  }

  return map;
}

async function savePresence(role: Role, state: PresenceState) {
  const supabase = getSupabase();
  const { error } = await supabase.from("chat_presence").upsert(
    {
      role,
      last_seen: state.last_seen,
      last_typing: state.last_typing,
    },
    {
      onConflict: "role",
    },
  );

  if (error) {
    throw error;
  }
}

function buildOnlineMap(presence: PresenceMap) {
  const now = Date.now();
  return {
    me: now - presence.me.last_seen <= ONLINE_WINDOW_MS,
    friend: now - presence.friend.last_seen <= ONLINE_WINDOW_MS,
  };
}

function buildTypingMap(presence: PresenceMap) {
  const now = Date.now();
  return {
    me: now - presence.me.last_typing <= TYPING_WINDOW_MS,
    friend: now - presence.friend.last_typing <= TYPING_WINDOW_MS,
  };
}

async function loadMessages() {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("messages")
    .select("id,sender,text,image_data_url,created_at,seen_by,reply_to_id,reply_sender,reply_preview")
    .order("created_at", { ascending: false })
    .limit(MESSAGE_KEEP_LIMIT);

  if (error) {
    throw error;
  }

  const rows = ((data ?? []) as MessageRow[]).reverse();
  return rows.map(toChatMessage);
}

async function syncSeen(viewer: Role, messages: ChatMessage[]) {
  const supabase = getSupabase();
  for (const message of messages) {
    if (message.sender === viewer || message.seenBy.includes(viewer)) {
      continue;
    }

    const nextSeen = [...message.seenBy, viewer];
    const { error } = await supabase
      .from("messages")
      .update({ seen_by: nextSeen })
      .eq("id", message.id);

    if (!error) {
      message.seenBy = nextSeen;
    }
  }
}

async function trimMessagesIfNeeded() {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("messages")
    .select("id")
    .order("created_at", { ascending: false })
    .range(MESSAGE_KEEP_LIMIT, MESSAGE_KEEP_LIMIT + 500);

  if (error) {
    throw error;
  }

  const staleIds = (data ?? []).map((row) => row.id);
  if (staleIds.length === 0) {
    return;
  }

  const { error: deleteError } = await supabase.from("messages").delete().in("id", staleIds);
  if (deleteError) {
    throw deleteError;
  }
}

async function buildResponse(viewer?: Role) {
  const presence = await loadPresenceState();

  if (viewer) {
    presence[viewer].last_seen = Date.now();
    await savePresence(viewer, presence[viewer]);
  }

  const messages = await loadMessages();
  if (viewer) {
    await syncSeen(viewer, messages);
  }

  return {
    messages,
    online: buildOnlineMap(presence),
    typing: buildTypingMap(presence),
  };
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const viewerParam = url.searchParams.get("viewer");
    const viewer = isRole(viewerParam) ? viewerParam : undefined;

    return NextResponse.json(await buildResponse(viewer));
  } catch (error) {
    console.error("GET /api/chat failed", error);
    return NextResponse.json({ error: "Failed to fetch chat" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
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
      return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
    }

    const supabase = getSupabase();

    let replySender: Role | undefined;
    let replyPreview: string | undefined;

    if (body.replyToId) {
      const { data: source } = await supabase
        .from("messages")
        .select("sender,text")
        .eq("id", body.replyToId)
        .maybeSingle();

      if (source?.sender && isRole(source.sender)) {
        replySender = source.sender;
        replyPreview = source.text
          ? String(source.text).slice(0, REPLY_PREVIEW_LIMIT)
          : "Photo";
      }
    }

    const nowIso = new Date().toISOString();
    const insertPayload = {
      id: crypto.randomUUID(),
      sender,
      text: text ? text.slice(0, MESSAGE_LIMIT) : null,
      image_data_url: hasImage ? imageDataUrl : null,
      created_at: nowIso,
      seen_by: [sender],
      reply_to_id: body.replyToId ?? null,
      reply_sender: replySender ?? null,
      reply_preview: replyPreview ?? null,
    };

    const { error: insertError } = await supabase.from("messages").insert(insertPayload);
    if (insertError) {
      throw insertError;
    }

    const presence = await loadPresenceState();
    presence[sender].last_seen = Date.now();
    presence[sender].last_typing = 0;
    await savePresence(sender, presence[sender]);

    await trimMessagesIfNeeded();

    return NextResponse.json(await buildResponse());
  } catch (error) {
    console.error("POST /api/chat failed", error);
    return NextResponse.json({ error: "Failed to send message" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const supabase = getSupabase();
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    const clear = url.searchParams.get("clear");

    if (clear === "true") {
      const { error } = await supabase.from("messages").delete().not("id", "is", null);
      if (error) {
        throw error;
      }
      return NextResponse.json(await buildResponse());
    }

    if (!id) {
      return NextResponse.json({ error: "Missing id" }, { status: 400 });
    }

    const { error } = await supabase.from("messages").delete().eq("id", id);
    if (error) {
      throw error;
    }

    return NextResponse.json(await buildResponse());
  } catch (error) {
    console.error("DELETE /api/chat failed", error);
    return NextResponse.json({ error: "Failed to delete message" }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const body = (await request.json()) as { role?: Role; isTyping?: boolean };
    const role = body.role;

    if (role !== "me" && role !== "friend") {
      return NextResponse.json({ error: "Invalid role" }, { status: 400 });
    }

    const presence = await loadPresenceState();
    presence[role].last_seen = Date.now();
    presence[role].last_typing = body.isTyping ? Date.now() : 0;
    await savePresence(role, presence[role]);

    return NextResponse.json(await buildResponse());
  } catch (error) {
    console.error("PATCH /api/chat failed", error);
    return NextResponse.json({ error: "Failed to update typing" }, { status: 500 });
  }
}
