-- Admin review helpers for account verification.
-- Existing review_kyc_document() remains the single-document audit action.

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.users
    WHERE id = auth.uid()
      AND role = 'admin'
      AND verification_status = 'approved'
  );
$$;

CREATE OR REPLACE FUNCTION public.review_kyc_account(
  target_user_id UUID,
  decision VARCHAR,
  reason TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Administrator approval required';
  END IF;

  IF decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Decision must be approved or rejected';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = target_user_id AND role IN ('owner', 'agent')
  ) THEN
    RAISE EXCEPTION 'Owner or agent account not found';
  END IF;

  UPDATE public.kyc_documents
  SET status = decision,
      rejection_reason = CASE WHEN decision = 'rejected' THEN reason ELSE NULL END,
      reviewed_by = auth.uid(),
      reviewed_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  WHERE user_id = target_user_id
    AND status = 'pending';

  UPDATE public.users
  SET verification_status = CASE WHEN decision = 'approved' THEN 'approved' ELSE 'rejected' END,
      verified_by = auth.uid(),
      verified_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  WHERE id = target_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.review_kyc_account(UUID, VARCHAR, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.review_kyc_account(UUID, VARCHAR, TEXT) TO authenticated;
