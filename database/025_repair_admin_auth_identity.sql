-- Repair the manually bootstrapped admin account if its email identity is missing.
INSERT INTO auth.identities (
  provider_id,
  user_id,
  identity_data,
  provider,
  created_at,
  updated_at
)
SELECT
  auth_user.id::text,
  auth_user.id,
  jsonb_build_object(
    'sub', auth_user.id::text,
    'email', auth_user.email,
    'email_verified', auth_user.email_confirmed_at IS NOT NULL,
    'phone_verified', false
  ),
  'email',
  NOW(),
  NOW()
FROM auth.users AS auth_user
WHERE auth_user.email = 'almahaglobalproperty@gmail.com'
  AND NOT EXISTS (
    SELECT 1
    FROM auth.identities AS auth_identity
    WHERE auth_identity.user_id = auth_user.id
      AND auth_identity.provider = 'email'
  )
ON CONFLICT (provider_id, provider) DO NOTHING;