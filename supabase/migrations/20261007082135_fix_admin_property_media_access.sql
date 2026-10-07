-- Approved administrators must always be able to read every property photo/video and verification file for review.
GRANT SELECT ON public.property_media TO authenticated;

DROP POLICY IF EXISTS property_media_admin_select ON public.property_media;
CREATE POLICY property_media_admin_select ON public.property_media
  FOR SELECT TO authenticated
  USING (public.is_admin());

DROP POLICY IF EXISTS property_images_admin_select ON storage.objects;
CREATE POLICY property_images_admin_select ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'property-images' AND public.is_admin());

DROP POLICY IF EXISTS property_verification_admin_select ON storage.objects;
CREATE POLICY property_verification_admin_select ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'property-verification-documents' AND public.is_admin());

DROP POLICY IF EXISTS property_verification_documents_admin_select ON public.property_verification_documents;
CREATE POLICY property_verification_documents_admin_select ON public.property_verification_documents
  FOR SELECT TO authenticated
  USING (public.is_admin());
