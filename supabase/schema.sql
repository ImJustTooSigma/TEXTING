-- Run this in Supabase SQL Editor once.

create table if not exists public.messages (
  id uuid primary key,
  sender text not null check (sender in ('me', 'friend')),
  text text,
  image_data_url text,
  created_at timestamptz not null default now(),
  seen_by text[] not null default '{}',
  reply_to_id uuid,
  reply_sender text check (reply_sender in ('me', 'friend')),
  reply_preview text
);

create index if not exists messages_created_at_idx on public.messages (created_at desc);

create table if not exists public.chat_presence (
  role text primary key check (role in ('me', 'friend')),
  last_seen bigint not null default 0,
  last_typing bigint not null default 0,
  updated_at timestamptz not null default now()
);

insert into public.chat_presence (role, last_seen, last_typing)
values
  ('me', 0, 0),
  ('friend', 0, 0)
on conflict (role) do nothing;
