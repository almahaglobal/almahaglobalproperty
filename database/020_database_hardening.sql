-- Corrective migration for live listing visibility, moderation, and verification consistency.

-- Public visitors may see only publishable property records. Owners and approved admins
-- retain access to their own records through the existing owner policy.
DROP POLICY IF EXISTS properties_public_select ON public.properties;
CREATE POLICY properties_public_select ON public.properties
  FOR SELECT TO anon, authenticated
  USING (status IN ('available', 'approved', 'verified'));

-- Property verification must publish an explicitly verified listing only after all
-- role-required documents are approved.
CREATE OR REPLACE FUNCTION public.review_property_verification_document(
  target_document_id UUID,
  decision VARCHAR,
  reason TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_property_id UUID;
  v_submitter_role VARCHAR;
  v_required_document_count INTEGER;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Administrator approval required';
  END IF;

  IF decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Decision must be approved or rejected';
  END IF;

  SELECT property_id, COALESCE(submitted_by_role, 'owner')
  INTO v_property_id, v_submitter_role
  FROM public.property_verification_documents
  WHERE id = target_document_id;

  IF v_property_id IS NULL THEN
    RAISE EXCEPTION 'Property verification document not found';
  END IF;

  UPDATE public.property_verification_documents
  SET status = decision,
      rejection_reason = CASE WHEN decision = 'rejected' THEN reason ELSE NULL END,
      reviewed_by = auth.uid(),
      reviewed_at = CURRENT_TIMESTAMP
  WHERE id = target_document_id;

  IF decision = 'rejected' THEN
    UPDATE public.properties
    SET status = 'documents_required', is_verified = false, updated_at = CURRENT_TIMESTAMP
    WHERE id = v_property_id;
    RETURN;
  END IF;

  v_required_document_count := CASE WHEN v_submitter_role = 'agent' THEN 4 ELSE 2 END;
  IF (
    SELECT COUNT(*)
    FROM public.property_verification_documents
    WHERE property_id = v_property_id
      AND status = 'approved'
  ) >= v_required_document_count THEN
    UPDATE public.properties
    SET status = 'verified', is_verified = true, updated_at = CURRENT_TIMESTAMP
    WHERE id = v_property_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.review_property_verification_document(UUID, VARCHAR, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.review_property_verification_document(UUID, VARCHAR, TEXT) TO authenticated;

-- Existing property verification records predate submitted_by_role. Preserve their
-- original direct-owner verification requirement.
UPDATE public.property_verification_documents
SET submitted_by_role = 'owner'
WHERE submitted_by_role IS NULL;

ALTER TABLE public.property_verification_documents
  ALTER COLUMN submitted_by_role SET DEFAULT 'owner';

-- Moderation and cleanup access for private property images.
DROP POLICY IF EXISTS property_media_admin_update ON public.property_media;
CREATE POLICY property_media_admin_update ON public.property_media
  FOR UPDATE TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS property_media_admin_delete ON public.property_media;
CREATE POLICY property_media_admin_delete ON public.property_media
  FOR DELETE TO authenticated
  USING (public.is_admin());

DROP POLICY IF EXISTS property_images_admin_select ON storage.objects;
CREATE POLICY property_images_admin_select ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'property-images' AND public.is_admin());

DROP POLICY IF EXISTS property_images_admin_delete ON storage.objects;
CREATE POLICY property_images_admin_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'property-images' AND public.is_admin());

-- Complete Off-Plan project ownership indexes and RLS management coverage.
CREATE INDEX IF NOT EXISTS project_assignments_project_idx ON public.project_assignments(project_id);
CREATE INDEX IF NOT EXISTS developer_members_developer_idx ON public.developer_members(developer_id);
CREATE INDEX IF NOT EXISTS project_construction_updates_project_idx ON public.project_construction_updates(project_id, update_date DESC);

DROP POLICY IF EXISTS project_construction_public_read ON public.project_construction_updates;
CREATE POLICY project_construction_public_read ON public.project_construction_updates
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = project_id
        AND (p.approval_status = 'approved' OR public.can_manage_project(p.id))
    )
  );

DROP POLICY IF EXISTS project_construction_manager_write ON public.project_construction_updates;
CREATE POLICY project_construction_manager_write ON public.project_construction_updates
  FOR ALL TO authenticated
  USING (public.can_manage_project(project_id))
  WITH CHECK (public.can_manage_project(project_id));

DROP POLICY IF EXISTS project_assignments_admin_write ON public.project_assignments;
CREATE POLICY project_assignments_admin_write ON public.project_assignments
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());
