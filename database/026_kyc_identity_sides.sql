-- Keep front and back identity images as separately reviewable KYC documents.
ALTER TABLE public.kyc_documents
  DROP CONSTRAINT IF EXISTS kyc_documents_document_type_check;

ALTER TABLE public.kyc_documents
  ADD CONSTRAINT kyc_documents_document_type_check
  CHECK (
    document_type IN (
      'identity_document', 'identity_front', 'identity_back', 'passport_copy',
      'property_deed', 'additional_ownership_document', 'purchase_agreement',
      'power_of_attorney', 'agency_license'
    )
    OR document_type ~ '^supporting_document_[1-9][0-9]*$'
  );

DROP POLICY IF EXISTS kyc_insert_own_pending ON public.kyc_documents;
CREATE POLICY kyc_insert_own_pending ON public.kyc_documents
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND status = 'pending'
    AND EXISTS (
      SELECT 1
      FROM public.users AS uploader
      WHERE uploader.id = (SELECT auth.uid())
        AND (
          (document_type IN ('identity_document', 'identity_front', 'identity_back', 'passport_copy') AND uploader.role IN ('owner', 'agent'))
          OR (document_type IN ('property_deed', 'additional_ownership_document', 'purchase_agreement', 'power_of_attorney') AND uploader.role = 'owner')
          OR (document_type ~ '^supporting_document_[1-9][0-9]*$' AND uploader.role = 'owner')
          OR (document_type = 'agency_license' AND uploader.role = 'agent')
        )
    )
  );