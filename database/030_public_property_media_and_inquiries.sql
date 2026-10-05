-- Allow public visitors to read media only for listings approved for publication.
DROP POLICY IF EXISTS property_media_public_published_select ON public.property_media;
CREATE POLICY property_media_public_published_select ON public.property_media
  FOR SELECT TO anon, authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.properties AS published_property
      WHERE published_property.id = property_media.property_id
        AND published_property.status IN ('available', 'approved', 'verified')
    )
  );

DROP POLICY IF EXISTS property_images_published_select ON storage.objects;
CREATE POLICY property_images_published_select ON storage.objects
  FOR SELECT TO anon, authenticated
  USING (
    bucket_id = 'property-images'
    AND EXISTS (
      SELECT 1
      FROM public.property_media AS published_media
      JOIN public.properties AS published_property
        ON published_property.id = published_media.property_id
      WHERE published_media.url = storage.objects.name
        AND published_media.media_type IN ('image', 'video')
        AND published_property.status IN ('available', 'approved', 'verified')
    )
  );

-- Property enquiries can be submitted publicly, but only relevant staff can read them.
CREATE INDEX IF NOT EXISTS property_inquiries_property_created_idx
  ON public.property_inquiries(property_id, created_at DESC);

REVOKE INSERT ON public.property_inquiries FROM PUBLIC, anon, authenticated;
GRANT INSERT (
  property_id, agent_id, name, phone, email, message,
  project_id, project_unit_type_id, budget, consent
) ON public.property_inquiries TO anon, authenticated;
GRANT SELECT ON public.property_inquiries TO authenticated;

DROP POLICY IF EXISTS project_inquiries_public_insert ON public.property_inquiries;
DROP POLICY IF EXISTS property_inquiries_public_insert ON public.property_inquiries;
CREATE POLICY property_inquiries_public_insert ON public.property_inquiries
  FOR INSERT TO anon, authenticated
  WITH CHECK (
    consent = true
    AND (
      (project_id IS NOT NULL AND property_id IS NULL)
      OR (
        property_id IS NOT NULL
        AND project_id IS NULL
        AND EXISTS (
          SELECT 1
          FROM public.properties AS published_property
          WHERE published_property.id = property_inquiries.property_id
            AND published_property.status IN ('available', 'approved', 'verified')
            AND (
              property_inquiries.agent_id IS NULL
              OR property_inquiries.agent_id = published_property.agent_id
            )
        )
      )
    )
  );

DROP POLICY IF EXISTS project_inquiries_manager_read ON public.property_inquiries;
DROP POLICY IF EXISTS property_inquiries_manager_read ON public.property_inquiries;
CREATE POLICY property_inquiries_manager_read ON public.property_inquiries
  FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR (project_id IS NOT NULL AND public.can_manage_project(project_id))
    OR EXISTS (
      SELECT 1 FROM public.properties AS inquired_property
      WHERE inquired_property.id = property_inquiries.property_id
        AND (
          inquired_property.owner_id = (SELECT auth.uid())
          OR EXISTS (
            SELECT 1 FROM public.agents AS assigned_agent
            WHERE assigned_agent.id = inquired_property.agent_id
              AND assigned_agent.user_id = (SELECT auth.uid())
          )
        )
    )
  );