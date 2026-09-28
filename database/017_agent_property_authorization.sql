-- Per-property evidence differs for direct owners and authorised agencies.
ALTER TABLE public.property_verification_documents
  DROP CONSTRAINT IF EXISTS property_verification_documents_document_type_check;

ALTER TABLE public.property_verification_documents
  ADD CONSTRAINT property_verification_documents_document_type_check
  CHECK (document_type IN ('title_deed', 'owner_identity', 'agency_authorization', 'agency_license'));

ALTER TABLE public.property_verification_documents
  ADD COLUMN IF NOT EXISTS submitted_by_role VARCHAR(30);

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

  SELECT property_id, submitted_by_role
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
    SET status = 'documents_required', updated_at = CURRENT_TIMESTAMP
    WHERE id = v_property_id;
    RETURN;
  END IF;

  v_required_document_count := CASE WHEN v_submitter_role = 'agent' THEN 4 ELSE 2 END;
  IF (
    SELECT COUNT(*)
    FROM public.property_verification_documents
    WHERE property_id = v_property_id
      AND status = 'approved'
  ) = v_required_document_count THEN
    UPDATE public.properties
    SET status = 'verified', updated_at = CURRENT_TIMESTAMP
    WHERE id = v_property_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.review_property_verification_document(UUID, VARCHAR, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.review_property_verification_document(UUID, VARCHAR, TEXT) TO authenticated;
