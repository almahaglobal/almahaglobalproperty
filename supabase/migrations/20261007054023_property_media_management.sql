-- Let property owners, assigned agents, project managers, and approved admins
-- manage listing media without granting access to unrelated uploads.
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA private TO authenticated;

CREATE OR REPLACE FUNCTION private.can_manage_property_media(target_property_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.properties AS managed_property
      WHERE managed_property.id = target_property_id
        AND (
          managed_property.owner_id = auth.uid()
          OR public.is_admin()
          OR EXISTS (
            SELECT 1
            FROM public.agents AS assigned_agent
            WHERE assigned_agent.id = managed_property.agent_id
              AND assigned_agent.user_id = auth.uid()
          )
          OR (
            managed_property.project_id IS NOT NULL
            AND public.can_manage_project(managed_property.project_id)
          )
        )
    );
$$;

REVOKE ALL ON FUNCTION private.can_manage_property_media(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.can_manage_property_media(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.can_manage_property_media(target_property_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT private.can_manage_property_media(target_property_id);
$$;

REVOKE ALL ON FUNCTION public.can_manage_property_media(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_manage_property_media(UUID) TO authenticated;

DROP POLICY IF EXISTS property_media_manager_select ON public.property_media;
CREATE POLICY property_media_manager_select ON public.property_media
  FOR SELECT TO authenticated
  USING (private.can_manage_property_media(property_id));

DROP POLICY IF EXISTS property_media_manager_insert ON public.property_media;
CREATE POLICY property_media_manager_insert ON public.property_media
  FOR INSERT TO authenticated
  WITH CHECK (private.can_manage_property_media(property_id));

DROP POLICY IF EXISTS property_media_manager_update ON public.property_media;
CREATE POLICY property_media_manager_update ON public.property_media
  FOR UPDATE TO authenticated
  USING (private.can_manage_property_media(property_id))
  WITH CHECK (private.can_manage_property_media(property_id));

DROP POLICY IF EXISTS property_media_manager_delete ON public.property_media;
CREATE POLICY property_media_manager_delete ON public.property_media
  FOR DELETE TO authenticated
  USING (private.can_manage_property_media(property_id));

GRANT SELECT, INSERT, DELETE ON public.property_media TO authenticated;
REVOKE UPDATE ON public.property_media FROM PUBLIC, anon, authenticated;
GRANT UPDATE (is_primary) ON public.property_media TO authenticated;

-- Existing data may contain multiple primary flags or mark a video as primary.
UPDATE public.property_media
SET is_primary = false
WHERE is_primary = true
  AND media_type <> 'image';

WITH duplicate_primary_images AS (
  SELECT id,
         row_number() OVER (PARTITION BY property_id ORDER BY id) AS position
  FROM public.property_media
  WHERE is_primary = true
    AND media_type = 'image'
)
UPDATE public.property_media AS media
SET is_primary = false
FROM duplicate_primary_images AS duplicate
WHERE duplicate.id = media.id
  AND duplicate.position > 1;

CREATE UNIQUE INDEX IF NOT EXISTS property_media_one_primary_image_per_property
  ON public.property_media(property_id)
  WHERE is_primary = true AND media_type = 'image';

CREATE OR REPLACE FUNCTION public.set_primary_property_image(
  target_property_id UUID,
  target_media_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT private.can_manage_property_media(target_property_id) THEN
    RAISE EXCEPTION 'You are not allowed to manage this property''s media';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.property_media
    WHERE id = target_media_id
      AND property_id = target_property_id
      AND media_type = 'image'
  ) THEN
    RAISE EXCEPTION 'The selected property image was not found';
  END IF;

  UPDATE public.property_media
  SET is_primary = false
  WHERE property_id = target_property_id
    AND is_primary = true;

  UPDATE public.property_media
  SET is_primary = true
  WHERE id = target_media_id
    AND property_id = target_property_id;
END;
$$;

REVOKE ALL ON FUNCTION public.set_primary_property_image(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_primary_property_image(UUID, UUID) TO authenticated;

-- Property media paths use {uploader}/{property-id}/{filename}. Checking the
-- property folder allows authorized managers to read and remove shared media.
DROP POLICY IF EXISTS property_images_manager_select ON storage.objects;
CREATE POLICY property_images_manager_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'property-images'
    AND EXISTS (
      SELECT 1
      FROM public.properties AS managed_property
      WHERE managed_property.id::text = (storage.foldername(name))[2]
        AND private.can_manage_property_media(managed_property.id)
    )
  );

DROP POLICY IF EXISTS property_images_manager_delete ON storage.objects;
CREATE POLICY property_images_manager_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'property-images'
    AND EXISTS (
      SELECT 1
      FROM public.properties AS managed_property
      WHERE managed_property.id::text = (storage.foldername(name))[2]
        AND private.can_manage_property_media(managed_property.id)
    )
  );