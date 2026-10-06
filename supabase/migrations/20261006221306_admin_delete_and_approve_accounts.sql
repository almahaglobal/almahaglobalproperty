create table if not exists public.admin_audit_log (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid,
  action text not null,
  target_table text,
  target_id text,
  previous_value jsonb,
  created_at timestamptz not null default now()
);
alter table public.admin_audit_log enable row level security;
drop policy if exists "Admins read audit log" on public.admin_audit_log;
create policy "Admins read audit log" on public.admin_audit_log
  for select to authenticated using (public.is_admin());

create or replace function public.log_admin_action(
  p_action text,
  p_target_table text,
  p_target_id text,
  p_previous_value jsonb default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Administrator access required';
  end if;
  insert into public.admin_audit_log (admin_id, action, target_table, target_id, previous_value)
  values ((select auth.uid()), p_action, p_target_table, p_target_id, p_previous_value);
end;
$$;
revoke execute on function public.log_admin_action(text, text, text, jsonb) from public, anon;
grant execute on function public.log_admin_action(text, text, text, jsonb) to authenticated;

create or replace function public.review_kyc_account(target_user_id uuid, decision character varying, reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Administrator approval required';
  end if;
  if decision not in ('approved', 'rejected') then
    raise exception 'Decision must be approved or rejected';
  end if;
  if not exists (
    select 1 from public.users
    where id = target_user_id and role in ('owner', 'agent', 'buyer', 'tenant')
  ) then
    raise exception 'Account not found or cannot be reviewed';
  end if;

  update public.kyc_documents
  set status = decision,
      rejection_reason = case when decision = 'rejected' then reason else null end,
      reviewed_by = auth.uid(),
      reviewed_at = current_timestamp,
      updated_at = current_timestamp
  where user_id = target_user_id and status = 'pending';

  update public.users
  set verification_status = case when decision = 'approved' then 'approved' else 'rejected' end,
      verified_by = auth.uid(),
      verified_at = current_timestamp,
      updated_at = current_timestamp
  where id = target_user_id;
end;
$$;
