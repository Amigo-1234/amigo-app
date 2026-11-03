-- =============================================================================
-- Typing indicators without Realtime (additive)
--
-- A tiny unlogged table of "typing until" times — never message content, gone
-- within seconds, not written to the WAL, lost on restart by design. Clients
-- refresh it at most every 3 s while typing and clear it when they stop or
-- leave. The other person learns of it through the existing pulse/thread
-- reads; nothing is shown across a block.
-- =============================================================================

create unlogged table public.dm_typing (
  conversation_id  uuid not null references public.dm_conversations (id) on delete cascade,
  user_id          uuid not null references public.profiles (id) on delete cascade,
  until            timestamptz not null,
  primary key (conversation_id, user_id)
);
revoke all on public.dm_typing from anon, authenticated;
alter table public.dm_typing enable row level security;

create function public.dm_set_typing(p_conversation uuid, p_typing boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := public.dm_require_participant(p_conversation);
begin
  if p_typing then
    insert into public.dm_typing (conversation_id, user_id, until) values (p_conversation, uid, now() + interval '6 seconds')
    on conflict (conversation_id, user_id) do update set until = excluded.until;
  else
    delete from public.dm_typing where conversation_id = p_conversation and user_id = uid;
  end if;
end $$;

-- The pulse also changes when someone starts/stops typing to you.
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
           where b.blocker_id = (select auth.uid()) or b.blocked_id = (select auth.uid())),
    't', (select max(t.until) from public.dm_participants me
            join public.dm_typing t on t.conversation_id = me.conversation_id and t.user_id <> me.user_id
           where me.user_id = (select auth.uid()) and t.until > now())
  ) end
$$;

-- How long the other person keeps "typing" (ms; 0 = not typing), for dm_thread callers.
create function public.dm_peer_typing_ms(p_conversation uuid) returns integer
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select greatest(0, (extract(epoch from (t.until - now())) * 1000)::int)
      from public.dm_typing t
     where t.conversation_id = p_conversation and t.user_id <> (select auth.uid()) and t.until > now()
       and exists (select 1 from public.dm_participants me where me.conversation_id = p_conversation and me.user_id = (select auth.uid()))
       and not public.dm_blocked_between((select auth.uid()), t.user_id)
     limit 1), 0)
$$;

revoke execute on function public.dm_set_typing(uuid, boolean), public.dm_peer_typing_ms(uuid) from public, anon;
grant execute on function public.dm_set_typing(uuid, boolean), public.dm_peer_typing_ms(uuid) to authenticated;
