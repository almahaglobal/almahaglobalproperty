-- Security and KYC hardening for Supabase/PostgreSQL.
-- Passwords must be managed by an auth provider (for example Supabase Auth), never by the browser.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('buyer', 'tenant', 'owner', 'agent', 'admin'));

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS verification_status VARCHAR(30) NOT NULL DEFAULT 'pending_verification',
  ADD COLUMN IF NOT EXISTS mobile_phone VARCHAR(50),
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS verified_by UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_verification_status_check;

ALTER TABLE users
  ADD CONSTRAINT users_verification_status_check
  CHECK (verification_status IN ('pending_verification', 'approved', 'rejected', 'suspended'));

CREATE OR REPLACE FUNCTION protect_user_security_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role
     OR NEW.verification_status IS DISTINCT FROM OLD.verification_status
     OR NEW.verified_by IS DISTINCT FROM OLD.verified_by
     OR NEW.verified_at IS DISTINCT FROM OLD.verified_at THEN
    IF NOT EXISTS (
      SELECT 1
      FROM users
      WHERE id = auth.uid()
        AND role = 'admin'
        AND verification_status = 'approved'
    ) THEN
      RAISE EXCEPTION 'Only an approved administrator can change security fields';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_user_security_fields_trigger ON users;
CREATE TRIGGER protect_user_security_fields_trigger
  BEFORE UPDATE ON users
  FOR EACH ROW
  EXECUTE FUNCTION protect_user_security_fields();

CREATE TABLE IF NOT EXISTS kyc_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    document_type VARCHAR(30) NOT NULL CHECK (document_type IN ('identity_document', 'property_deed', 'agency_license')),
    storage_path TEXT NOT NULL,
    original_filename VARCHAR(255) NOT NULL,
    mime_type VARCHAR(100) NOT NULL CHECK (mime_type IN ('application/pdf', 'image/jpeg', 'image/png')),
    status VARCHAR(30) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    rejection_reason TEXT,
    reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE kyc_documents
  DROP CONSTRAINT IF EXISTS kyc_documents_document_type_check;

ALTER TABLE kyc_documents
  ADD CONSTRAINT kyc_documents_document_type_check
  CHECK (document_type IN ('identity_document', 'property_deed', 'agency_license'));

CREATE INDEX IF NOT EXISTS kyc_documents_user_id_idx ON kyc_documents(user_id);
CREATE INDEX IF NOT EXISTS kyc_documents_status_idx ON kyc_documents(status);

CREATE OR REPLACE FUNCTION is_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM users
    WHERE id = auth.uid()
      AND role = 'admin'
      AND verification_status = 'approved'
  );
$$;

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE kyc_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS users_select_self_or_admin ON users;
CREATE POLICY users_select_self_or_admin ON users
  FOR SELECT
  USING (id = auth.uid() OR is_admin());

DROP POLICY IF EXISTS users_update_self_contact ON users;
CREATE POLICY users_update_self_contact ON users
  FOR UPDATE
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

DROP POLICY IF EXISTS users_admin_all ON users;
CREATE POLICY users_admin_all ON users
  FOR ALL
  USING (is_admin())
  WITH CHECK (is_admin());

DROP POLICY IF EXISTS kyc_insert_own_pending ON kyc_documents;
CREATE POLICY kyc_insert_own_pending ON kyc_documents
  FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND status = 'pending'
    AND (
      (document_type = 'identity_document' AND (SELECT role FROM users WHERE id = auth.uid()) IN ('owner', 'agent'))
      OR
      (document_type = 'property_deed' AND (SELECT role FROM users WHERE id = auth.uid()) = 'owner')
      OR
      (document_type = 'agency_license' AND (SELECT role FROM users WHERE id = auth.uid()) = 'agent')
    )
  );

DROP POLICY IF EXISTS kyc_select_own_or_admin ON kyc_documents;
CREATE POLICY kyc_select_own_or_admin ON kyc_documents
  FOR SELECT
  USING (user_id = auth.uid() OR is_admin());

DROP POLICY IF EXISTS kyc_admin_review ON kyc_documents;
CREATE POLICY kyc_admin_review ON kyc_documents
  FOR UPDATE
  USING (is_admin())
  WITH CHECK (is_admin());

CREATE OR REPLACE FUNCTION review_kyc_document(
  document_id UUID,
  decision VARCHAR,
  reason TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  document_user_id UUID;
  document_role VARCHAR;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Administrator approval required';
  END IF;

  IF decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Decision must be approved or rejected';
  END IF;

  SELECT user_id INTO document_user_id
  FROM kyc_documents
  WHERE id = document_id;

  IF document_user_id IS NULL THEN
    RAISE EXCEPTION 'KYC document not found';
  END IF;

  UPDATE kyc_documents
  SET status = decision,
      rejection_reason = CASE WHEN decision = 'rejected' THEN reason ELSE NULL END,
      reviewed_by = auth.uid(),
      reviewed_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  WHERE id = document_id;

  SELECT role INTO document_role FROM users WHERE id = document_user_id;

  IF decision = 'rejected' THEN
    UPDATE users
    SET verification_status = 'rejected', verified_by = auth.uid(), verified_at = CURRENT_TIMESTAMP
    WHERE id = document_user_id;
  ELSIF NOT EXISTS (
    SELECT 1 FROM kyc_documents
    WHERE user_id = document_user_id AND status <> 'approved'
  ) THEN
    UPDATE users
    SET verification_status = 'approved', verified_by = auth.uid(), verified_at = CURRENT_TIMESTAMP
    WHERE id = document_user_id AND document_role IN ('owner', 'agent');
  END IF;
END;
$$;

-- Storage objects should be kept in a private bucket named `kyc-documents`.
-- Apply equivalent storage.objects policies in Supabase Storage, allowing users
-- to upload only to a path beginning with their own auth.uid(), and admins to review.
