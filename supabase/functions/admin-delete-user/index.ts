import { withSupabase } from 'npm:@supabase/server@1';

const allowedOrigins = new Set([
  'https://www.almahaglobalproperty.com',
  'http://127.0.0.1:50758',
  'http://localhost:50758'
]);

function corsHeaders(request: Request) {
  const origin = request.headers.get('origin') || '';
  return {
    'Access-Control-Allow-Origin': allowedOrigins.has(origin) ? origin : 'https://www.almahaglobalproperty.com',
    'Access-Control-Allow-Headers': 'authorization, apikey, x-client-info, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin'
  };
}

const handler = withSupabase({ auth: 'user' }, async (request, context) => {
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed.' }, { status: 405 });
  }

  const callerId = context.userClaims?.id;
  if (!callerId) return Response.json({ error: 'Authentication required.' }, { status: 401 });

  const { data: caller, error: callerError } = await context.supabase
    .from('users')
    .select('role, verification_status')
    .eq('id', callerId)
    .maybeSingle();

  const adminRoles = ['admin', 'platform_owner', 'company_owner', 'company_admin', 'staff'];
  if (callerError || !caller || !adminRoles.includes(caller.role) || caller.verification_status !== 'approved') {
    return Response.json({ error: 'Approved administrator access required.' }, { status: 403 });
  }

  let body: { targetUserId?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'A valid JSON request body is required.' }, { status: 400 });
  }

  const targetUserId = body.targetUserId || '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(targetUserId)) {
    return Response.json({ error: 'A valid account ID is required.' }, { status: 400 });
  }
  if (targetUserId === callerId) {
    return Response.json({ error: 'You cannot delete your own administrator account.' }, { status: 400 });
  }

  const { data: target } = await context.supabaseAdmin
    .from('users')
    .select('email, role')
    .eq('id', targetUserId)
    .maybeSingle();

  if (!target) return Response.json({ error: 'Account not found.' }, { status: 404 });

  const privilegedRoles = ['admin', 'platform_owner', 'company_owner', 'company_admin', 'staff'];
  if (privilegedRoles.includes(target.role)) {
    const canManageAdmins = ['platform_owner', 'company_owner', 'admin'].includes(caller.role);
    if (!canManageAdmins) return Response.json({ error: 'You cannot delete administrator accounts.' }, { status: 403 });
    if (target.role === 'platform_owner' && caller.role !== 'platform_owner') {
      return Response.json({ error: 'Only a platform owner can delete another platform owner.' }, { status: 403 });
    }
    if (target.role === 'company_owner' && !['platform_owner', 'company_owner'].includes(caller.role)) {
      return Response.json({ error: 'Only an owner can delete a company owner.' }, { status: 403 });
    }
  }

  const { error: auditError } = await context.supabase.rpc('log_admin_action', {
    p_action: 'account_deletion_requested',
    p_target_table: 'auth.users',
    p_target_id: targetUserId,
    p_previous_value: { email: target.email, role: target.role }
  });
  if (auditError) return Response.json({ error: auditError.message }, { status: 500 });

  const { error: deleteError } = await context.supabaseAdmin.auth.admin.deleteUser(targetUserId, false);
  if (deleteError) return Response.json({ error: deleteError.message }, { status: 500 });

  return Response.json({ deleted: true, userId: targetUserId });
});

Deno.serve(async request => {
  const headers = corsHeaders(request);
  if (request.method === 'OPTIONS') return new Response('ok', { headers });

  try {
    const response = await handler(request);
    const responseHeaders = new Headers(response.headers);
    for (const [key, value] of Object.entries(headers)) responseHeaders.set(key, value);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: responseHeaders });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Account deletion failed.' }, { status: 500, headers });
  }
});