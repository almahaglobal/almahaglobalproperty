-- Associate every owner-submitted listing with its authenticated account.
ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS country_code VARCHAR(2),
  ADD COLUMN IF NOT EXISTS city VARCHAR(100);

CREATE INDEX IF NOT EXISTS properties_owner_id_idx ON public.properties(owner_id);

ALTER TABLE public.properties ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.property_amenities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS properties_owner_select ON public.properties;
CREATE POLICY properties_owner_select ON public.properties
  FOR SELECT TO authenticated
  USING (owner_id = auth.uid() OR public.is_admin());

DROP POLICY IF EXISTS properties_owner_insert ON public.properties;
CREATE POLICY properties_owner_insert ON public.properties
  FOR INSERT TO authenticated
  WITH CHECK (
    owner_id = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM public.users
      WHERE id = auth.uid()
        AND role IN ('owner', 'agent')
        AND verification_status = 'approved'
    )
  );

DROP POLICY IF EXISTS properties_owner_update ON public.properties;
CREATE POLICY properties_owner_update ON public.properties
  FOR UPDATE TO authenticated
  USING (owner_id = auth.uid() OR public.is_admin())
  WITH CHECK (owner_id = auth.uid() OR public.is_admin());

DROP POLICY IF EXISTS property_amenities_owner_select ON public.property_amenities;
CREATE POLICY property_amenities_owner_select ON public.property_amenities
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.properties
      WHERE properties.id = property_amenities.property_id
        AND (properties.owner_id = auth.uid() OR public.is_admin())
    )
  );

DROP POLICY IF EXISTS property_amenities_owner_insert ON public.property_amenities;
CREATE POLICY property_amenities_owner_insert ON public.property_amenities
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.properties
      WHERE properties.id = property_amenities.property_id
        AND properties.owner_id = auth.uid()
    )
  );
