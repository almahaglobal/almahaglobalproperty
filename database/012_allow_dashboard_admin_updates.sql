-- Allow Supabase Dashboard and server-side administration when no end-user JWT is present.
-- Browser requests still require an approved public.users admin profile.
CREATE OR REPLACE FUNCTION public.protect_user_security_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role
     OR NEW.verification_status IS DISTINCT FROM OLD.verification_status
     OR NEW.verified_by IS DISTINCT FROM OLD.verified_by
     OR NEW.verified_at IS DISTINCT FROM OLD.verified_at THEN
    IF auth.uid() IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
         FROM public.users
         WHERE id = auth.uid()
           AND role = 'admin'
           AND verification_status = 'approved'
       ) THEN
      RAISE EXCEPTION 'Only an approved administrator can change security fields';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
