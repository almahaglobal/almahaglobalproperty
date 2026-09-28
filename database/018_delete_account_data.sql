-- Remove every public record and private storage object when an auth account is deleted.
CREATE OR REPLACE FUNCTION public.delete_auth_user_data()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, storage
AS $$
BEGIN
  -- Every private account file is stored under its auth user ID as the first folder.
  PERFORM set_config('storage.allow_delete_query', 'true', true);
  DELETE FROM storage.objects
  WHERE bucket_id IN ('kyc-documents', 'property-images', 'property-verification-documents')
    AND (storage.foldername(name))[1] = OLD.id::text;

  -- The user profile owns account records. Existing ON DELETE CASCADE rules remove
  -- properties, documents, media, amenities, favorites, saved searches, and agent data.
  DELETE FROM public.users
  WHERE id = OLD.id;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_deleted ON auth.users;
CREATE TRIGGER on_auth_user_deleted
  BEFORE DELETE ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.delete_auth_user_data();

REVOKE ALL ON FUNCTION public.delete_auth_user_data() FROM PUBLIC;
