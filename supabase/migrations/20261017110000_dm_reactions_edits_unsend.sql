-- =============================================================================
-- Amigo Messages — reactions, edits and unsend (additive)
--
-- Reactions and edits are encrypted events like any message. The server only
-- learns that a row *relates to* another message (relates_to), never whether
-- it is a reaction or an edit, nor the emoji or new text. That one link lets
-- the server keep them out of unread counts and inbox previews, and delete
-- them with their message.
--
-- Unsend deletes your own message's ciphertext (and everything relating to it)
-- for everyone. A tombstone (ids only) tells the other device to drop it; the
-- other person may already have seen it.
-- =============================================================================

alter table public.dm_messages
  add column relates_to uuid references public.dm_messages (id) on delete cascade;
create index dm_messages_relates_to_idx on public.dm_messages (relates_to) where relates_to is not null;

-- Anything that changes a conversation without being a new message (an
-- annotation, an unsend) moves this, so the pulse notices it.
alter table public.dm_conversations add column changed_at timestamptz;

create table public.dm_tombstones (
  message_id       uuid primary key,
  conversation_id  uuid not null references public.dm_conversations (id) on delete cascade,
  deleted_at       timestamptz not null default now()
);
create index dm_tombstones_conversation_idx on public.dm_tombstones (conversation_id, deleted_at);
revoke all on public.dm_tombstones from anon, authenticated;
alter table public.dm_tombstones enable row level security;

-- Same as dm_send_v2, plus relates_to (null for an ordinary message).
create function public.dm_send_v3(p_id uuid, p_conversation uuid, p_device text, p_content jsonb, p_relates_to uuid default null)
returns table (id uuid, created_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.dm_require_participant(p_conversation);
  peer uuid;
  m record;
begin
  if p_id is null then raise exception 'message id required' using errcode = 'DM005'; end if;
  select x.id, x.created_at, x.sender_id, x.conversation_id into m from public.dm_messages x where x.id = p_id;
  if found then
    if m.sender_id <> uid or m.conversation_id <> p_conversation then raise exception 'id in use' using errcode = 'DM005'; end if;
    return query select m.id, m.created_at;
    return;
  end if;
  if p_relates_to is not null and not exists (
    select 1 from public.dm_messages t where t.id = p_relates_to and t.conversation_id = p_conversation and t.relates_to is null) then
    raise exception 'no such message' using errcode = 'DM006';
  end if;
  select user_id into peer from public.dm_participants where conversation_id = p_conversation and user_id <> uid limit 1;
  if peer is not null and public.dm_blocked_between(uid, peer) then
    raise exception 'blocked' using errcode = 'DM004';
  end if;
  if not exists (select 1 from public.e2e_devices d where d.user_id = uid and d.device_id = p_device) then
    raise exception 'unknown device' using errcode = 'DM005';
  end if;
  begin
    insert into public.dm_messages (id, conversation_id, sender_id, sender_device_id, content, relates_to)
    values (p_id, p_conversation, uid, p_device, p_content, p_relates_to)
    returning dm_messages.id, dm_messages.created_at into m;
  exception
    when check_violation then raise exception 'not an encrypted message' using errcode = 'DM005';
    when unique_violation then
      return query select x.id, x.created_at from public.dm_messages x
        where x.id = p_id and x.sender_id = uid and x.conversation_id = p_conversation;
      return;
  end;
  if p_relates_to is null then
    update public.dm_conversations set last_message_at = m.created_at where dm_conversations.id = p_conversation;
    update public.dm_participants set last_read_at = greatest(last_read_at, m.created_at),
           last_delivered_at = greatest(last_delivered_at, m.created_at)
     where conversation_id = p_conversation and user_id = uid;
  else
    update public.dm_conversations set changed_at = m.created_at where dm_conversations.id = p_conversation;
  end if;
  return query select m.id, m.created_at;
end $$;

-- Unsend one of your own messages, for everyone.
create function public.dm_unsend(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  conv uuid;
begin
  if uid is null then raise exception 'sign in first' using errcode = 'DM001'; end if;
  delete from public.dm_messages m where m.id = p_id and m.sender_id = uid returning m.conversation_id into conv;
  if conv is null then raise exception 'no such message' using errcode = 'DM006'; end if;
  insert into public.dm_tombstones (message_id, conversation_id) values (p_id, conv) on conflict do nothing;
  update public.dm_conversations c
     set changed_at = now(),
         last_message_at = (select max(x.created_at) from public.dm_messages x where x.conversation_id = conv and x.relates_to is null)
   where c.id = conv;
end $$;

-- Annotations never count as unread or become the inbox preview.
create or replace function public.dm_inbox() returns table (
  conversation_id uuid, peer_id uuid, last_message_at timestamptz,
  last_message_id uuid, last_sender_id uuid, last_sender_device text, last_content jsonb,
  unread_count bigint, my_last_read_at timestamptz, peer_last_read_at timestamptz, peer_last_delivered_at timestamptz,
  blocked_by_me boolean, can_send boolean)
language sql stable security invoker set search_path = '' as $$
  select c.id, peer.user_id, c.last_message_at,
         lm.id, lm.sender_id, lm.sender_device_id, lm.content,
         (select count(*) from public.dm_messages x
           where x.conversation_id = c.id and x.sender_id <> me.user_id and x.created_at > me.last_read_at and x.relates_to is null),
         me.last_read_at, peer.last_read_at, peer.last_delivered_at,
         exists (select 1 from public.user_blocks b where b.blocker_id = me.user_id and b.blocked_id = peer.user_id),
         not public.dm_blocked_between(me.user_id, peer.user_id)
  from public.dm_participants me
  join public.dm_conversations c on c.id = me.conversation_id
  join public.dm_participants peer on peer.conversation_id = c.id and peer.user_id <> me.user_id
  left join lateral (
    select m.id, m.sender_id, m.sender_device_id, m.content from public.dm_messages m
    where m.conversation_id = c.id and m.relates_to is null order by m.created_at desc limit 1) lm on true
  where me.user_id = (select auth.uid()) and c.last_message_at is not null
  order by c.last_message_at desc
  limit 200
$$;

create or replace function public.dm_pulse(p_device text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when (select auth.uid()) is null then null else jsonb_build_object(
    'm', (select max(greatest(c.last_message_at, c.changed_at)) from public.dm_participants me
            join public.dm_conversations c on c.id = me.conversation_id
           where me.user_id = (select auth.uid())),
    'r', (select max(greatest(p.last_read_at, p.last_delivered_at)) from public.dm_participants me
            join public.dm_participants p on p.conversation_id = me.conversation_id
           where me.user_id = (select auth.uid())),
    'x', (select max(t.id) from public.e2e_to_device t
           where t.recipient_id = (select auth.uid()) and t.recipient_device = p_device),
    'b', (select count(*) from public.user_blocks b
           where b.blocker_id = (select auth.uid()) or b.blocked_id = (select auth.uid()))
  ) end
$$;

-- dm_thread, now with relates_to and the ids unsent since the cursor.
create or replace function public.dm_thread(p_conversation uuid, p_after timestamptz default null, p_before timestamptz default null, p_limit integer default 50)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  uid uuid := public.dm_require_participant(p_conversation);
  peer uuid;
begin
  select user_id into peer from public.dm_participants where conversation_id = p_conversation and user_id <> uid limit 1;
  return jsonb_build_object(
    'members', (select jsonb_agg(jsonb_build_object('user_id', p.user_id, 'last_read_at', p.last_read_at, 'last_delivered_at', p.last_delivered_at))
                  from public.dm_participants p where p.conversation_id = p_conversation),
    'blocked_by_me', exists (select 1 from public.user_blocks b where b.blocker_id = uid and b.blocked_id = peer),
    'blocked_either', peer is not null and public.dm_blocked_between(uid, peer),
    'messages', (select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at, x.id), '[]'::jsonb) from (
                   select m.id, m.conversation_id, m.sender_id, m.sender_device_id, m.content, m.created_at, m.relates_to
                     from public.dm_messages m
                    where m.conversation_id = p_conversation
                      and (p_after is null or m.created_at >= p_after)
                      and (p_before is null or m.created_at < p_before)
                    order by m.created_at desc, m.id desc
                    limit least(greatest(coalesce(p_limit, 50), 1), 100)) x),
    'deleted', case when p_after is null then '[]'::jsonb else
                 (select coalesce(jsonb_agg(t.message_id), '[]'::jsonb) from public.dm_tombstones t
                   where t.conversation_id = p_conversation and t.deleted_at >= p_after) end
  );
end $$;

revoke execute on function public.dm_send_v3(uuid, uuid, text, jsonb, uuid), public.dm_unsend(uuid) from public, anon;
grant execute on function public.dm_send_v3(uuid, uuid, text, jsonb, uuid), public.dm_unsend(uuid) to authenticated;
