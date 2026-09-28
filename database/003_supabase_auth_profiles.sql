-- Link Supabase Auth accounts to public user profiles.
-- Passwords remain managed and hashed by Supabase Auth.

ALTER TABLE public.users
  ALTER COLUMN password_hash DROP NOT NULL;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS username VARCHAR(255);

UPDATE public.users
SET username = email
WHERE username IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS users_username_key
  ON public.users (username);

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
    phone,
    role,
    is_verified
  )
  VALUES (
    NEW.id,
    COALESCE(NEW.email, NEW.id::text),
    NEW.email,
    NULL,
    COALESCE(NULLIF(NEW.raw_user_meta_data ->> 'full_name', ''), COALESCE(NEW.email, 'User')),
    NULLIF(NEW.raw_user_meta_data ->> 'phone', ''),
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
    phone = EXCLUDED.phone;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_auth_user();

CREATE OR REPLACE FUNCTION public.sync_auth_user_verification()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.users
  SET is_verified = NEW.email_confirmed_at IS NOT NULL,
      updated_at = CURRENT_TIMESTAMP
  WHERE id = NEW.id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_updated ON auth.users;
CREATE TRIGGER on_auth_user_updated
  AFTER UPDATE OF email_confirmed_at ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_auth_user_verification();
