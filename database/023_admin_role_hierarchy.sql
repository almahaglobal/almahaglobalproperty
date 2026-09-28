-- Stage 1: administrator role hierarchy (single-company deployment).
-- Existing roles (buyer, tenant, owner, agent) are untouched. 'admin' is kept as a
-- legacy alias for 'company_owner' so the current production admin account keeps working.

ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE public.users
  ADD CONSTRAINT users_role_check
  CHECK (role IN (
    'buyer', 'tenant', 'owner', 'agent',
    'admin', 'platform_owner', 'company_owner', 'company_admin', 'staff'
  ));

-- verification_status doubles as the administrator approval state for admin-tier roles:
-- pending_verification = PENDING_APPROVAL, approved = ACTIVE, rejected = REJECTED, suspended = SUSPENDED.

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.users
    WHERE id = auth.uid()
      AND role IN ('admin', 'platform_owner', 'company_owner', 'company_admin', 'staff')
      AND verification_status = 'approved'
  );
$$;

CREATE OR REPLACE FUNCTION public.is_platform_owner()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.users
    WHERE id = auth.uid()
      AND role = 'platform_owner'
      AND verification_status = 'approved'
  );
$$;

-- Only the platform owner or a company owner can manage other administrator accounts.
CREATE OR REPLACE FUNCTION public.can_manage_administrators()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.users
    WHERE id = auth.uid()
      AND role IN ('platform_owner', 'company_owner', 'admin')
      AND verification_status = 'approved'
  );
$$;

-- Change an administrator's role or approval status. Ordinary staff/company_admin cannot
-- call this; only platform_owner/company_owner/admin. Nobody can promote to platform_owner here.
CREATE OR REPLACE FUNCTION public.set_administrator_status(
  target_user_id UUID,
  new_role VARCHAR DEFAULT NULL,
  new_status VARCHAR DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.can_manage_administrators() THEN
    RAISE EXCEPTION 'Only an authorized owner can manage administrator accounts';
  END IF;

  IF target_user_id = auth.uid() THEN
    RAISE EXCEPTION 'You cannot change your own administrator status';
  END IF;

  IF new_role IS NOT NULL THEN
    IF new_role NOT IN ('company_admin', 'staff') THEN
      RAISE EXCEPTION 'You may only assign the company_admin or staff role here';
    END IF;

    IF (SELECT role FROM public.users WHERE id = target_user_id) NOT IN
      ('admin', 'platform_owner', 'company_owner', 'company_admin', 'staff') THEN
      RAISE EXCEPTION 'Target account is not an administrator';
    END IF;

    UPDATE public.users SET role = new_role WHERE id = target_user_id;
  END IF;

  IF new_status IS NOT NULL THEN
    IF new_status NOT IN ('pending_verification', 'approved', 'rejected', 'suspended') THEN
      RAISE EXCEPTION 'Invalid administrator status';
    END IF;

    UPDATE public.users SET verification_status = new_status WHERE id = target_user_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.set_administrator_status(UUID, VARCHAR, VARCHAR) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_administrator_status(UUID, VARCHAR, VARCHAR) TO authenticated;

-- Foundation for Stage 11 (audit log). Populated by admin actions going forward.
CREATE TABLE IF NOT EXISTS public.admin_activity_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  action VARCHAR(100) NOT NULL,
  target_table VARCHAR(100),
  target_id UUID,
  previous_value JSONB,
  new_value JSONB,
  reason TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE public.admin_activity_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS admin_activity_log_admin_select ON public.admin_activity_log;
CREATE POLICY admin_activity_log_admin_select ON public.admin_activity_log
  FOR SELECT TO authenticated
  USING (public.is_admin());

-- Inserts only happen through SECURITY DEFINER functions (service role / definer context),
-- never directly from client roles.
REVOKE INSERT, UPDATE, DELETE ON public.admin_activity_log FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.log_admin_action(
  p_action VARCHAR,
  p_target_table VARCHAR DEFAULT NULL,
  p_target_id UUID DEFAULT NULL,
  p_previous_value JSONB DEFAULT NULL,
  p_new_value JSONB DEFAULT NULL,
  p_reason TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Administrator privileges required';
  END IF;

  INSERT INTO public.admin_activity_log (
    admin_id, action, target_table, target_id, previous_value, new_value, reason
  ) VALUES (
    auth.uid(), p_action, p_target_table, p_target_id, p_previous_value, p_new_value, p_reason
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.log_admin_action(VARCHAR, VARCHAR, UUID, JSONB, JSONB, TEXT) TO authenticated;

-- Log administrator status/role changes automatically.
CREATE OR REPLACE FUNCTION public.set_administrator_status(
  target_user_id UUID,
  new_role VARCHAR DEFAULT NULL,
  new_status VARCHAR DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_previous_role VARCHAR;
  v_previous_status VARCHAR;
BEGIN
  IF NOT public.can_manage_administrators() THEN
    RAISE EXCEPTION 'Only an authorized owner can manage administrator accounts';
  END IF;

  IF target_user_id = auth.uid() THEN
    RAISE EXCEPTION 'You cannot change your own administrator status';
  END IF;

  SELECT role, verification_status INTO v_previous_role, v_previous_status
  FROM public.users WHERE id = target_user_id;

  IF v_previous_role IS NULL THEN
    RAISE EXCEPTION 'Administrator account not found';
  END IF;

  IF new_role IS NOT NULL THEN
    IF new_role NOT IN ('company_admin', 'staff') THEN
      RAISE EXCEPTION 'You may only assign the company_admin or staff role here';
    END IF;

    IF v_previous_role NOT IN ('admin', 'platform_owner', 'company_owner', 'company_admin', 'staff') THEN
      RAISE EXCEPTION 'Target account is not an administrator';
    END IF;

    UPDATE public.users SET role = new_role WHERE id = target_user_id;
    PERFORM public.log_admin_action('administrator_role_changed', 'users', target_user_id,
      jsonb_build_object('role', v_previous_role), jsonb_build_object('role', new_role));
  END IF;

  IF new_status IS NOT NULL THEN
    IF new_status NOT IN ('pending_verification', 'approved', 'rejected', 'suspended') THEN
      RAISE EXCEPTION 'Invalid administrator status';
    END IF;

    UPDATE public.users SET verification_status = new_status WHERE id = target_user_id;
    PERFORM public.log_admin_action('administrator_status_changed', 'users', target_user_id,
      jsonb_build_object('verification_status', v_previous_status), jsonb_build_object('verification_status', new_status));
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.set_administrator_status(UUID, VARCHAR, VARCHAR) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_administrator_status(UUID, VARCHAR, VARCHAR) TO authenticated;
