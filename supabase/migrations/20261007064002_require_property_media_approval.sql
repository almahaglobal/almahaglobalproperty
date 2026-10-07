-- Require administrator approval for uploaded listing photos/videos before
-- exposing them publicly or publishing newly submitted properties.
ALTER TABLE public.property_media
  ADD COLUMN IF NOT EXISTS approval_status VARCHAR(20) NOT NULL DEFAULT 'pending_review'
    CHECK (approval_status IN ('pending_review', 'approved', 'rejected')),
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
  ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMP WITH TIME ZONE;

-- Preserve media visibility for listings that were already public.
UPDATE public.property_media AS media
SET approval_status = 'approved'
FROM public.properties AS property
WHERE property.id = media.property_id
  AND property.status IN ('available', 'approved', 'verified')
  AND media.approval_status = 'pending_review';

DROP POLICY IF EXISTS property_media_public_published_select ON public.property_media;
CREATE POLICY property_media_public_published_select ON public.property_media
  FOR SELECT TO anon, authenticated
  USING (
    approval_status = 'approved'
    AND EXISTS (
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
        AND published_media.approval_status = 'approved'
        AND published_property.status IN ('available', 'approved', 'verified')
    )
  );

CREATE OR REPLACE FUNCTION private.publish_property_when_approved(target_property_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  required_document_count INTEGER;
  approved_document_count INTEGER;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Administrator approval required';
  END IF;

  SELECT CASE WHEN account.role = 'agent' THEN 4 ELSE 2 END
  INTO required_document_count
  FROM public.properties AS property
  LEFT JOIN public.users AS account ON account.id = property.owner_id
  WHERE property.id = target_property_id
  FOR UPDATE OF property;

  IF required_document_count IS NULL THEN
    RAISE EXCEPTION 'Property not found';
  END IF;

  SELECT COUNT(*) FILTER (WHERE status = 'approved')
  INTO approved_document_count
  FROM public.property_verification_documents
  WHERE property_id = target_property_id;

  IF approved_document_count >= required_document_count
    AND EXISTS (
      SELECT 1
      FROM public.property_media
      WHERE property_id = target_property_id
        AND media_type = 'image'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.property_media
      WHERE property_id = target_property_id
        AND media_type IN ('image', 'video')
        AND approval_status <> 'approved'
    )
  THEN
    UPDATE public.properties
    SET status = 'verified',
        is_verified = true,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = target_property_id
      AND status NOT IN ('available', 'approved', 'verified');
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION private.publish_property_when_approved(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.review_property_media(
  target_media_id UUID,
  decision VARCHAR,
  reason TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_property_id UUID;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Administrator approval required';
  END IF;

  IF decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Decision must be approved or rejected';
  END IF;

  UPDATE public.property_media
  SET approval_status = decision,
      rejection_reason = CASE WHEN decision = 'rejected' THEN reason ELSE NULL END,
      reviewed_by = auth.uid(),
      reviewed_at = CURRENT_TIMESTAMP
  WHERE id = target_media_id
  RETURNING property_id INTO target_property_id;

  IF target_property_id IS NULL THEN
    RAISE EXCEPTION 'Property media not found';
  END IF;

  IF decision = 'approved' THEN
    PERFORM private.publish_property_when_approved(target_property_id);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.review_property_media(UUID, VARCHAR, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_property_media(UUID, VARCHAR, TEXT) TO authenticated;

-- Document approval alone must not publish a property until its listing media
-- has also passed review.
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
  target_property_id UUID;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Administrator approval required';
  END IF;

  IF decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Decision must be approved or rejected';
  END IF;

  UPDATE public.property_verification_documents
  SET status = decision,
      rejection_reason = CASE WHEN decision = 'rejected' THEN reason ELSE NULL END,
      reviewed_by = auth.uid(),
      reviewed_at = CURRENT_TIMESTAMP
  WHERE id = target_document_id
  RETURNING property_id INTO target_property_id;

  IF target_property_id IS NULL THEN
    RAISE EXCEPTION 'Property verification document not found';
  END IF;

  IF decision = 'rejected' THEN
    UPDATE public.properties
    SET status = 'documents_required',
        is_verified = false,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = target_property_id
      AND status NOT IN ('available', 'approved', 'verified');
    RETURN;
  END IF;

  PERFORM private.publish_property_when_approved(target_property_id);
END;
$$;

REVOKE ALL ON FUNCTION public.review_property_verification_document(UUID, VARCHAR, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_property_verification_document(UUID, VARCHAR, TEXT) TO authenticated;