-- =============================================================================
-- Football predictions beta: database only (questions, picks, lock, results,
-- corrections, voids, audit, server-side scores). Additive: three new tables
-- and new functions; nothing existing changes. No notifications, screens or
-- scheduled jobs here (later stages).
--
-- Plan: docs/football-predictions-implementation-plan.md (owner decisions of
-- 27 Oct 2026). In short:
--   * Every question belongs to one World (the match room); one main Daily
--     Drop per day (Africa/Lagos date). Timestamps are stored as timestamptz
--     (UTC); "today" and "this week" are Lagos time.
--   * Competitions: Premier League and Champions League. NPFL is added later
--     by widening the competition check.
--   * Only allowlisted beta members (and admins) can see or play. The
--     allowlist restricts predictions only, nothing else in the app.
--   * One pick per person per question, changeable until the lock, which is
--     the database's clock at locks_at (kick-off) — never the phone's.
--   * Picks are hidden until the lock: before it, nobody (admins included) can
--     see how others picked; afterwards only per-option counts are shown.
--   * One point per correct pick on settled questions, computed here and never
--     stored or accepted from a client. Voided questions score nothing.
--   * Admins settle (after the lock, with an https source), correct within
--     48 h, void (abandoned with no official result, or within 48 h after a
--     settlement), and postpone / reschedule. Postponed questions keep their
--     picks; once the original kick-off has passed, picks stay closed even if
--     the match is rescheduled (the field has already been revealed).
--   * Every admin action is written to admin_audit_log.
--   * Unusual outcomes (awarded / forfeited matches, replays, results changed
--     later, 90 minutes vs extra time) have no automatic rule: the question's
--     wording decides, and anything else is listed as unresolved in the plan.
--
-- Clients get no table privileges: every read and write goes through the
-- functions below, which check auth.uid(), the allowlist, suspension and
-- is_admin() themselves.
--
-- Error codes: PR001 picks closed (locked / postponed) · PR002 invalid option ·
-- PR003 too many changes · PR004 not available (not a beta member,
-- unpublished, void, settled, World cancelled) · PR005 admin rule refused.
-- =============================================================================

-- ------------------------------------------------------------------ tables

create table public.prediction_beta_members (
  user_id   uuid primary key references public.profiles (id) on delete cascade,
  added_by  uuid references public.profiles (id) on delete set null,
  added_at  timestamptz not null default now()
);

create table public.prediction_questions (
  id              uuid primary key default gen_random_uuid(),
  world_id        uuid not null unique references public.worlds (id) on delete restrict,
  competition     text not null check (competition in ('premier-league', 'champions-league')),
  drop_date       date not null,                      -- the Daily Drop it belongs to (Africa/Lagos date)
  is_main         boolean not null default true,      -- the day's main Drop (one per date)
  prompt          text not null check (char_length(btrim(prompt)) between 5 and 140),
  options         text[] not null check (array_length(options, 1) between 2 and 3 and array_position(options, null) is null),
  locks_at        timestamptz not null,               -- kick-off: picks are refused from this instant
  published_at    timestamptz,                        -- null: admins only
  postponed_at    timestamptz,                        -- set while the new kick-off is unknown
  picks_closed_at timestamptz,                        -- set when a lock has passed and the match moved on
  correct_option  smallint check (correct_option between 0 and 2),
  result_source   text check (result_source ~ '^https://\S+$' and char_length(result_source) <= 500),
  result_note     text check (char_length(result_note) <= 280),
  settled_at      timestamptz,
  settled_by      uuid references public.profiles (id) on delete set null,
  corrected_at    timestamptz,
  voided_at       timestamptz,
  void_reason     text check (char_length(btrim(void_reason)) between 3 and 280),
  created_by      uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint prediction_settled_complete check (
    (settled_at is null) = (correct_option is null) and (settled_at is null) = (result_source is null)),
  constraint prediction_correct_in_options check (correct_option is null or correct_option < array_length(options, 1)),
  constraint prediction_void_complete check ((voided_at is null) = (void_reason is null))
);
create unique index prediction_questions_main_drop on public.prediction_questions (drop_date) where is_main;
create index prediction_questions_unsettled on public.prediction_questions (locks_at) where settled_at is null and voided_at is null;

create table public.predictions (
  question_id   uuid not null references public.prediction_questions (id) on delete cascade,
  user_id       uuid not null references public.profiles (id) on delete cascade,
  option        smallint not null check (option between 0 and 2),
  change_count  smallint not null default 0 check (change_count between 0 and 10),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (question_id, user_id)                  -- one pick per person per question
);
create index predictions_user_recent on public.predictions (user_id, updated_at desc);

revoke all on public.prediction_beta_members, public.prediction_questions, public.predictions from public, anon, authenticated;
alter table public.prediction_beta_members enable row level security;
alter table public.prediction_questions enable row level security;
alter table public.predictions enable row level security;
-- No policies: clients read and write only through the functions below.

-- ------------------------------------------------------------------ helpers

-- The signed-in beta member (or admin) asking; anyone else is refused.
create function public.prediction_require_member() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
begin
  if uid is null then raise exception 'sign in first' using errcode = '42501'; end if;
  if not public.is_admin() and not exists (select 1 from public.prediction_beta_members where user_id = uid) then
    raise exception 'the predictions beta is invite-only' using errcode = 'PR004';
  end if;
  return uid;
end $$;

-- 'void' > 'settled' > 'postponed' > 'locked' > 'open'
create function public.prediction_status(q public.prediction_questions) returns text
language sql stable set search_path = '' as $$
  select case
    when q.voided_at is not null then 'void'
    when q.settled_at is not null then 'settled'
    when q.postponed_at is not null then 'postponed'
    when q.picks_closed_at is not null or now() >= q.locks_at then 'locked'
    else 'open' end
$$;

-- How others picked may be shown once the lock has passed (never before).
create function public.prediction_revealed(q public.prediction_questions) returns boolean
language sql stable set search_path = '' as $$
  select q.picks_closed_at is not null or now() >= q.locks_at
$$;

-- One question as the viewer may see it.
create function public.prediction_view(q public.prediction_questions, p_viewer uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', q.id,
    'world', (select jsonb_build_object('id', w.id, 'slug', w.slug, 'title', w.title) from public.worlds w where w.id = q.world_id),
    'competition', q.competition,
    'dropDate', q.drop_date,
    'main', q.is_main,
    'prompt', q.prompt,
    'options', to_jsonb(q.options),
    'locksAt', q.locks_at,
    'serverNow', now(),
    'published', q.published_at is not null,
    'status', public.prediction_status(q),
    'revealed', public.prediction_revealed(q),
    'counts', case when public.prediction_revealed(q) then
                (select jsonb_agg(coalesce(c.n, 0) order by i)
                   from generate_subscripts(q.options, 1) i
                   left join (select p.option, count(*) as n from public.predictions p where p.question_id = q.id group by p.option) c
                     on c.option = i - 1)
              end,
    'myPick', (select p.option from public.predictions p where p.question_id = q.id and p.user_id = p_viewer),
    'correctOption', case when q.voided_at is null then q.correct_option end,
    'resultSource', q.result_source,
    'resultNote', q.result_note,
    'settledAt', q.settled_at,
    'correctedAt', q.corrected_at,
    'voidReason', q.void_reason,
    'myPoints', case when q.settled_at is not null and q.voided_at is null then
                  (select (p.option = q.correct_option)::int from public.predictions p where p.question_id = q.id and p.user_id = p_viewer)
                end)
$$;

-- ---------------------------------------------------------------- reading

-- Today's main Daily Drop (Africa/Lagos date), or null. Admins also see unpublished ones.
create function public.prediction_today() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  uid uuid := public.prediction_require_member();
  q public.prediction_questions;
begin
  select * into q from public.prediction_questions
   where drop_date = (now() at time zone 'Africa/Lagos')::date and is_main
     and (published_at is not null or public.is_admin());
  if not found then return null; end if;
  return public.prediction_view(q, uid);
end $$;

create function public.prediction_for_world(p_world uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  uid uuid := public.prediction_require_member();
  q public.prediction_questions;
begin
  select * into q from public.prediction_questions
   where world_id = p_world and (published_at is not null or public.is_admin());
  if not found then return null; end if;
  return public.prediction_view(q, uid);
end $$;

-- The beta table: one point per correct pick on settled, non-void questions.
-- 'week' = the current Monday–Sunday week in Lagos (by the questions' Drop date).
-- Ties share a rank. Visible to beta members (names and scores).
create function public.prediction_table(p_period text default 'all', p_limit integer default 100)
returns table (user_id uuid, username text, display_name text, avatar_url text, points integer, played integer, rank integer)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  perform public.prediction_require_member();
  if p_period is null or p_period not in ('week', 'all') then
    raise exception 'period must be week or all' using errcode = '22023';
  end if;
  return query
    with qs as (
      select q.id, q.correct_option
        from public.prediction_questions q
       where q.settled_at is not null and q.voided_at is null
         and (p_period = 'all'
              or date_trunc('week', q.drop_date) = date_trunc('week', (now() at time zone 'Africa/Lagos')::date))
    ), s as (
      select p.user_id as uid,
             (count(*) filter (where p.option = qs.correct_option))::integer as pts,
             count(*)::integer as n
        from public.predictions p join qs on qs.id = p.question_id
       group by p.user_id
    )
    select s.uid, pr.username, pr.display_name, pr.avatar_url, s.pts, s.n,
           (rank() over (order by s.pts desc))::integer
      from s join public.profiles pr on pr.id = s.uid
     order by 7, pr.display_name, s.uid
     limit least(greatest(coalesce(p_limit, 100), 1), 500);
end $$;

-- ----------------------------------------------------------------- picking

-- The lock, enforced on the table itself too: no code path can store a pick
-- after kick-off, while postponed, or on a closed / void / settled question.
create function public.predictions_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  q public.prediction_questions;
  cancelled boolean;
begin
  if tg_op = 'UPDATE' and (new.question_id <> old.question_id or new.user_id <> old.user_id) then
    raise exception 'a pick can''t be moved' using errcode = 'PR004';
  end if;
  select * into q from public.prediction_questions where id = new.question_id;
  select w.cancelled_at is not null into cancelled from public.worlds w where w.id = q.world_id;
  if q.published_at is null or q.settled_at is not null or q.voided_at is not null or cancelled then
    raise exception 'this question isn''t open for picks' using errcode = 'PR004';
  end if;
  if q.postponed_at is not null or q.picks_closed_at is not null or now() >= q.locks_at then
    raise exception 'picks closed at kick-off' using errcode = 'PR001';
  end if;
  if new.option < 0 or new.option >= array_length(q.options, 1) then
    raise exception 'that isn''t one of the options' using errcode = 'PR002';
  end if;
  return new;
end $$;
create trigger predictions_guard before insert or update on public.predictions
  for each row execute function public.predictions_guard();

-- Your pick (0-based option). Picking the same option again changes nothing;
-- a different one replaces it (at most 10 changes). Returns the question as you see it.
create function public.submit_pick(p_question uuid, p_option integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.prediction_require_member();
  q public.prediction_questions;
begin
  if public.is_suspended(uid) then raise exception 'this account is suspended' using errcode = 'AS001'; end if;
  select * into q from public.prediction_questions where id = p_question and (published_at is not null or public.is_admin());
  if not found then raise exception 'no such question' using errcode = 'PR004'; end if;
  if p_option is null or p_option < 0 or p_option >= array_length(q.options, 1) then
    raise exception 'that isn''t one of the options' using errcode = 'PR002';
  end if;
  if (select count(*) from public.predictions where user_id = uid and updated_at > now() - interval '1 minute') >= 30 then
    raise exception 'slow down: too many picks' using errcode = 'RL001';
  end if;
  begin
    insert into public.predictions (question_id, user_id, option) values (p_question, uid, p_option)
    on conflict (question_id, user_id) do update
      set option = excluded.option, change_count = predictions.change_count + 1, updated_at = now()
      where predictions.option is distinct from excluded.option;
  exception when check_violation then
    raise exception 'you''ve changed this pick too many times' using errcode = 'PR003';
  end;
  return public.prediction_view(q, uid);
end $$;

-- ------------------------------------------------------------------- admin

create function public.prediction_admin_get(p_id uuid) returns public.prediction_questions
language plpgsql security definer set search_path = '' as $$
declare
  q public.prediction_questions;
begin
  select * into q from public.prediction_questions where id = p_id for update;
  if not found then raise exception 'no such question' using errcode = 'PR005'; end if;
  return q;
end $$;

create function public.prediction_check_options(p_options text[]) returns text[]
language plpgsql immutable set search_path = '' as $$
declare
  o text[];
begin
  select array_agg(btrim(x) order by n) into o from unnest(p_options) with ordinality as u(x, n);
  if o is null or array_length(o, 1) not between 2 and 3
     or exists (select 1 from unnest(o) x where x is null or char_length(x) not between 1 and 40)
     or (select count(distinct lower(x)) from unnest(o) x) <> array_length(o, 1) then
    raise exception 'give 2 or 3 different options of 1–40 characters' using errcode = 'PR005';
  end if;
  return o;
end $$;

create function public.admin_create_question(p_world uuid, p_competition text, p_prompt text, p_options text[],
                                              p_locks_at timestamptz, p_drop_date date default null, p_main boolean default true)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.support_require_admin();
  w record;
  qid uuid;
  opts text[] := public.prediction_check_options(p_options);
begin
  select * into w from public.worlds where id = p_world;
  if not found or w.cancelled_at is not null then raise exception 'pick an existing, not cancelled World' using errcode = 'PR005'; end if;
  if p_locks_at is null or p_locks_at <= now() then raise exception 'kick-off must be in the future' using errcode = 'PR005'; end if;
  if p_locks_at >= w.ends_at then raise exception 'kick-off must be before the World ends' using errcode = 'PR005'; end if;
  begin
    insert into public.prediction_questions (world_id, competition, drop_date, is_main, prompt, options, locks_at, created_by)
    values (p_world, p_competition, coalesce(p_drop_date, (p_locks_at at time zone 'Africa/Lagos')::date),
            coalesce(p_main, true), btrim(p_prompt), opts, p_locks_at, uid)
    returning id into qid;
  exception
    when unique_violation then
      raise exception 'that World already has a question, or that day already has a main Drop' using errcode = 'PR005';
    when check_violation or not_null_violation then
      raise exception 'check the question: %', sqlerrm using errcode = 'PR005';
  end;
  perform public.admin_log('prediction.create', 'prediction', qid, 'Created prediction: ' || btrim(p_prompt),
    jsonb_build_object('world', p_world, 'competition', p_competition, 'options', to_jsonb(opts), 'locks_at', p_locks_at));
  return qid;
end $$;

-- Wording and options, only while nobody has picked and the question is open.
create function public.admin_update_question(p_id uuid, p_prompt text, p_options text[]) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.support_require_admin();
  q public.prediction_questions := public.prediction_admin_get(p_id);
  opts text[] := public.prediction_check_options(p_options);
begin
  if public.prediction_status(q) <> 'open' or exists (select 1 from public.predictions where question_id = p_id) then
    raise exception 'a question can only be edited while open and before anyone has picked' using errcode = 'PR005';
  end if;
  begin
    update public.prediction_questions set prompt = btrim(p_prompt), options = opts, updated_at = now() where id = p_id;
  exception when check_violation then
    raise exception 'check the question: %', sqlerrm using errcode = 'PR005';
  end;
  perform public.admin_log('prediction.update', 'prediction', p_id, 'Edited prediction: ' || btrim(p_prompt),
    jsonb_build_object('before', jsonb_build_object('prompt', q.prompt, 'options', to_jsonb(q.options)), 'options', to_jsonb(opts)));
end $$;

create function public.admin_publish_question(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.support_require_admin();
  q public.prediction_questions := public.prediction_admin_get(p_id);
begin
  if q.published_at is not null then return; end if;
  if public.prediction_status(q) <> 'open' then raise exception 'only an open question can be published' using errcode = 'PR005'; end if;
  update public.prediction_questions set published_at = now(), updated_at = now() where id = p_id;
  perform public.admin_log('prediction.publish', 'prediction', p_id, 'Published prediction: ' || q.prompt);
end $$;

-- New kick-off not known yet: picks are kept, and closed until it is.
create function public.admin_postpone_question(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.support_require_admin();
  q public.prediction_questions := public.prediction_admin_get(p_id);
begin
  if q.settled_at is not null or q.voided_at is not null then raise exception 'this question is already decided' using errcode = 'PR005'; end if;
  if q.postponed_at is not null then raise exception 'already postponed' using errcode = 'PR005'; end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 3 and 280 then raise exception 'give a reason' using errcode = 'PR005'; end if;
  update public.prediction_questions
     set postponed_at = now(),
         picks_closed_at = case when now() >= locks_at then coalesce(picks_closed_at, locks_at) else picks_closed_at end,
         updated_at = now()
   where id = p_id;
  perform public.admin_log('prediction.postpone', 'prediction', p_id, 'Postponed prediction: ' || q.prompt,
    jsonb_build_object('reason', btrim(p_reason), 'locks_at', q.locks_at));
end $$;

-- The confirmed new kick-off. Picks are kept; if the original kick-off has
-- already passed they stay closed (others' picks were already shown).
create function public.admin_reschedule_question(p_id uuid, p_locks_at timestamptz, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.support_require_admin();
  q public.prediction_questions := public.prediction_admin_get(p_id);
  w_ends timestamptz;
begin
  if q.settled_at is not null or q.voided_at is not null then raise exception 'this question is already decided' using errcode = 'PR005'; end if;
  if p_locks_at is null or p_locks_at <= now() then raise exception 'the new kick-off must be in the future' using errcode = 'PR005'; end if;
  select ends_at into w_ends from public.worlds where id = q.world_id;
  if p_locks_at >= w_ends then raise exception 'move the World''s end first: the new kick-off must be before it' using errcode = 'PR005'; end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 3 and 280 then raise exception 'give a reason' using errcode = 'PR005'; end if;
  update public.prediction_questions
     set picks_closed_at = case when now() >= locks_at then coalesce(picks_closed_at, locks_at) else picks_closed_at end,
         locks_at = p_locks_at, postponed_at = null, updated_at = now()
   where id = p_id;
  perform public.admin_log('prediction.reschedule', 'prediction', p_id, 'Rescheduled prediction: ' || q.prompt,
    jsonb_build_object('reason', btrim(p_reason), 'from', q.locks_at, 'to', p_locks_at));
end $$;

-- The official result, after kick-off, with the link it was checked against.
create function public.admin_settle_question(p_id uuid, p_option integer, p_source text, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.support_require_admin();
  q public.prediction_questions := public.prediction_admin_get(p_id);
begin
  if q.voided_at is not null or q.settled_at is not null then raise exception 'this question is already decided' using errcode = 'PR005'; end if;
  if q.published_at is null then raise exception 'only a published question can be settled' using errcode = 'PR005'; end if;
  if q.postponed_at is not null or now() < q.locks_at then raise exception 'a result can only be entered after kick-off' using errcode = 'PR005'; end if;
  if p_option is null or p_option < 0 or p_option >= array_length(q.options, 1) then raise exception 'that isn''t one of the options' using errcode = 'PR002'; end if;
  if p_source is null or p_source !~ '^https://\S+$' or char_length(p_source) > 500 then
    raise exception 'give the https link the result was checked against' using errcode = 'PR005';
  end if;
  update public.prediction_questions
     set correct_option = p_option, result_source = p_source, result_note = nullif(btrim(coalesce(p_note, '')), ''),
         settled_at = now(), settled_by = uid, updated_at = now()
   where id = p_id;
  perform public.admin_log('prediction.settle', 'prediction', p_id, 'Settled prediction: ' || q.prompt || ' → ' || q.options[p_option + 1],
    jsonb_build_object('option', p_option, 'label', q.options[p_option + 1], 'source', p_source));
end $$;

-- A wrong result, within 48 hours of settling. Scores recompute by themselves.
create function public.admin_correct_question(p_id uuid, p_option integer, p_source text, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.support_require_admin();
  q public.prediction_questions := public.prediction_admin_get(p_id);
begin
  if q.settled_at is null or q.voided_at is not null then raise exception 'only a settled question can be corrected' using errcode = 'PR005'; end if;
  if now() > q.settled_at + interval '48 hours' then raise exception 'corrections are only possible within 48 hours' using errcode = 'PR005'; end if;
  if p_option is null or p_option < 0 or p_option >= array_length(q.options, 1) then raise exception 'that isn''t one of the options' using errcode = 'PR002'; end if;
  if p_option = q.correct_option then raise exception 'that is already the result' using errcode = 'PR005'; end if;
  if p_source is null or p_source !~ '^https://\S+$' or char_length(p_source) > 500 then
    raise exception 'give the https link the result was checked against' using errcode = 'PR005';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 3 and 280 then raise exception 'give a reason' using errcode = 'PR005'; end if;
  update public.prediction_questions
     set correct_option = p_option, result_source = p_source, corrected_at = now(), updated_at = now()
   where id = p_id;
  perform public.admin_log('prediction.correct', 'prediction', p_id, 'Corrected prediction: ' || q.prompt,
    jsonb_build_object('from', q.correct_option, 'to', p_option, 'source', p_source, 'previous_source', q.result_source, 'reason', btrim(p_reason)));
end $$;

-- No official result (abandoned, or otherwise unplayable): no points for anyone.
-- Before a result, or within 48 hours after one. Picks are kept for the record.
create function public.admin_void_question(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.support_require_admin();
  q public.prediction_questions := public.prediction_admin_get(p_id);
begin
  if q.voided_at is not null then raise exception 'already void' using errcode = 'PR005'; end if;
  if q.settled_at is not null and now() > q.settled_at + interval '48 hours' then
    raise exception 'a settled question can only be voided within 48 hours' using errcode = 'PR005';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 3 and 280 then raise exception 'give a reason' using errcode = 'PR005'; end if;
  update public.prediction_questions set voided_at = now(), void_reason = btrim(p_reason), updated_at = now() where id = p_id;
  perform public.admin_log('prediction.void', 'prediction', p_id, 'Voided prediction: ' || q.prompt,
    jsonb_build_object('reason', btrim(p_reason), 'was_settled', q.settled_at is not null, 'option', q.correct_option));
end $$;

create function public.admin_set_prediction_beta_member(p_user uuid, p_member boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.support_require_admin();
begin
  if not exists (select 1 from public.profiles where id = p_user) then raise exception 'no such person' using errcode = 'PR005'; end if;
  if p_member then
    insert into public.prediction_beta_members (user_id, added_by) values (p_user, uid) on conflict do nothing;
    if not found then return; end if;
  else
    delete from public.prediction_beta_members where user_id = p_user;
    if not found then return; end if;
  end if;
  perform public.admin_log(case when p_member then 'prediction.beta_add' else 'prediction.beta_remove' end, 'profile', p_user,
    case when p_member then 'Added to the predictions beta' else 'Removed from the predictions beta' end);
end $$;

-- The admin's to-do list: published questions past kick-off with no result yet.
create function public.admin_unsettled_questions() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  uid uuid := public.support_require_admin();
begin
  return coalesce((
    select jsonb_agg(public.prediction_view(q, uid) order by q.locks_at)
      from public.prediction_questions q
     where q.settled_at is null and q.voided_at is null and q.published_at is not null
       and q.postponed_at is null and now() >= q.locks_at), '[]'::jsonb);
end $$;

-- ------------------------------------------------------------------ grants

revoke execute on function
  public.prediction_require_member(), public.prediction_status(public.prediction_questions),
  public.prediction_revealed(public.prediction_questions), public.prediction_view(public.prediction_questions, uuid),
  public.prediction_today(), public.prediction_for_world(uuid), public.prediction_table(text, integer),
  public.predictions_guard(), public.submit_pick(uuid, integer),
  public.prediction_admin_get(uuid), public.prediction_check_options(text[]),
  public.admin_create_question(uuid, text, text, text[], timestamptz, date, boolean),
  public.admin_update_question(uuid, text, text[]), public.admin_publish_question(uuid),
  public.admin_postpone_question(uuid, text), public.admin_reschedule_question(uuid, timestamptz, text),
  public.admin_settle_question(uuid, integer, text, text), public.admin_correct_question(uuid, integer, text, text),
  public.admin_void_question(uuid, text), public.admin_set_prediction_beta_member(uuid, boolean),
  public.admin_unsettled_questions()
from public, anon, authenticated;

grant execute on function
  public.prediction_today(), public.prediction_for_world(uuid), public.prediction_table(text, integer),
  public.submit_pick(uuid, integer),
  public.admin_create_question(uuid, text, text, text[], timestamptz, date, boolean),
  public.admin_update_question(uuid, text, text[]), public.admin_publish_question(uuid),
  public.admin_postpone_question(uuid, text), public.admin_reschedule_question(uuid, timestamptz, text),
  public.admin_settle_question(uuid, integer, text, text), public.admin_correct_question(uuid, integer, text, text),
  public.admin_void_question(uuid, text), public.admin_set_prediction_beta_member(uuid, boolean),
  public.admin_unsettled_questions()
to authenticated;
-- Internal only: prediction_require_member, prediction_status, prediction_revealed, prediction_view,
-- predictions_guard, prediction_admin_get, prediction_check_options.
