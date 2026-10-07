ALTER TABLE public.users ADD COLUMN IF NOT EXISTS whatsapp_number VARCHAR(50);

-- Returns only the WhatsApp-capable phone number (digits) of the dealer for a published listing.
-- Other user columns stay private.
CREATE OR REPLACE FUNCTION public.get_property_whatsapp(target_property_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT NULLIF(regexp_replace(COALESCE(
    NULLIF(btrim(dealer.whatsapp_number), ''),
    NULLIF(btrim(dealer.mobile_phone), ''),
    NULLIF(btrim(dealer.phone), '')
  ), '[^0-9]', '', 'g'), '')
  FROM public.properties AS property
  LEFT JOIN public.agents AS agent ON agent.id = property.agent_id
  JOIN public.users AS dealer ON dealer.id = COALESCE(agent.user_id, property.owner_id)
  WHERE property.id = target_property_id
    AND property.status IN ('available', 'approved', 'verified')
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.get_property_whatsapp(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_property_whatsapp(UUID) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

