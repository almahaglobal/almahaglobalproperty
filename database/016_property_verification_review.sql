-- Prevent owners from self-publishing, and allow approved admins to review per-property evidence.
DROP POLICY IF EXISTS properties_owner_update ON public.properties;
CREATE POLICY properties_owner_update ON public.properties
  FOR UPDATE TO authenticated
  USING (owner_id = auth.uid() OR public.is_admin())
  WITH CHECK (
    public.is_admin()
    OR (owner_id = auth.uid() AND status IN ('draft', 'under_review'))
  );

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
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Administrator approval required';
  END IF;

  IF decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Decision must be approved or rejected';
  END IF;

  SELECT property_id INTO v_property_id
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
    SET status = 'documents_required', updated_at = CURRENT_TIMESTAMP
    WHERE id = v_property_id;
  ELSIF NOT EXISTS (
    SELECT 1
    FROM public.property_verification_documents
    WHERE property_id = v_property_id
      AND status <> 'approved'
  ) THEN
    UPDATE public.properties
    SET status = 'verified', updated_at = CURRENT_TIMESTAMP
    WHERE id = v_property_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.review_property_verification_document(UUID, VARCHAR, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.review_property_verification_document(UUID, VARCHAR, TEXT) TO authenticated;
