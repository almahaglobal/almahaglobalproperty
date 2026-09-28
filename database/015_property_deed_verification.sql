-- Each property requires its own private ownership and identity evidence.
CREATE TABLE IF NOT EXISTS public.property_verification_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  owner_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  document_type VARCHAR(30) NOT NULL CHECK (document_type IN ('title_deed', 'owner_identity')),
  storage_path TEXT NOT NULL,
  original_filename VARCHAR(255) NOT NULL,
  mime_type VARCHAR(100) NOT NULL CHECK (mime_type IN ('application/pdf', 'image/jpeg', 'image/png')),
  status VARCHAR(30) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  rejection_reason TEXT,
  reviewed_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (property_id, document_type)
);

CREATE INDEX IF NOT EXISTS property_verification_documents_property_id_idx
  ON public.property_verification_documents(property_id);

ALTER TABLE public.property_verification_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS property_verification_owner_select ON public.property_verification_documents;
CREATE POLICY property_verification_owner_select ON public.property_verification_documents
  FOR SELECT TO authenticated
  USING (owner_id = auth.uid() OR public.is_admin());

DROP POLICY IF EXISTS property_verification_owner_insert ON public.property_verification_documents;
CREATE POLICY property_verification_owner_insert ON public.property_verification_documents
  FOR INSERT TO authenticated
  WITH CHECK (
    owner_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.properties
      WHERE properties.id = property_verification_documents.property_id
        AND properties.owner_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS property_verification_admin_update ON public.property_verification_documents;
CREATE POLICY property_verification_admin_update ON public.property_verification_documents
  FOR UPDATE TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

INSERT INTO storage.buckets (id, name, public)
VALUES ('property-verification-documents', 'property-verification-documents', false)
ON CONFLICT (id) DO UPDATE SET public = false;

DROP POLICY IF EXISTS property_verification_storage_insert ON storage.objects;
CREATE POLICY property_verification_storage_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'property-verification-documents'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS property_verification_storage_select ON storage.objects;
CREATE POLICY property_verification_storage_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'property-verification-documents'
    AND ((storage.foldername(name))[1] = auth.uid()::text OR public.is_admin())
  );

DROP POLICY IF EXISTS property_verification_storage_delete ON storage.objects;
CREATE POLICY property_verification_storage_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'property-verification-documents'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
