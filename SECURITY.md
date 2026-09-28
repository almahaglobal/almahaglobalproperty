# Security Requirements

The browser UI is only a client. Production authentication and KYC enforcement must be provided by a trusted backend.

- Use Supabase Auth or another server-side identity provider for password hashing, sessions, MFA, password reset, and email verification. Never accept or hash passwords in browser code.
- Apply `database/002_security_kyc_rls.sql` before exposing users or KYC data. Keep the `kyc-documents` storage bucket private.
- Give Super Admin access only through a server-managed `admin` role claim and an approved database user. Do not allow public registration as admin.
- Keep Owner and Agent accounts in `pending_verification` until `review_kyc_document` approves the required document.
- Serve production traffic over HTTPS, redirect HTTP to HTTPS, and send HSTS (`Strict-Transport-Security`) from the web server.
- Validate input again on the server with an allowlist, parameterized SQL, MIME sniffing, file-size limits, malware scanning, and storage path ownership checks. Treat all client validation as advisory.
- Escape user-provided text when rendering HTML. Prefer `textContent` or DOM APIs over string-built HTML for user data.
- Add audit logging for account changes, document reviews, role changes, failed authentication, and administrative access.
