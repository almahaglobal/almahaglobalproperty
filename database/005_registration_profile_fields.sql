-- Keep public user profiles aligned with the website registration form.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS first_name VARCHAR(120),
  ADD COLUMN IF NOT EXISTS last_name VARCHAR(120),
  ADD COLUMN IF NOT EXISTS country VARCHAR(120),
  ADD COLUMN IF NOT EXISTS company_name VARCHAR(255);

CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
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
    CASE
      WHEN NEW.raw_user_meta_data ->> 'role' IN ('buyer', 'tenant', 'owner', 'agent')
        THEN NEW.raw_user_meta_data ->> 'role'
      ELSE 'buyer'
    END,
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
    company_name = EXCLUDED.company_name,
    role = EXCLUDED.role;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_auth_user();
