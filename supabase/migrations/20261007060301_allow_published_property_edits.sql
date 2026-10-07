-- Allow owners to edit listing details after publication, while keeping
-- ownership and moderation fields protected from client-side changes.
CREATE OR REPLACE FUNCTION public.protect_property_moderation_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (SELECT auth.uid()) IS NOT NULL AND NOT public.is_admin() THEN
    IF NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
      RAISE EXCEPTION 'Property ownership cannot be changed by a listing owner';
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status
      OR NEW.is_verified IS DISTINCT FROM OLD.is_verified THEN
      RAISE EXCEPTION 'Property verification status can only be changed by an administrator';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.protect_property_moderation_fields() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS protect_property_moderation_fields ON public.properties;
CREATE TRIGGER protect_property_moderation_fields
  BEFORE UPDATE ON public.properties
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_property_moderation_fields();

DROP POLICY IF EXISTS properties_owner_update ON public.properties;
CREATE POLICY properties_owner_update ON public.properties
  FOR UPDATE TO authenticated
  USING (owner_id = (SELECT auth.uid()) OR public.is_admin())
  WITH CHECK (owner_id = (SELECT auth.uid()) OR public.is_admin());