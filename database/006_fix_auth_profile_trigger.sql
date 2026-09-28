-- Harden Auth profile creation so Supabase signup cannot fail on profile sync.

CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  profile_role VARCHAR(50);
BEGIN
  profile_role := CASE
    WHEN NEW.raw_user_meta_data ->> 'role' IN ('buyer', 'tenant', 'owner', 'agent')
      THEN NEW.raw_user_meta_data ->> 'role'
    ELSE 'buyer'
  END;

  INSERT INTO public.users (
    id,
    username,
    email,
    password_hash,
    full_name,
    first_name,
    last_name,
    country,
    phone,
    mobile_phone,
    company_name,
    role,
    is_verified
  )
  VALUES (
    NEW.id,
    COALESCE(NEW.email, NEW.id::text),
    NEW.email,
    NULL,
    COALESCE(NULLIF(NEW.raw_user_meta_data ->> 'full_name', ''), COALESCE(NEW.email, 'User')),
    NULLIF(NEW.raw_user_meta_data ->> 'first_name', ''),
    NULLIF(NEW.raw_user_meta_data ->> 'last_name', ''),
    NULLIF(NEW.raw_user_meta_data ->> 'country', ''),
    NULLIF(NEW.raw_user_meta_data ->> 'phone', ''),
    NULLIF(NEW.raw_user_meta_data ->> 'mobile_phone', ''),
    NULLIF(NEW.raw_user_meta_data ->> 'company_name', ''),
    profile_role,
    COALESCE(NEW.email_confirmed_at IS NOT NULL, FALSE)
  )
  ON CONFLICT (id) DO UPDATE SET
    username = EXCLUDED.username,
    email = EXCLUDED.email,
    full_name = EXCLUDED.full_name,
    first_name = EXCLUDED.first_name,
    last_name = EXCLUDED.last_name,
    country = EXCLUDED.country,
    phone = EXCLUDED.phone,
    mobile_phone = EXCLUDED.mobile_phone,
    company_name = EXCLUDED.company_name;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.handle_new_auth_user() FROM PUBLIC;
