-- Keep one pending document per user and document type.
-- Storage duplicates are removed through the Supabase Storage API.

WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY user_id, document_type
           ORDER BY created_at, id
         ) AS row_number
  FROM public.kyc_documents
  WHERE status = 'pending'
)
DELETE FROM public.kyc_documents
WHERE id IN (SELECT id FROM ranked WHERE row_number > 1);

CREATE UNIQUE INDEX IF NOT EXISTS kyc_documents_one_pending_type
  ON public.kyc_documents (user_id, document_type)
  WHERE status = 'pending';
