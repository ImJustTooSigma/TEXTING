import { NextResponse } from "next/server";

type Role = "me" | "friend";

const PASSWORDS: Record<Role, string> = {
  me: process.env.CHAT_PASSWORD_ME ?? "",
  friend: process.env.CHAT_PASSWORD_CHLOE ?? "",
};

export async function POST(request: Request) {
  const body = (await request.json()) as { password?: string };
  const password = body.password ?? "";

  if (password === PASSWORDS.me) {
    return NextResponse.json({ role: "me" as const });
  }

  if (password === PASSWORDS.friend) {
    return NextResponse.json({ role: "friend" as const });
  }

  return NextResponse.json(
    { error: "Invalid password" },
    {
      status: 401,
    },
  );
}
