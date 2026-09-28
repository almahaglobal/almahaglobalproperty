-- Private KYC storage for owner and agent verification documents.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'kyc-documents',
  'kyc-documents',
  FALSE,
  10485760,
  ARRAY['application/pdf', 'image/jpeg', 'image/png']
)
ON CONFLICT (id) DO UPDATE SET
  public = FALSE,
  file_size_limit = 10485760,
  allowed_mime_types = ARRAY['application/pdf', 'image/jpeg', 'image/png'];

DROP POLICY IF EXISTS kyc_storage_insert_own ON storage.objects;
CREATE POLICY kyc_storage_insert_own
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'kyc-documents'
    AND (storage.foldername(name))[1] = (SELECT auth.uid()::text)
  );

DROP POLICY IF EXISTS kyc_storage_select_own_or_admin ON storage.objects;
CREATE POLICY kyc_storage_select_own_or_admin
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'kyc-documents'
    AND (
      (storage.foldername(name))[1] = (SELECT auth.uid()::text)
      OR public.is_admin()
    )
  );

DROP POLICY IF EXISTS kyc_storage_update_admin ON storage.objects;
CREATE POLICY kyc_storage_update_admin
  ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (bucket_id = 'kyc-documents' AND public.is_admin())
  WITH CHECK (bucket_id = 'kyc-documents' AND public.is_admin());
