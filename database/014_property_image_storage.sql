-- Private property-photo storage. Files remain visible only to their owner or an approved administrator.
INSERT INTO storage.buckets (id, name, public)
VALUES ('property-images', 'property-images', false)
ON CONFLICT (id) DO UPDATE SET public = false;

ALTER TABLE public.property_media ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS property_media_owner_select ON public.property_media;
CREATE POLICY property_media_owner_select ON public.property_media
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.properties
      WHERE properties.id = property_media.property_id
        AND (properties.owner_id = auth.uid() OR public.is_admin())
    )
  );

DROP POLICY IF EXISTS property_media_owner_insert ON public.property_media;
CREATE POLICY property_media_owner_insert ON public.property_media
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.properties
      WHERE properties.id = property_media.property_id
        AND properties.owner_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS property_images_owner_insert ON storage.objects;
CREATE POLICY property_images_owner_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'property-images'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS property_images_owner_select ON storage.objects;
CREATE POLICY property_images_owner_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'property-images'
    AND ((storage.foldername(name))[1] = auth.uid()::text OR public.is_admin())
  );

DROP POLICY IF EXISTS property_images_owner_delete ON storage.objects;
CREATE POLICY property_images_owner_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'property-images'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
