create or replace function public.admin_delete_user(target_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target record;
begin
  if not public.is_admin() then
    raise exception 'Approved administrator access required';
  end if;
  if target_user_id = (select auth.uid()) then
    raise exception 'You cannot delete your own administrator account';
  end if;

  select email, role into target from public.users where id = target_user_id;
  if not found and not exists (select 1 from auth.users where id = target_user_id) then
    raise exception 'Account not found';
  end if;

  perform public.log_admin_action(
    'account_deleted', 'auth.users', target_user_id::text,
    jsonb_build_object('email', target.email, 'role', target.role)
  );

  delete from auth.users where id = target_user_id;
end;
$$;
revoke execute on function public.admin_delete_user(uuid) from public, anon;
grant execute on function public.admin_delete_user(uuid) to authenticated;
