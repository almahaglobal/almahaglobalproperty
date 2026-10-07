import { withSupabase } from 'npm:@supabase/server@1';
import nodemailer from 'npm:nodemailer@6.9.16';

const allowedOrigins = new Set([
  'https://www.almahaglobalproperty.com',
  'https://almahaglobalproperty.com',
  'http://127.0.0.1:50758',
  'http://localhost:50758',
  'http://127.0.0.1:4173'
]);
const senderAddress = 'almahaglobalproperty@gmail.com';

function corsHeaders(request: Request) {
  const origin = request.headers.get('origin') || '';
  return {
    'Access-Control-Allow-Origin': allowedOrigins.has(origin) ? origin : 'https://www.almahaglobalproperty.com',
    'Access-Control-Allow-Headers': 'authorization, apikey, x-client-info, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin'
  };
}

function base64(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64Url(bytes: Uint8Array) {
  return base64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

const handler = withSupabase({ auth: 'user' }, async (request, context) => {
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed.' }, { status: 405 });
  }

  const adminId = context.userClaims?.id;
  if (!adminId) return Response.json({ error: 'Authentication required.' }, { status: 401 });

  const { data: admin, error: adminError } = await context.supabase
    .from('users')
    .select('role, verification_status')
    .eq('id', adminId)
    .maybeSingle();
  const adminRoles = ['admin', 'platform_owner', 'company_owner', 'company_admin', 'staff'];
  if (adminError || !admin || !adminRoles.includes(admin.role) || admin.verification_status !== 'approved') {
    return Response.json({ error: 'Approved administrator access required.' }, { status: 403 });
  }

  const clientId = Deno.env.get('GMAIL_CLIENT_ID');
  const clientSecret = Deno.env.get('GMAIL_CLIENT_SECRET');
  const refreshToken = Deno.env.get('GMAIL_REFRESH_TOKEN');
  const configuredSender = Deno.env.get('GMAIL_SENDER_EMAIL')?.toLowerCase();
  const useGmail = !!(clientId && clientSecret && refreshToken && configuredSender === senderAddress);
  const smtpHost = Deno.env.get('SMTP_HOST');
  const smtpUser = Deno.env.get('SMTP_USER');
  const smtpPassword = Deno.env.get('SMTP_PASSWORD');
  const smtpPort = Number(Deno.env.get('SMTP_PORT') || 587);
  if (!useGmail && !(smtpHost && smtpUser && smtpPassword)) {
    return Response.json({ error: 'Email sending is not configured (set SMTP_* or GMAIL_* secrets).' }, { status: 503 });
  }
  let body: { messageId?: string; replyBody?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'A valid JSON request body is required.' }, { status: 400 });
  }

  const messageId = body.messageId || '';
  const replyBody = body.replyBody?.trim() || '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(messageId)) {
    return Response.json({ error: 'A valid message ID is required.' }, { status: 400 });
  }
  if (replyBody.length < 1 || replyBody.length > 10000) {
    return Response.json({ error: 'Reply must be between 1 and 10,000 characters.' }, { status: 400 });
  }

  const { data: message, error: messageError } = await context.supabase
    .from('contact_messages')
    .select('id, name, email, subject, status')
    .eq('id', messageId)
    .maybeSingle();
  if (messageError || !message) return Response.json({ error: 'Contact message not found.' }, { status: 404 });
  if (message.status === 'replied') return Response.json({ error: 'This message is already marked as replied.' }, { status: 409 });
  if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(message.email)) {
    return Response.json({ error: 'The customer email address is invalid.' }, { status: 400 });
  }

  if (!useGmail) {
    try {
      const transporter = nodemailer.createTransport({ host: smtpHost, port: smtpPort, secure: smtpPort === 465, auth: { user: smtpUser, pass: smtpPassword } });
      await transporter.sendMail({
        from: `Al Maha Global Property <${smtpUser!.includes('@') ? smtpUser : senderAddress}>`,
        to: message.email,
        replyTo: senderAddress,
        subject: `Re: ${message.subject.replace(/[\r\n]+/g, ' ').trim()}`,
        text: replyBody
      });
    } catch (error) {
      console.error('SMTP send failed:', error instanceof Error ? error.message : 'Unknown error');
      return Response.json({ error: 'SMTP could not send the reply. Check the SMTP settings.' }, { status: 502 });
    }
  } else {
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
  });
  const token = await tokenResponse.json();
  if (!tokenResponse.ok || !token.access_token) {
    console.error('Gmail OAuth refresh failed with status', tokenResponse.status);
    return Response.json({ error: 'Gmail authorization failed. Reconnect the configured Gmail account.' }, { status: 502 });
  }

  const subject = `Re: ${message.subject.replace(/[\r\n]+/g, ' ').trim()}`;
  const encodedSubject = base64(new TextEncoder().encode(subject));
  const encodedBody = base64(new TextEncoder().encode(replyBody)).match(/.{1,76}/g)?.join('\r\n') || '';
  const mimeMessage = [
    `From: Al Maha Global Property <${senderAddress}>`,
    `To: ${message.email}`,
    `Subject: =?UTF-8?B?${encodedSubject}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    encodedBody
  ].join('\r\n');

  const gmailResponse = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ raw: base64Url(new TextEncoder().encode(mimeMessage)) })
  });

  if (!gmailResponse.ok) {
    console.error('Gmail send failed with status', gmailResponse.status);
    return Response.json({ error: 'Gmail could not send the reply. Check the account authorization and Gmail API settings.' }, { status: 502 });
  }

  }

  const now = new Date().toISOString();
  const { error: updateError } = await context.supabase
    .from('contact_messages')
    .update({ reply_body: replyBody, status: 'replied', replied_at: now, replied_by: adminId, updated_at: now })
    .eq('id', messageId);
  if (updateError) {
    console.error('Email sent but contact reply history update failed:', updateError.message);
    return Response.json({ sent: true, recorded: false, warning: 'Email was sent, but reply history could not be updated.' });
  }

  return Response.json({ sent: true, recorded: true });
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
    console.error('Contact reply failed:', error instanceof Error ? error.message : 'Unknown error');
    return Response.json({ error: 'Unable to send the reply right now.' }, { status: 500, headers });
  }
});