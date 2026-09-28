-- Public agent directory: expose only safe, non-sensitive fields for approved agents.
-- Avoids widening the RLS policy on public.users (which would leak email/phone/etc. to anyone).

CREATE OR REPLACE FUNCTION public.get_public_agents()
RETURNS TABLE (
  id UUID,
  full_name VARCHAR,
  company_name VARCHAR,
  avatar_url TEXT,
  created_at TIMESTAMP WITH TIME ZONE
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id, full_name, company_name, avatar_url, created_at
  FROM public.users
  WHERE role = 'agent'
    AND verification_status = 'approved'
  ORDER BY created_at DESC;
$$;

GRANT EXECUTE ON FUNCTION public.get_public_agents() TO anon, authenticated;
