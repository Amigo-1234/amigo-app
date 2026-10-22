-- What people say they're into (chosen while joining, editable in Settings).
-- Kept for personalisation later: nothing filters or ranks by it yet, so no
-- one is shown less because they skipped it. Additive: one new table (own row
-- only, through the two functions below) and nothing else.

create table public.user_interests (
  user_id    uuid primary key references public.profiles (id) on delete cascade,
  interests  text[] not null default '{}',
  updated_at timestamptz not null default now(),
  constraint user_interests_known check (
    interests <@ array['technology', 'football', 'music', 'gaming', 'entertainment', 'fashion', 'photography',
                       'business', 'education', 'science', 'art', 'lifestyle']::text[]
  ),
  constraint user_interests_count check (cardinality(interests) <= 12)
);

alter table public.user_interests enable row level security;
revoke all on public.user_interests from anon, authenticated;

create function public.my_interests() returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce((select interests from public.user_interests where user_id = (select auth.uid())), '{}');
$$;

create function public.set_my_interests(p_interests text[]) returns text[]
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  clean text[];
begin
  if uid is null then raise exception 'not signed in' using errcode = '42501'; end if;
  select coalesce(array_agg(distinct lower(btrim(i))), '{}') into clean from unnest(coalesce(p_interests, '{}')) i where btrim(i) <> '';
  if cardinality(clean) > 12 then raise exception 'too many interests' using errcode = 'IN001'; end if;
  if not clean <@ array['technology', 'football', 'music', 'gaming', 'entertainment', 'fashion', 'photography',
                        'business', 'education', 'science', 'art', 'lifestyle']::text[] then
    raise exception 'unknown interest' using errcode = 'IN002';
  end if;
  insert into public.user_interests (user_id, interests, updated_at) values (uid, clean, now())
  on conflict (user_id) do update set interests = excluded.interests, updated_at = now();
  return clean;
end $$;

revoke all on function public.my_interests() from public, anon;
revoke all on function public.set_my_interests(text[]) from public, anon;
grant execute on function public.my_interests() to authenticated;
grant execute on function public.set_my_interests(text[]) to authenticated;
