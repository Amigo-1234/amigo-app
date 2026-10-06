-- =============================================================================
-- Amigo World — admin-controlled profile verification
--
-- Additive: one table and four admin functions. Nothing existing changes.
--
-- Verification lives in its own table rather than a profiles column, so the
-- existing "People update their own profile" policy and column grants can't
-- ever reach it. Clients have no write grant at all; only admin functions
-- (support_require_admin → is_admin) write it, and each change is audit-logged.
--
-- Public: whether someone is verified (+ type and date) for the badge.
-- Private: the admin note (column not granted to clients).
-- Not built: a verification application flow.
-- =============================================================================

create table public.profile_verifications (
  user_id            uuid primary key references public.profiles (id) on delete cascade,
  verification_type  text not null,
  note               text not null default '',
  verified_by        uuid references public.profiles (id) on delete set null,
  verified_at        timestamptz not null default now(),
  constraint profile_verifications_type check (verification_type in ('notable', 'creator', 'business', 'organization', 'amigo_team')),
  constraint profile_verifications_note check (char_length(note) <= 280)
);

comment on table public.profile_verifications is 'Verified badge. Written only by admin_verify_user / admin_unverify_user. note is admin-only.';

revoke all on public.profile_verifications from anon, authenticated;
-- Column-level: the note is never readable by clients.
grant select (user_id, verification_type, verified_at) on public.profile_verifications to anon, authenticated;

alter table public.profile_verifications enable row level security;
create policy "Verification badges are public" on public.profile_verifications for select to anon, authenticated using (true);
-- No insert/update/delete policies or grants: admin functions only.

create function public.admin_verify_user(p_user uuid, p_type text, p_note text default '') returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.support_require_admin();
  handle text;
  was text;
begin
  select username into handle from public.profiles where id = p_user;
  if handle is null then raise exception 'no such user' using errcode = 'SP005'; end if;
  select verification_type into was from public.profile_verifications where user_id = p_user;
  begin
    insert into public.profile_verifications (user_id, verification_type, note, verified_by, verified_at)
    values (p_user, p_type, btrim(coalesce(p_note, '')), uid, now())
    on conflict (user_id) do update
      set verification_type = excluded.verification_type, note = excluded.note,
          verified_by = excluded.verified_by, verified_at = excluded.verified_at;
  exception when check_violation then
    raise exception 'invalid verification type or note' using errcode = 'SP006';
  end;
  perform public.admin_log('user.verify', 'profile', p_user,
    format('%s @%s as %s%s', case when was is null then 'verified' else 'changed verification of' end, handle, p_type,
           coalesce(' — ' || nullif(btrim(p_note), ''), '')),
    jsonb_build_object('type', p_type, 'previous', was));
end $$;

create function public.admin_unverify_user(p_user uuid, p_note text default '') returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.support_require_admin();
  handle text := (select username from public.profiles where id = p_user);
  was text;
begin
  delete from public.profile_verifications where user_id = p_user returning verification_type into was;
  if was is null then raise exception 'not verified' using errcode = 'SP006'; end if;
  perform public.admin_log('user.unverify', 'profile', p_user,
    format('removed verification from @%s%s', handle, coalesce(' — ' || nullif(btrim(p_note), ''), '')),
    jsonb_build_object('previous', was));
end $$;

create function public.admin_user_lookup(p_handle text)
returns table (id uuid, username text, display_name text, avatar_url text, bio text,
               verification_type text, note text, verified_at timestamptz, verified_by_username text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.support_require_admin();
  return query
    select p.id, p.username, p.display_name, p.avatar_url, p.bio, v.verification_type, v.note, v.verified_at, a.username
    from public.profiles p
    left join public.profile_verifications v on v.user_id = p.id
    left join public.profiles a on a.id = v.verified_by
    where p.username = lower(ltrim(btrim(p_handle), '@'));
end $$;

create function public.admin_verified_users()
returns table (id uuid, username text, display_name text, avatar_url text, bio text,
               verification_type text, note text, verified_at timestamptz, verified_by_username text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.support_require_admin();
  return query
    select p.id, p.username, p.display_name, p.avatar_url, p.bio, v.verification_type, v.note, v.verified_at, a.username
    from public.profile_verifications v
    join public.profiles p on p.id = v.user_id
    left join public.profiles a on a.id = v.verified_by
    order by v.verified_at desc
    limit 500;
end $$;

revoke execute on function public.admin_verify_user(uuid, text, text) from public, anon;
revoke execute on function public.admin_unverify_user(uuid, text) from public, anon;
revoke execute on function public.admin_user_lookup(text) from public, anon;
revoke execute on function public.admin_verified_users() from public, anon;
-- Callable by signed-in users, but each refuses non-admins inside (support_require_admin).
grant execute on function public.admin_verify_user(uuid, text, text) to authenticated;
grant execute on function public.admin_unverify_user(uuid, text) to authenticated;
grant execute on function public.admin_user_lookup(text) to authenticated;
grant execute on function public.admin_verified_users() to authenticated;
