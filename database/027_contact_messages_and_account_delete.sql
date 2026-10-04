-- Public contact submissions are writable by visitors but visible only to approved admins.
CREATE TABLE IF NOT EXISTS public.contact_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(120) NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  email VARCHAR(254) NOT NULL CHECK (position('@' IN email) > 1),
  phone VARCHAR(50),
  subject VARCHAR(180) NOT NULL CHECK (char_length(btrim(subject)) BETWEEN 1 AND 180),
  message TEXT NOT NULL CHECK (char_length(btrim(message)) BETWEEN 10 AND 5000),
  status VARCHAR(20) NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'read', 'replied')),
  replied_at TIMESTAMPTZ,
  replied_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS contact_messages_status_created_idx
  ON public.contact_messages(status, created_at DESC);

ALTER TABLE public.contact_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.contact_messages FROM PUBLIC, anon, authenticated;
GRANT INSERT (name, email, phone, subject, message) ON public.contact_messages TO anon, authenticated;
GRANT SELECT ON public.contact_messages TO authenticated;
GRANT UPDATE (status, replied_at, replied_by, updated_at) ON public.contact_messages TO authenticated;

DROP POLICY IF EXISTS contact_messages_public_submit ON public.contact_messages;
CREATE POLICY contact_messages_public_submit ON public.contact_messages
  FOR INSERT TO anon, authenticated
  WITH CHECK (status = 'new' AND replied_at IS NULL AND replied_by IS NULL);

DROP POLICY IF EXISTS contact_messages_admin_read ON public.contact_messages;
CREATE POLICY contact_messages_admin_read ON public.contact_messages
  FOR SELECT TO authenticated
  USING (public.is_admin());

DROP POLICY IF EXISTS contact_messages_admin_update ON public.contact_messages;
CREATE POLICY contact_messages_admin_update ON public.contact_messages
  FOR UPDATE TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- Remove project cover media together with the Auth user that owns its folder.
CREATE OR REPLACE FUNCTION public.delete_auth_user_data()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, storage
AS $$
BEGIN
  PERFORM set_config('storage.allow_delete_query', 'true', true);
  DELETE FROM storage.objects
  WHERE bucket_id IN (
    'kyc-documents',
    'property-images',
    'property-verification-documents',
    'project-media'
  )
    AND (storage.foldername(name))[1] = OLD.id::text;

  DELETE FROM public.users WHERE id = OLD.id;
  RETURN OLD;
END;
$$;