-- Store replies sent through the in-site customer inbox.
ALTER TABLE public.contact_messages
  ADD COLUMN IF NOT EXISTS reply_body TEXT;

GRANT UPDATE (reply_body, status, replied_at, replied_by, updated_at)
  ON public.contact_messages TO authenticated;