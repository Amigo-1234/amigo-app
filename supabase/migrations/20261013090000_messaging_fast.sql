-- =============================================================================
-- Amigo Messages — fewer round trips (additive; nothing existing changes)
--
--   dm_send_v2      send with a client-chosen message id: a retry after a lost
--                   response returns the stored message instead of sending twice
--   dm_pulse        one tiny "did anything change for me?" read, so clients can
--                   poll often and only refetch when something happened
--   dm_thread       a conversation's markers, block state and messages newer
--                   than a cursor (or older than one) in a single call
--   e2e_sync_state  this device's to-device mail, device-list changes and
--                   one-time-key counts in one call (was three)
--
-- Same authorisation as the functions they combine: participant checks,
-- removed-device check, own mail only. Ciphertext only, as before.
-- =============================================================================

create function public.dm_send_v2(p_id uuid, p_conversation uuid, p_device text, p_content jsonb)
returns table (id uuid, created_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.dm_require_participant(p_conversation);
  peer uuid;
  m record;
begin
  if p_id is null then raise exception 'message id required' using errcode = 'DM005'; end if;
  -- Already stored (a retry): return it, never insert twice.
  select x.id, x.created_at, x.sender_id, x.conversation_id into m from public.dm_messages x where x.id = p_id;
  if found then
    if m.sender_id <> uid or m.conversation_id <> p_conversation then raise exception 'id in use' using errcode = 'DM005'; end if;
    return query select m.id, m.created_at;
    return;
  end if;
  select user_id into peer from public.dm_participants where conversation_id = p_conversation and user_id <> uid limit 1;
  if peer is not null and public.dm_blocked_between(uid, peer) then
    raise exception 'blocked' using errcode = 'DM004';
  end if;
  if not exists (select 1 from public.e2e_devices d where d.user_id = uid and d.device_id = p_device) then
    raise exception 'unknown device' using errcode = 'DM005';
  end if;
  begin
    insert into public.dm_messages (id, conversation_id, sender_id, sender_device_id, content)
    values (p_id, p_conversation, uid, p_device, p_content)
    returning dm_messages.id, dm_messages.created_at into m;
  exception
    when check_violation then raise exception 'not an encrypted message' using errcode = 'DM005';
    when unique_violation then
      -- A concurrent retry won the race.
      return query select x.id, x.created_at from public.dm_messages x
        where x.id = p_id and x.sender_id = uid and x.conversation_id = p_conversation;
      return;
  end;
  update public.dm_conversations set last_message_at = m.created_at where dm_conversations.id = p_conversation;
  update public.dm_participants set last_read_at = greatest(last_read_at, m.created_at),
         last_delivered_at = greatest(last_delivered_at, m.created_at)
   where conversation_id = p_conversation and user_id = uid;
  return query select m.id, m.created_at;
end $$;

create function public.dm_pulse(p_device text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when (select auth.uid()) is null then null else jsonb_build_object(
    -- newest message in any of my conversations
    'm', (select max(c.last_message_at) from public.dm_participants me
            join public.dm_conversations c on c.id = me.conversation_id
           where me.user_id = (select auth.uid())),
    -- read/delivered markers (theirs and mine, e.g. read on another device)
    'r', (select max(greatest(p.last_read_at, p.last_delivered_at)) from public.dm_participants me
            join public.dm_participants p on p.conversation_id = me.conversation_id
           where me.user_id = (select auth.uid())),
    -- newest key/verification mail for this device
    'x', (select max(t.id) from public.e2e_to_device t
           where t.recipient_id = (select auth.uid()) and t.recipient_device = p_device),
    -- blocks involving me
    'b', (select count(*) from public.user_blocks b
           where b.blocker_id = (select auth.uid()) or b.blocked_id = (select auth.uid()))
  ) end
$$;

create function public.dm_thread(p_conversation uuid, p_after timestamptz default null, p_before timestamptz default null, p_limit integer default 50)
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
                   select m.id, m.conversation_id, m.sender_id, m.sender_device_id, m.content, m.created_at
                     from public.dm_messages m
                    where m.conversation_id = p_conversation
                      -- >= : a message sharing the cursor's timestamp is never skipped (clients dedupe by id)
                      and (p_after is null or m.created_at >= p_after)
                      and (p_before is null or m.created_at < p_before)
                    order by m.created_at desc, m.id desc
                    limit least(greatest(coalesce(p_limit, 50), 1), 100)) x)
  );
end $$;

create function public.e2e_sync_state(p_device text, p_since timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := public.e2e_require_device(p_device);
begin
  return jsonb_build_object(
    'mail', (select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]'::jsonb) from (
               select id, sender_id, event_type, content from public.e2e_to_device
                where recipient_id = uid and recipient_device = p_device
                order by id limit 500) t),
    'changes', (select coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb) from public.e2e_device_changes(p_since) c),
    'counts', public.e2e_key_counts(p_device)
  );
end $$;

revoke execute on function public.dm_send_v2(uuid, uuid, text, jsonb), public.dm_pulse(text),
  public.dm_thread(uuid, timestamptz, timestamptz, integer), public.e2e_sync_state(text, timestamptz)
  from public, anon;
grant execute on function public.dm_send_v2(uuid, uuid, text, jsonb), public.dm_pulse(text),
  public.dm_thread(uuid, timestamptz, timestamptz, integer), public.e2e_sync_state(text, timestamptz)
  to authenticated;
