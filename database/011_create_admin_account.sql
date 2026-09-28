BEGIN;

ALTER TABLE public.users DISABLE TRIGGER protect_user_security_fields_trigger;

DO $$
DECLARE
  v_auth_user_id UUID;
  v_admin_password TEXT;
BEGIN
  SELECT id INTO v_auth_user_id
  FROM auth.users
  WHERE email = 'almahaglobalproperty@gmail.com';

  IF v_auth_user_id IS NULL THEN
    v_admin_password := current_setting('app.admin_initial_password', true);
    IF v_admin_password IS NULL OR v_admin_password = '' THEN
      RAISE EXCEPTION 'Set app.admin_initial_password before creating the initial admin account.';
    END IF;

    INSERT INTO auth.users (
      id,
      instance_id,
      aud,
      role,
      email,
      encrypted_password,
      email_confirmed_at,
      raw_app_meta_data,
      raw_user_meta_data,
      created_at,
      updated_at,
      is_super_admin
    )
    VALUES (
      gen_random_uuid(),
      '00000000-0000-0000-0000-000000000000',
      'authenticated',
      'authenticated',
      'almahaglobalproperty@gmail.com',
      crypt(v_admin_password, gen_salt('bf')),
      NOW(),
      '{"provider":"email","providers":["email"]}',
      '{"full_name":"Al Maha Global Property Admin","role":"admin"}',
      NOW(),
      NOW(),
      false
    )
    RETURNING id INTO v_auth_user_id;
  END IF;

  INSERT INTO public.users (
    id,
    email,
    full_name,
    username,
    first_name,
    last_name,
    role,
    verification_status,
    is_verified,
    created_at,
    updated_at,
    password_hash
  )
  VALUES (
    v_auth_user_id,
    'almahaglobalproperty@gmail.com',
    'Al Maha Global Property Admin',
    'almahaglobalproperty',
    'Al Maha',
    'Global Property',
    'admin',
    'approved',
    true,
    NOW(),
    NOW(),
    NULL
  )
  ON CONFLICT (id) DO UPDATE
  SET
    email = EXCLUDED.email,
    full_name = EXCLUDED.full_name,
    username = EXCLUDED.username,
    first_name = EXCLUDED.first_name,
    last_name = EXCLUDED.last_name,
    role = EXCLUDED.role,
    verification_status = EXCLUDED.verification_status,
    is_verified = EXCLUDED.is_verified,
    updated_at = NOW();

  INSERT INTO auth.identities (
    provider_id,
    user_id,
    identity_data,
    provider,
    created_at,
    updated_at
  )
  VALUES (
    v_auth_user_id::text,
    v_auth_user_id,
    jsonb_build_object(
      'sub', v_auth_user_id::text,
      'email', 'almahaglobalproperty@gmail.com',
      'email_verified', true,
      'phone_verified', false
    ),
    'email',
    NOW(),
    NOW()
  )
  ON CONFLICT (provider_id, provider) DO NOTHING;
END $$;

ALTER TABLE public.users ENABLE TRIGGER protect_user_security_fields_trigger;

COMMIT;

SELECT a.id AS auth_id,
       u.id AS public_id,
       a.email,
       u.role,
       u.verification_status,
       u.full_name
FROM auth.users a
JOIN public.users u ON u.id = a.id
WHERE a.email = 'almahaglobalproperty@gmail.com';
