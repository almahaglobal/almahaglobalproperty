import { store } from './store.js';
import { ApiService } from './api.js';
import { supabase } from './supabase.js';

const KYC_QUEUE_DB = 'al-maha-kyc-queue';
const KYC_QUEUE_STORE = 'documents';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

function safeHttpUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

function getAuthRedirectUrl() {
  const isLocalhost = ['localhost', '127.0.0.1'].includes(window.location.hostname);
  return isLocalhost
    ? `${window.location.origin}${window.location.pathname}`
    : 'https://www.almahaglobalproperty.com/';
}

function addResendConfirmationButton(form, status, email) {
  if (form.querySelector('[data-resend-confirmation]')) return;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'auth-switch';
  button.dataset.resendConfirmation = '';
  button.textContent = 'Resend verification email';
  button.addEventListener('click', async () => {
    button.disabled = true;
    status.textContent = 'Sending...';

    try {
      const { error } = await supabase.auth.resend({
        type: 'signup',
        email,
        options: { emailRedirectTo: getAuthRedirectUrl() }
      });
      if (error) throw error;
      button.textContent = 'Email sent';
      status.textContent = 'Verification email sent. Check your inbox and spam.';
    } catch (error) {
      button.disabled = false;
      console.error('Resend verification failed:', error);
      status.textContent = `Email not sent: ${error.message || 'try again later.'}`;
    }
  });
  form.insertBefore(button, status);
}

function openKycQueue() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(KYC_QUEUE_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(KYC_QUEUE_STORE, { keyPath: 'email' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function savePendingKycDocuments(email, documents) {
  const database = await openKycQueue();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(KYC_QUEUE_STORE, 'readwrite');
    transaction.objectStore(KYC_QUEUE_STORE).put({ email, documents });
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

async function getPendingKycDocuments(email) {
  const database = await openKycQueue();
  const result = await new Promise((resolve, reject) => {
    const request = database.transaction(KYC_QUEUE_STORE).objectStore(KYC_QUEUE_STORE).get(email);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  database.close();
  return result;
}

async function removePendingKycDocuments(email) {
  const database = await openKycQueue();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(KYC_QUEUE_STORE, 'readwrite');
    transaction.objectStore(KYC_QUEUE_STORE).delete(email);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

class AlMahaApp {
  constructor() {
    this.translations = this.getTranslations();
    this.kycUploadInProgress = new Set();
    this.initHeader();
    this.renderHomepage();
    supabase.auth.getSession().then(({ data }) => this.handleAuthSession(data.session));
    supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') {
        this.renderPasswordResetPage();
        return;
      }
      if (session) setTimeout(() => this.handleAuthSession(session), 0);
    });
  }

  async refreshUserProfile(user) {
    if (!user?.id) return null;

    const profile = await supabase
      .from('users')
      .select('role, verification_status, first_name, last_name, email, company_name, phone, mobile_phone')
      .eq('id', user.id)
      .maybeSingle();

    if (profile.error) {
      console.warn('Unable to refresh profile:', profile.error.message);
      return null;
    }

    const profileData = profile.data;
    const nextUser = {
      id: user.id,
      email: profileData?.email || user.email,
      firstName: profileData?.first_name || user.user_metadata?.first_name || user.user_metadata?.full_name?.split(' ')[0] || user.firstName || 'User',
      lastName: profileData?.last_name || user.user_metadata?.last_name || user.lastName || '',
      companyName: profileData?.company_name || user.user_metadata?.company_name || user.companyName || '',
      phone: profileData?.phone || profileData?.mobile_phone || user.user_metadata?.phone || user.phone || '',
      whatsapp: profileData?.whatsapp_number || user.user_metadata?.whatsapp_number || user.whatsapp || '',
      role: profileData?.role || user.user_metadata?.role || user.role || 'buyer',
      verificationStatus: profileData?.verification_status || user.user_metadata?.verification_status || user.verificationStatus || 'pending_verification'
    };

    store.setState({ user: nextUser });
    this.initHeader();
    return nextUser;
  }

  async handleAuthSession(session) {
    if (!session?.user) return;

    const user = session.user;
    const firstName = user.user_metadata?.first_name
      || user.user_metadata?.full_name?.split(' ')[0]
      || 'User';
    const profile = await supabase
      .from('users')
      .select('role, verification_status, first_name, last_name, email, company_name, phone, mobile_phone')
      .eq('id', user.id)
      .maybeSingle();
    const profileRole = profile.data?.role || user.user_metadata?.role || 'buyer';
    const profileVerificationStatus = profile.data?.verification_status || user.user_metadata?.verification_status || 'pending_verification';
    store.setState({
      user: {
        id: user.id,
        email: profile.data?.email || user.email,
        firstName: profile.data?.first_name || firstName,
        lastName: profile.data?.last_name || user.user_metadata?.last_name || '',
        companyName: profile.data?.company_name || user.user_metadata?.company_name || '',
        phone: profile.data?.phone || profile.data?.mobile_phone || user.user_metadata?.phone || '',
        whatsapp: profile.data?.whatsapp_number || user.user_metadata?.whatsapp_number || '',
        role: profileRole,
        verificationStatus: profileVerificationStatus
      }
    });
    this.initHeader();

    if (this.kycUploadInProgress.has(user.id)) return;

    const pending = await getPendingKycDocuments(user.email);
    if (!pending) return;

    this.kycUploadInProgress.add(user.id);
    try {
      const result = await this.uploadKycDocuments(user, pending.documents);
      if (result.error) {
        console.error('KYC document upload failed:', result.error);
        return;
      }

      await removePendingKycDocuments(user.email);
    } finally {
      this.kycUploadInProgress.delete(user.id);
    }
  }

  async uploadKycDocuments(user, documents) {
    const uploadedDocuments = [];

    for (const entry of documents) {
      const existing = await supabase
        .from('kyc_documents')
        .select('id, storage_path')
        .eq('user_id', user.id)
        .eq('document_type', entry.type)
        .eq('status', 'pending')
        .maybeSingle();

      if (existing.error) return existing;
      if (existing.data) {
        uploadedDocuments.push({ storagePath: existing.data.storage_path, recordId: existing.data.id });
        continue;
      }

      const safeFilename = entry.file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const storagePath = `${user.id}/${Date.now()}-${safeFilename}`;
      const upload = await supabase.storage.from('kyc-documents').upload(storagePath, entry.file, {
        contentType: entry.file.type,
        upsert: false
      });

      if (upload.error) return upload;

      const folder = storagePath.substring(0, storagePath.lastIndexOf('/'));
      const filename = storagePath.substring(storagePath.lastIndexOf('/') + 1);
      const storedFile = await supabase.storage.from('kyc-documents').list(folder, { search: filename });
      if (storedFile.error || !storedFile.data?.some(file => file.name === filename)) {
        await supabase.storage.from('kyc-documents').remove([storagePath]);
        return { error: storedFile.error || new Error('Uploaded file could not be verified in Supabase Storage.') };
      }

      const record = await supabase.from('kyc_documents').insert({
        user_id: user.id,
        document_type: entry.type,
        storage_path: storagePath,
        original_filename: entry.file.name,
        mime_type: entry.file.type
      }).select('id, storage_path').single();

      if (record.error || !record.data || record.data.storage_path !== storagePath) {
        await supabase.storage.from('kyc-documents').remove([storagePath]);
        return { error: record.error || new Error('KYC record could not be verified in Supabase.') };
      }

      uploadedDocuments.push({ storagePath, recordId: record.data.id });
    }

    return { error: null, uploadedDocuments };
  }

  renderContactPage() {
    const mainContainer = document.getElementById('main-content');
    if (!mainContainer) return;

    document.body.classList.remove('home-page');
    mainContainer.classList.remove('home-page');
    mainContainer.innerHTML = `
      <section class="auth-page login-page">
        <div class="auth-shell login-shell">
          <div class="auth-intro">
            <span class="auth-eyebrow">AL MAHA GLOBAL PROPERTY</span>
            <h1>Contact us</h1>
            <p>Send our team a message. We will reply to the email address you provide.</p>
          </div>
          <form class="auth-form" id="contact-form">
            <div class="login-fields">
              <label>Your name<input name="name" maxlength="120" autocomplete="name" required></label>
              <label>Email address<input name="email" type="email" maxlength="254" autocomplete="email" required></label>
              <label>Phone number<input name="phone" type="tel" maxlength="50" autocomplete="tel"></label>
              <label>Subject<input name="subject" maxlength="180" required></label>
              <label>Message<textarea name="message" rows="6" minlength="10" maxlength="5000" required></textarea></label>
            </div>
            <div class="auth-actions"><button class="btn-primary" type="submit">Send message</button></div>
            <p class="auth-status" id="contact-status" role="status"></p>
          </form>
        </div>
      </section>
    `;

    document.getElementById('contact-form')?.addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const status = document.getElementById('contact-status');
      const submitButton = form.querySelector('button[type="submit"]');
      submitButton.disabled = true;
      status.textContent = 'Sending your message...';
      try {
        const { error } = await supabase.from('contact_messages').insert({
          name: form.elements.name.value.trim(),
          email: form.elements.email.value.trim(),
          phone: form.elements.phone.value.trim() || null,
          subject: form.elements.subject.value.trim(),
          message: form.elements.message.value.trim()
        });
        if (error) throw error;
        form.reset();
        status.textContent = 'Your message has been sent. Our team will reply by email.';
      } catch (error) {
        status.textContent = error.message || 'Unable to send your message. Please try again.';
      } finally {
        submitButton.disabled = false;
      }
    });
  }

  async renderAdminVerificationPage(initialTab = 'accounts') {
    const mainContainer = document.getElementById('main-content');
    if (!mainContainer) return;

    const { data: authData, error: authError } = await supabase.auth.getUser();
    if (authError || !authData.user) {
      this.renderLoginPage();
      return;
    }

    const adminUser = await this.refreshUserProfile(authData.user);
    const adminRoles = ['admin', 'platform_owner', 'company_owner', 'company_admin', 'staff'];
    if (!adminUser || !adminRoles.includes(adminUser.role) || adminUser.verificationStatus !== 'approved') {
      mainContainer.classList.remove('home-page');
      mainContainer.innerHTML = '<section class="property-search-page"><div class="property-search-heading"><span class="auth-eyebrow">ADMIN</span><h1>Admin access required</h1><p>Sign in with an approved administrator account to review submissions.</p></div></section>';
      return;
    }

    this.adminActiveTab = ['accounts', 'properties', 'projects', 'messages'].includes(initialTab) ? initialTab : 'accounts';
    document.body.classList.remove('home-page');
    mainContainer.classList.remove('home-page');
    mainContainer.innerHTML = '<section class="admin-dashboard"><header class="admin-dashboard-heading"><span class="auth-eyebrow">AL MAHA GLOBAL PROPERTY</span><h1>Admin dashboard</h1><p>Review new accounts, property evidence, listings, and project submissions.</p></header><p class="admin-action-status" id="admin-action-status" role="status"></p><div class="admin-dashboard-loading">Loading review queues...</div></section>';

    const [accountsResult, propertiesResult, projectsResult, contactMessagesResult, propertyInquiriesResult] = await Promise.all([
      supabase
        .from('users')
        .select('id, email, username, full_name, first_name, last_name, country, phone, mobile_phone, company_name, role, verification_status, is_verified, avatar_url, verified_at, verified_by, created_at, updated_at')
        .order('created_at', { ascending: true }),
      supabase
        .from('properties')
        .select('id, reference_number, title, description, price, currency, purpose, property_type, bedrooms, bathrooms, area_sqft, city, country_code, status, owner_id, created_at')
        .order('created_at', { ascending: true }),
      supabase
        .from('projects')
        .select('id, name, slug, description, location, city, starting_price, currency, handover_date, construction_status, construction_progress, payment_plan, hero_image, created_at, developers(name), project_media(storage_path, title, media_type, is_primary)')
        .eq('approval_status', 'pending_review')
        .order('created_at', { ascending: true }),
      supabase
        .from('contact_messages')
        .select('id, name, email, phone, subject, message, status, reply_body, created_at, replied_at')
        .order('created_at', { ascending: false })
        .limit(100),
      supabase
        .from('property_inquiries')
        .select('id, property_id, name, phone, email, message, status, created_at')
        .not('property_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(100)
    ]);
    const accounts = accountsResult.data || [];
    const properties = propertiesResult.data || [];
    const projects = projectsResult.data || [];
    const contactMessages = contactMessagesResult.data || [];
    const propertyInquiries = propertyInquiriesResult.data || [];
    const propertiesById = new Map(properties.map(property => [property.id, property]));
    const accountIds = accounts.map(account => account.id);
    const propertyIds = properties.map(property => property.id);
    const ownerIds = [...new Set(properties.map(property => property.owner_id).filter(Boolean))];
    const [accountDocumentsResult, propertyDocumentsResult, propertyMediaResult, ownersResult] = await Promise.all([
      accountIds.length
        ? supabase.from('kyc_documents').select('id, user_id, document_type, storage_path, original_filename, mime_type, status, rejection_reason').in('user_id', accountIds).order('created_at', { ascending: true })
        : Promise.resolve({ data: [], error: null }),
      propertyIds.length
        ? supabase.from('property_verification_documents').select('id, property_id, document_type, storage_path, original_filename, mime_type, status, rejection_reason').in('property_id', propertyIds).order('created_at', { ascending: true })
        : Promise.resolve({ data: [], error: null }),
      propertyIds.length
        ? supabase.from('property_media').select('property_id, url, media_type, is_primary').in('property_id', propertyIds)
        : Promise.resolve({ data: [], error: null }),
      ownerIds.length
        ? supabase.from('users').select('id, first_name, last_name, email').in('id', ownerIds)
        : Promise.resolve({ data: [], error: null })
    ]);
    const accountDocuments = accountDocumentsResult.data || [];
    const propertyDocuments = propertyDocumentsResult.data || [];
    const propertyMedia = propertyMediaResult.data || [];
    const owners = new Map((ownersResult.data || []).map(owner => [owner.id, owner]));
    const accountDocsByUser = new Map();
    const propertyDocsByProperty = new Map();
    const propertyMediaByProperty = new Map();
    for (const document of accountDocuments) {
      accountDocsByUser.set(document.user_id, [...(accountDocsByUser.get(document.user_id) || []), document]);
    }
    for (const document of propertyDocuments) {
      propertyDocsByProperty.set(document.property_id, [...(propertyDocsByProperty.get(document.property_id) || []), document]);
    }
    for (const media of propertyMedia) {
      propertyMediaByProperty.set(media.property_id, [...(propertyMediaByProperty.get(media.property_id) || []), media]);
    }

    const uploadMarkup = async (bucket, path, filename, mimeType) => {
      const [previewResult, downloadResult] = await Promise.all([
        supabase.storage.from(bucket).createSignedUrl(path, 600),
        supabase.storage.from(bucket).createSignedUrl(path, 600, { download: filename })
      ]);
      const { data, error } = previewResult;
      if (error || !data?.signedUrl) return `<span class="admin-upload-unavailable">${escapeHtml(filename)} · Preview unavailable</span>`;
      const signedUrl = escapeHtml(data.signedUrl);
      const preview = mimeType?.startsWith('image/')
        ? `<a class="admin-upload-preview" href="${signedUrl}" target="_blank" rel="noopener"><img src="${signedUrl}" alt="${escapeHtml(filename)}" loading="lazy"></a>`
        : '';
      const downloadLink = downloadResult.data?.signedUrl
        ? `<a href="${escapeHtml(downloadResult.data.signedUrl)}">Download</a>`
        : '';
      return `<div class="admin-upload-row">${preview}<a href="${signedUrl}" target="_blank" rel="noopener">${escapeHtml(filename)} <span>Open file</span></a>${downloadLink}</div>`;
    };

    const accountCards = await Promise.all(accounts.map(async account => {
      const documents = accountDocsByUser.get(account.id) || [];
      const files = await Promise.all(documents.map(async document => `
        <div class="admin-document-row">
          <div><strong>${escapeHtml(document.document_type.replaceAll('_', ' '))}</strong><span class="admin-status">${escapeHtml(document.status)}</span></div>
          ${await uploadMarkup('kyc-documents', document.storage_path, document.original_filename, document.mime_type)}
          ${document.rejection_reason ? `<p class="admin-rejection-reason">${escapeHtml(document.rejection_reason)}</p>` : ''}
          ${document.status !== 'approved' ? `<div class="admin-review-actions"><button class="btn-primary" type="button" data-review-type="kyc-document" data-review-decision="approved" data-document-id="${escapeHtml(document.id)}">Approve upload</button><button class="btn-outline" type="button" data-review-type="kyc-document" data-review-decision="rejected" data-document-id="${escapeHtml(document.id)}">Reject upload</button></div>` : ''}
        </div>
      `));
      const name = [account.first_name, account.last_name].filter(Boolean).join(' ') || account.email;
      const profilePhoto = safeHttpUrl(account.avatar_url);
      const profileFields = [
        ['Account ID', account.id],
        ['Username', account.username],
        ['Full name', account.full_name],
        ['Country', account.country],
        ['Phone', account.phone],
        ['Mobile', account.mobile_phone],
        ['Company', account.company_name],
        ['Email verified', account.is_verified ? 'Yes' : 'No'],
        ['Verified at', account.verified_at ? new Date(account.verified_at).toLocaleString() : 'Not verified'],
        ['Verified by', account.verified_by],
        ['Created', account.created_at ? new Date(account.created_at).toLocaleString() : 'Unknown'],
        ['Updated', account.updated_at ? new Date(account.updated_at).toLocaleString() : 'Unknown']
      ];
      const reviewActions = ['owner', 'agent', 'buyer', 'tenant'].includes(account.role) && account.verification_status !== 'approved'
        ? `<button class="btn-primary" type="button" data-review-type="account" data-review-decision="approved" data-user-id="${escapeHtml(account.id)}">Approve account</button><button class="btn-outline" type="button" data-review-type="account" data-review-decision="rejected" data-user-id="${escapeHtml(account.id)}">Reject</button>`
        : '';
      const isAdministrator = ['admin', 'platform_owner', 'company_owner', 'company_admin', 'staff'].includes(account.role);
      const accountStatusAction = !isAdministrator && account.id !== adminUser.id
        ? `<button class="btn-outline" type="button" data-admin-account-status="${account.verification_status === 'suspended' ? 'approved' : 'suspended'}" data-user-id="${escapeHtml(account.id)}">${account.verification_status === 'suspended' ? 'Reactivate account' : 'Suspend account'}</button>`
        : '';
      const canDeletePrivilegedAccount = ['platform_owner', 'company_owner', 'admin'].includes(adminUser.role)
        && (account.role !== 'platform_owner' || adminUser.role === 'platform_owner')
        && (account.role !== 'company_owner' || ['platform_owner', 'company_owner'].includes(adminUser.role));
      const deleteAction = account.id !== adminUser.id && (!isAdministrator || canDeletePrivilegedAccount)
        ? `<button class="btn-outline" type="button" data-admin-delete-user="${escapeHtml(account.id)}" data-account-email="${escapeHtml(account.email)}">Delete account</button>`
        : '';
      const searchText = [account.email, account.username, account.full_name, account.first_name, account.last_name, account.company_name, account.country, account.role, account.verification_status].filter(Boolean).join(' ').toLowerCase();
      return `<article class="admin-review-card" data-account-search="${escapeHtml(searchText)}">
        <div class="admin-review-card-heading"><div class="admin-account-heading">${profilePhoto ? `<img class="admin-account-avatar" src="${escapeHtml(profilePhoto)}" alt="${escapeHtml(name)} profile photo" loading="lazy">` : ''}<span class="admin-record-type">${escapeHtml(account.role)}</span><h2>${escapeHtml(name)}</h2><p>${escapeHtml(account.email)}</p></div><span class="admin-status ${account.verification_status === 'rejected' ? 'is-rejected' : ''}">${escapeHtml(account.verification_status.replaceAll('_', ' '))}</span></div>
        <dl class="admin-account-details">${profileFields.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value || 'Not provided')}</dd></div>`).join('')}</dl>
        <div class="admin-upload-list">${files.join('') || '<p class="admin-empty-inline">No KYC uploads were attached to this account.</p>'}</div>
        <div class="admin-review-actions"><button class="btn-outline" type="button" data-admin-reset-email="${escapeHtml(account.email)}">Send password reset</button>${reviewActions}${accountStatusAction}${deleteAction}</div>
      </article>`;
    }));

    const propertyCards = await Promise.all(properties.map(async property => {
      const owner = owners.get(property.owner_id);
      const ownerName = owner ? [owner.first_name, owner.last_name].filter(Boolean).join(' ') || owner.email : 'Unknown account';
      const documents = propertyDocsByProperty.get(property.id) || [];
      const evidence = await Promise.all(documents.map(async document => `
        <div class="admin-document-row">
          <div><strong>${escapeHtml(document.document_type.replaceAll('_', ' '))}</strong><span class="admin-status ${document.status === 'rejected' ? 'is-rejected' : ''}">${escapeHtml(document.status)}</span></div>
          ${await uploadMarkup('property-verification-documents', document.storage_path, document.original_filename, document.mime_type)}
          ${document.rejection_reason ? `<p class="admin-rejection-reason">${escapeHtml(document.rejection_reason)}</p>` : ''}
          ${document.status !== 'approved' ? `<div class="admin-review-actions"><button class="btn-primary" type="button" data-review-type="property" data-review-decision="approved" data-document-id="${escapeHtml(document.id)}">Approve upload</button><button class="btn-outline" type="button" data-review-type="property" data-review-decision="rejected" data-document-id="${escapeHtml(document.id)}">Reject</button></div>` : ''}
        </div>
      `));
      const photos = await Promise.all((propertyMediaByProperty.get(property.id) || []).map(media => uploadMarkup(
        'property-images',
        media.url,
        media.url.split('/').pop() || property.title,
        media.media_type === 'video' ? 'video/mp4' : 'image/jpeg'
      )));
      const price = `${escapeHtml(property.currency || 'AED')} ${Number(property.price || 0).toLocaleString('en-US')}`;
      const location = [property.city, property.country_code].filter(Boolean).join(', ');
      return `<article class="admin-review-card">
        <div class="admin-review-card-heading"><div><span class="admin-record-type">Property listing · ${escapeHtml(property.reference_number)}</span><h2>${escapeHtml(property.title)}</h2><p>Submitted by ${escapeHtml(ownerName)} · ${escapeHtml(property.status.replaceAll('_', ' '))}</p></div><strong class="admin-project-price">${price}</strong></div>
        <p class="admin-record-description">${escapeHtml(property.description || 'No description provided.')}</p>
        <div class="admin-record-facts"><span>${escapeHtml(property.property_type || 'Property')}</span><span>${escapeHtml(location || 'Location not provided')}</span><span>${Number(property.bedrooms || 0)} beds</span><span>${Number(property.bathrooms || 0)} baths</span><span>${Number(property.area_sqft || 0).toLocaleString('en-US')} sqft</span></div>
        <div class="admin-upload-gallery">${photos.join('') || '<span class="admin-empty-inline">No property photos available.</span>'}</div>
        <div class="admin-upload-list">${evidence.join('') || '<p class="admin-empty-inline">No verification uploads are attached to this listing.</p>'}</div>
      </article>`;
    }));

    const projectCards = projects.map(project => {
      const imageUrl = safeHttpUrl(project.hero_image || project.project_media?.find(media => media.is_primary)?.storage_path);
      const mediaMarkup = imageUrl
        ? `<a class="admin-project-image" href="${escapeHtml(imageUrl)}" target="_blank" rel="noopener"><img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(project.name)} project cover" loading="lazy"></a>`
        : '<div class="admin-project-image admin-project-image-empty">No project image</div>';
      return `<article class="admin-review-card admin-project-card" data-project-id="${escapeHtml(project.id)}">
        ${mediaMarkup}<div class="admin-project-details"><div class="admin-review-card-heading"><div><span class="admin-record-type">Off-plan project · ${escapeHtml(project.developers?.name || 'Developer not assigned')}</span><h2>${escapeHtml(project.name)}</h2><p>${escapeHtml([project.location, project.city].filter(Boolean).join(', ') || 'Location not provided')}</p></div><strong class="admin-project-price">${escapeHtml(project.currency || 'AED')} ${Number(project.starting_price || 0).toLocaleString('en-US')}</strong></div>
        <p class="admin-record-description">${escapeHtml(project.description || 'No description provided.')}</p><div class="admin-record-facts"><span>${escapeHtml(project.construction_status || 'Status not provided')}</span><span>${Number(project.construction_progress || 0)}% complete</span><span>Handover ${escapeHtml(project.handover_date || 'TBD')}</span></div>
        <div class="admin-review-actions"><button class="btn-primary" type="button" data-review-type="project" data-review-decision="approved" data-project-id="${escapeHtml(project.id)}">Approve project</button><button class="btn-outline" type="button" data-review-type="project" data-review-decision="rejected" data-project-id="${escapeHtml(project.id)}">Reject</button></div></div>
      </article>`;
    });

    const propertyInquiryCards = propertyInquiries.map(inquiry => {
      const property = propertiesById.get(inquiry.property_id);
      const subject = `Property inquiry: ${property?.title || 'Published listing'}`;
      const replyUrl = `mailto:${encodeURIComponent(inquiry.email)}?subject=${encodeURIComponent(`Re: ${subject}`)}`;
      return `<article class="admin-review-card">
        <div class="admin-review-card-heading"><div><span class="admin-record-type">Property inquiry · ${escapeHtml(inquiry.status || 'new')}</span><h2>${escapeHtml(property?.title || 'Property listing')}</h2><p>${property ? `Reference ${escapeHtml(property.reference_number)} · ` : ''}${escapeHtml(inquiry.name)} · ${escapeHtml(inquiry.email)}${inquiry.phone ? ` · ${escapeHtml(inquiry.phone)}` : ''}</p></div><span class="admin-status">${escapeHtml(new Date(inquiry.created_at).toLocaleString())}</span></div>
        <p class="admin-contact-message">${escapeHtml(inquiry.message || 'The customer requested property information.')}</p>
        <div class="admin-review-actions"><a class="btn-outline" href="${escapeHtml(replyUrl)}">Reply to customer</a></div>
      </article>`;
    });

    const contactMessageCards = contactMessages.map(message => {
      return `<article class="admin-review-card">
        <div class="admin-review-card-heading"><div><span class="admin-record-type">${escapeHtml(message.status)}</span><h2>${escapeHtml(message.subject)}</h2><p>${escapeHtml(message.name)} · ${escapeHtml(message.email)}${message.phone ? ` · ${escapeHtml(message.phone)}` : ''}</p></div><span class="admin-status">${escapeHtml(new Date(message.created_at).toLocaleString())}</span></div>
        <p class="admin-contact-message">${escapeHtml(message.message)}</p>
        ${message.status === 'replied' ? `<div class="admin-contact-reply-history"><strong>Reply sent</strong><p>${escapeHtml(message.reply_body || '')}</p><small>${escapeHtml(new Date(message.replied_at).toLocaleString())}</small></div>` : `<form class="admin-contact-reply-form" data-contact-reply data-message-id="${escapeHtml(message.id)}"><label>Reply from almahglobalproperty@gmail.com<textarea name="replyBody" rows="5" maxlength="10000" required placeholder="Write your reply to ${escapeHtml(message.name)}"></textarea></label><div class="admin-review-actions"><button class="btn-primary" type="submit">Send reply</button>${message.status === 'new' ? `<button class="btn-outline" type="button" data-contact-action="read" data-contact-id="${escapeHtml(message.id)}">Mark read</button>` : ''}</div><p class="admin-contact-reply-status" role="status"></p></form>`}
      </article>`;
    });

    const queueErrors = [accountsResult.error, propertiesResult.error, projectsResult.error, contactMessagesResult.error, propertyInquiriesResult.error, accountDocumentsResult.error, propertyDocumentsResult.error, propertyMediaResult.error, ownersResult.error].filter(Boolean);
    const errorMarkup = queueErrors.length ? `<p class="admin-query-error" role="alert">Some queues could not be loaded: ${escapeHtml(queueErrors.map(error => error.message).join(' · '))}</p>` : '';
    const tabButton = (id, label, count) => `<button class="admin-tab" type="button" role="tab" id="admin-tab-${id}" aria-controls="admin-panel-${id}" aria-selected="${this.adminActiveTab === id}" data-admin-tab="${id}">${label}<span>${count}</span></button>`;
    const panel = (id, content) => `<section class="admin-panel" id="admin-panel-${id}" role="tabpanel" aria-labelledby="admin-tab-${id}" data-admin-panel="${id}" ${this.adminActiveTab !== id ? 'hidden' : ''}>${content || `<p class="admin-empty-state">No items need review.</p>`}</section>`;

    mainContainer.innerHTML = `
      <section class="admin-dashboard">
        <header class="admin-dashboard-heading"><span class="auth-eyebrow">AL MAHA GLOBAL PROPERTY</span><h1>Admin dashboard</h1><p>Review accounts, listings, uploaded evidence, customer messages, and projects.</p></header>
        ${errorMarkup}<p class="admin-action-status" id="admin-action-status" role="status"></p>
        <div class="admin-queue-summary"><span><strong>${accounts.length}</strong> accounts</span><span><strong>${properties.length}</strong> property records</span><span><strong>${projects.length}</strong> projects</span><span><strong>${contactMessages.length + propertyInquiries.length}</strong> messages and requests</span></div>
        <div class="admin-tabs" role="tablist" aria-label="Review queues">${tabButton('accounts', 'Accounts', accounts.length)}${tabButton('properties', 'Properties & uploads', properties.length)}${tabButton('projects', 'Off-plan projects', projects.length)}${tabButton('messages', 'Messages & viewing requests', contactMessages.length + propertyInquiries.length)}</div>
        ${panel('accounts', `<label class="admin-account-filter">Find account<input id="admin-account-filter" type="search" placeholder="Name, email, company, role"></label>${accountCards.join('')}`)}
        ${panel('properties', propertyCards.join(''))}
        ${panel('projects', projectCards.join(''))}
        ${panel('messages', [...propertyInquiryCards, ...contactMessageCards].join(''))}
      </section>
    `;

    mainContainer.querySelectorAll('[data-admin-tab]').forEach(button => {
      button.addEventListener('click', () => {
        this.adminActiveTab = button.dataset.adminTab;
        mainContainer.querySelectorAll('[data-admin-tab]').forEach(tab => tab.setAttribute('aria-selected', String(tab === button)));
        mainContainer.querySelectorAll('[data-admin-panel]').forEach(section => { section.hidden = section.dataset.adminPanel !== this.adminActiveTab; });
      });
    });

    mainContainer.querySelectorAll('[data-contact-reply]').forEach(form => {
      form.addEventListener('submit', async event => {
        event.preventDefault();
        const replyBody = form.elements.replyBody.value.trim();
        const submitButton = form.querySelector('button[type="submit"]');
        const status = form.querySelector('.admin-contact-reply-status');
        if (!replyBody) {
          status.textContent = 'Write a reply before sending.';
          return;
        }

        submitButton.disabled = true;
        status.textContent = 'Sending reply from almahglobalproperty@gmail.com...';
        try {
          const { data, error } = await supabase.functions.invoke('send-contact-reply', {
            body: { messageId: form.dataset.messageId, replyBody }
          });
          if (error) {
            let errorMessage = error.message;
            try {
              const errorBody = await error.context?.clone?.().json();
              errorMessage = errorBody?.error || errorMessage;
            } catch {
              // Keep the Functions client error when the response has no JSON body.
            }
            throw new Error(errorMessage);
          }
          if (!data?.sent) throw new Error('Gmail did not confirm the reply was sent.');
          await this.renderAdminVerificationPage(this.adminActiveTab);
        } catch (error) {
          status.textContent = error.message || 'Unable to send the reply.';
          submitButton.disabled = false;
        }
      });
    });

    mainContainer.querySelectorAll('[data-contact-action]').forEach(button => {
      button.addEventListener('click', async () => {
        const status = button.dataset.contactAction;
        const update = { status, updated_at: new Date().toISOString() };
        if (status === 'replied') {
          update.replied_at = new Date().toISOString();
          update.replied_by = adminUser.id;
        }
        button.disabled = true;
        const { error } = await supabase.from('contact_messages')
          .update(update)
          .eq('id', button.dataset.contactId);
        if (error) {
          button.disabled = false;
          const actionStatus = mainContainer.querySelector('#admin-action-status');
          if (actionStatus) actionStatus.textContent = error.message;
          return;
        }
        await this.renderAdminVerificationPage(this.adminActiveTab);
      });
    });

    mainContainer.querySelector('#admin-account-filter')?.addEventListener('input', event => {
      const searchTerm = event.currentTarget.value.trim().toLowerCase();
      mainContainer.querySelectorAll('[data-account-search]').forEach(card => {
        card.hidden = !card.dataset.accountSearch.includes(searchTerm);
      });
    });

    mainContainer.querySelectorAll('[data-admin-reset-email]').forEach(button => {
      button.addEventListener('click', async () => {
        const email = button.dataset.adminResetEmail;
        const status = mainContainer.querySelector('#admin-action-status');
        button.disabled = true;
        if (status) status.textContent = `Sending password reset to ${email}...`;
        try {
          const { error } = await supabase.auth.resetPasswordForEmail(email, {
            redirectTo: getAuthRedirectUrl()
          });
          if (status) status.textContent = error
            ? `Could not send the reset email: ${error.message}`
            : `Password reset email sent to ${email}.`;
        } catch (error) {
          if (status) status.textContent = error.message || 'Could not send the password reset email.';
        } finally {
          button.disabled = false;
        }
      });
    });

    mainContainer.querySelectorAll('[data-admin-account-status]').forEach(button => {
      button.addEventListener('click', async () => {
        const status = mainContainer.querySelector('#admin-action-status');
        button.disabled = true;
        if (status) status.textContent = 'Updating account status...';
        const { error } = await supabase.from('users')
          .update({ verification_status: button.dataset.adminAccountStatus })
          .eq('id', button.dataset.userId);
        if (error) {
          if (status) status.textContent = `Could not update account status: ${error.message}`;
          button.disabled = false;
          return;
        }
        await this.renderAdminVerificationPage(this.adminActiveTab);
      });
    });

    mainContainer.querySelectorAll('[data-admin-delete-user]').forEach(button => {
      button.addEventListener('click', async () => {
        const email = button.dataset.accountEmail;
        if (!window.confirm(`Permanently delete ${email}? This removes the Auth account, profile, listings, and uploaded files. This cannot be undone.`)) return;

        button.disabled = true;
        const status = mainContainer.querySelector('#admin-action-status');
        if (status) status.textContent = `Deleting ${email}...`;
        try {
          const { error } = await supabase.functions.invoke('admin-delete-user', {
            body: { targetUserId: button.dataset.adminDeleteUser }
          });
          if (error) {
            const details = await error.context?.json?.().catch(() => null);
            throw new Error(details?.error || error.message);
          }
          await this.renderAdminVerificationPage(this.adminActiveTab);
        } catch (error) {
          button.disabled = false;
          if (status) status.textContent = error.message || 'Unable to delete the account.';
        }
      });
    });

    mainContainer.querySelectorAll('[data-review-decision]').forEach(button => {
      button.addEventListener('click', async () => {
        const decision = button.dataset.reviewDecision;
        const reason = decision === 'rejected' ? window.prompt('Reason for rejection:') : null;
        if (decision === 'rejected' && !reason) return;

        button.disabled = true;
        const result = button.dataset.reviewType === 'project'
          ? await supabase.from('projects').update({
            approval_status: decision,
            is_verified: decision === 'approved',
            published_at: decision === 'approved' ? new Date().toISOString() : null,
            updated_at: new Date().toISOString()
          }).eq('id', button.dataset.projectId).eq('approval_status', 'pending_review').select('id').maybeSingle()
          : button.dataset.reviewType === 'property'
            ? await supabase.rpc('review_property_verification_document', {
              target_document_id: button.dataset.documentId,
              decision,
              reason
            })
            : button.dataset.reviewType === 'kyc-document'
              ? await supabase.rpc('review_kyc_document', {
                document_id: button.dataset.documentId,
                decision,
                reason
              })
            : await supabase.rpc('review_kyc_account', {
              target_user_id: button.dataset.userId,
              decision,
              reason
            });

        if (result.error || (button.dataset.reviewType === 'project' && !result.data)) {
          const status = document.getElementById('admin-action-status');
          if (status) status.textContent = result.error?.message || 'This project was already reviewed or is no longer available.';
          button.disabled = false;
          return;
        }

        await this.renderAdminVerificationPage(this.adminActiveTab);
      });
    });
  }

  async renderAdministratorsPage() {
    const mainContainer = document.getElementById('main-content');
    const currentUser = store.getState().user;
    if (!mainContainer || !currentUser) return;

    const canManage = ['platform_owner', 'company_owner', 'admin'].includes(currentUser.role)
      && currentUser.verificationStatus === 'approved';
    if (!canManage) {
      this.renderUserProfilePage();
      return;
    }

    document.body.classList.remove('home-page');
    mainContainer.classList.remove('home-page');
    mainContainer.innerHTML = `<section class="property-search-page"><div class="property-search-heading"><span class="auth-eyebrow">ADMIN</span><h1>Administrators</h1><p>Loading administrator accounts...</p></div></section>`;

    const { data: administrators, error } = await supabase
      .from('users')
      .select('id, email, first_name, last_name, role, verification_status, created_at')
      .in('role', ['admin', 'platform_owner', 'company_owner', 'company_admin', 'staff'])
      .order('created_at', { ascending: true });

    if (error) {
      mainContainer.innerHTML = `<section class="property-search-page"><div class="property-search-heading"><h1>Administrators</h1><p class="agents-status agents-status-error">${error.message}</p></div></section>`;
      return;
    }

    const statusLabels = {
      pending_verification: 'Pending approval',
      approved: 'Active',
      rejected: 'Rejected',
      suspended: 'Suspended'
    };

    mainContainer.innerHTML = `
      <section class="property-search-page verification-page">
        <div class="property-search-heading"><span class="auth-eyebrow">ADMIN</span><h1>Administrators</h1><p>Approve, suspend, or reassign administrator accounts for this company.</p></div>
        <div class="verification-list">${administrators.map(admin => `
          <article class="verification-card" data-admin-id="${admin.id}">
            <div class="verification-card-heading">
              <div><strong>${[admin.first_name, admin.last_name].filter(Boolean).join(' ') || admin.email}</strong><span>${admin.email} · ${admin.role}</span></div>
              <span class="verification-document-status">${statusLabels[admin.verification_status] || admin.verification_status}</span>
            </div>
            ${admin.id === currentUser.id ? '<p>This is your own account.</p>' : `
              <div class="verification-actions">
                ${['company_admin', 'staff'].includes(admin.role) ? `<label>Role
                  <select data-admin-role-select data-original-role="${admin.role}">
                    <option value="company_admin" ${admin.role === 'company_admin' ? 'selected' : ''}>Company admin</option>
                    <option value="staff" ${admin.role === 'staff' ? 'selected' : ''}>Staff</option>
                  </select>
                </label>` : ''}
                <button class="btn-outline" type="button" data-admin-action="approved">Approve / Activate</button>
                <button class="btn-outline" type="button" data-admin-action="suspended">Suspend</button>
                <button class="btn-outline" type="button" data-admin-action="rejected">Reject</button>
              </div>`}
          </article>`).join('') || '<p>No administrator accounts yet.</p>'}
        </div>
      </section>
    `;

    mainContainer.querySelectorAll('[data-admin-action]').forEach(button => {
      button.addEventListener('click', async () => {
        const card = button.closest('[data-admin-id]');
        const targetUserId = card.dataset.adminId;
        const roleSelect = card.querySelector('[data-admin-role-select]');
        const roleChanged = roleSelect && roleSelect.value !== roleSelect.dataset.originalRole;
        button.disabled = true;
        const { error: rpcError } = await supabase.rpc('set_administrator_status', {
          target_user_id: targetUserId,
          new_role: roleChanged ? roleSelect.value : null,
          new_status: button.dataset.adminAction
        });
        if (rpcError) {
          button.disabled = false;
          window.alert(rpcError.message);
          return;
        }
        await this.renderAdministratorsPage();
      });
    });
  }

  async renderUserProfilePage() {
    const mainContainer = document.getElementById('main-content');
    const cachedUser = store.getState().user;
    if (!mainContainer || !cachedUser) {
      this.renderLoginPage();
      return;
    }
    const user = await this.refreshUserProfile(cachedUser) || cachedUser;

     const isSeller = ['owner', 'agent'].includes(user.role);
    const verificationStatus = user.verificationStatus || 'pending_verification';
    const statusLabel = verificationStatus.replaceAll('_', ' ');
     const primaryAction = isSeller && verificationStatus === 'approved'
      ? 'Add property'
       : isSeller
        ? 'Complete verification'
        : 'Register as owner';

    let myProperties = [];
    let myPropertiesError = null;
    if (isSeller) {
      try {
        myProperties = await ApiService.getMyProperties(user.id);
        console.log('My properties result:', myProperties);
      } catch (error) {
        console.error('Unable to load properties for profile:', error);
        myPropertiesError = error.message || 'Unknown error';
      }
    }
    const propertyStatusLabels = {
      approved: 'Approved',
      available: 'Approved',
      verified: 'Approved',
      pending_verification: 'Pending review',
      under_review: 'Pending review',
      documents_required: 'Documents required',
      rejected: 'Rejected'
    };

    document.body.classList.remove('home-page');
    mainContainer.classList.remove('home-page');
    mainContainer.innerHTML = `
      <section class="profile-page">
        <div class="profile-dashboard">
          <aside class="profile-sidebar">
            <span class="auth-eyebrow">AL MAHA GLOBAL PROPERTY</span>
            <h2>Owner portal</h2>
            <nav class="profile-menu" aria-label="Owner dashboard">
              <button class="active" type="button">Dashboard</button>
              <button type="button" data-profile-action="properties">My properties</button>
              <button type="button" data-profile-action="add-property">Add property</button>
              <button type="button" data-profile-action="verification">Verification status</button>
              <button type="button">Documents</button>
              <button type="button">Messages</button>
              <button type="button">Enquiries</button>
              <button type="button">Favorites</button>
              <button type="button">Notifications</button>
              <button type="button" data-profile-action="profile">Profile</button>
              <button type="button">Security</button>
            </nav>
          </aside>
          <div class="profile-content">
            <header class="profile-header">
              <div><span class="auth-eyebrow">MY ACCOUNT</span><h1>Welcome, ${user.firstName || 'User'}</h1><p>Manage your profile, verification, and property listings.</p></div>
              <button class="btn-primary" id="btn-profile-primary" type="button">${primaryAction}</button>
            </header>
            <div class="profile-summary-grid">
              <article><span>Account type</span><strong>${user.role}</strong></article>
              <article><span>Verification</span><strong class="profile-status profile-status-${verificationStatus}">${statusLabel}</strong></article>
              <article><span>My properties</span><strong>${myProperties.length}</strong></article>
              <article><span>New enquiries</span><strong>0</strong></article>
            </div>
            <section class="profile-panel">
              <div class="profile-panel-header"><div><h2>Verification status</h2><p>Your identity and ownership documents are kept private and reviewed before a property is published.</p></div><strong class="status-badge ${verificationStatus === 'approved' ? 'approved' : 'pending'}">${statusLabel}</strong></div>
              <div class="profile-checklist">
                  <div><span class="profile-check ${isSeller ? 'complete' : ''}">1</span><div><strong>Account registration</strong><p>Owner or agency profile and contact details.</p></div></div>
                <div><span class="profile-check ${verificationStatus === 'approved' ? 'complete' : ''}">2</span><div><strong>Identity & ownership verification</strong><p>Private documents reviewed by Al Maha Global Property.</p></div></div>
                <div><span class="profile-check">3</span><div><strong>Property submission</strong><p>Submit the property details, location, media, and price for approval.</p></div></div>
              </div>
            </section>
            ${isSeller ? `<section class="profile-panel" id="profile-properties-panel">
              <div class="profile-panel-header"><div><h2>My properties</h2><p>Properties you have submitted, including their current approval status.</p></div></div>
              ${myPropertiesError
                ? `<p class="agents-status agents-status-error">Unable to load your properties: ${myPropertiesError}</p>`
                : myProperties.length ? `<div class="profile-properties-list">${myProperties.map(property => `
                <div class="profile-property-row">
                  <div><strong>${property.title}</strong><span>${property.referenceNumber} · ${property.propertyType} · ${property.purpose === 'rent' ? 'For rent' : 'For sale'}</span></div>
                  <strong>${this.formatPrice(property.price, property.currency)}</strong>
                  <span class="status-badge ${property.status === 'rejected' ? 'pending' : property.verified || ['approved', 'available', 'verified'].includes(property.status) ? 'approved' : 'pending'}">${propertyStatusLabels[property.status] || 'Pending review'}</span>
                  <button class="btn-outline" data-edit-property="${property.id}" type="button">Edit</button>
                </div>`).join('')}</div>` : '<p>You have not submitted any properties yet.</p>'}
            </section>` : ''}
            <section class="profile-panel" id="profile-account-panel">
              <div class="profile-panel-header"><div><h2>Account information</h2><p>Signed-in account details.</p></div></div>
              <div class="profile-details">
                <div><span>Full name</span><strong>${[user.firstName, user.lastName].filter(Boolean).join(' ') || 'Not provided'}</strong></div>
                ${isSeller ? `<div><span>Company name</span><strong>${user.companyName || 'Not provided'}</strong></div>` : ''}
                <div><span>Email</span><strong>${user.email}</strong></div>
                <div><span>Contact number</span><strong>${user.phone || 'Not provided'}</strong></div>
                <div><span>Account type</span><strong>${user.role}</strong></div>
              </div>
              <div class="profile-whatsapp-row" id="profile-whatsapp-row">
                <div><span>WhatsApp number</span><strong>${user.whatsapp || 'Not provided'}</strong></div>
                ${user.whatsapp
                  ? `<a class="btn-outline btn-whatsapp" href="https://wa.me/${user.whatsapp.replace(/[^0-9]/g, '')}" target="_blank" rel="noopener">Chat on WhatsApp</a>`
                  : '<button class="btn-outline btn-whatsapp" id="btn-add-whatsapp" type="button">Add WhatsApp number</button>'}
              </div>
              <form class="profile-whatsapp-form" id="profile-whatsapp-form" hidden>
                <label>WhatsApp number<input name="whatsappNumber" type="tel" placeholder="e.g. +971501234567" value="${user.whatsapp || ''}" required></label>
                <button class="btn-primary" type="submit">Save</button>
                <p class="auth-status" id="profile-whatsapp-status" role="status"></p>
              </form>
            </section>
            ${['admin', 'platform_owner', 'company_owner', 'company_admin', 'staff'].includes(user.role) && verificationStatus === 'approved' ? '<button class="btn-outline" id="btn-profile-review" type="button">Review verification accounts</button>' : ''}
            ${['admin', 'platform_owner', 'company_owner'].includes(user.role) && verificationStatus === 'approved' ? '<button class="btn-outline" id="btn-profile-administrators" type="button">Manage administrators</button>' : ''}
          </div>
        </div>
      </section>
    `;

    const startOwnerFlow = () => {
      if (!isSeller) this.renderOwnerRegistrationPage();
      else if (verificationStatus !== 'approved') this.renderKycUploadPage();
      else this.renderSellerListingChoice();
    };
    document.getElementById('btn-profile-primary')?.addEventListener('click', startOwnerFlow);
    mainContainer.querySelectorAll('[data-profile-action="add-property"], [data-profile-action="verification"]').forEach(button => {
      button.addEventListener('click', startOwnerFlow);
    });
    document.querySelector('[data-profile-action="properties"]')?.addEventListener('click', () => {
      if (!isSeller) { startOwnerFlow(); return; }
      document.getElementById('profile-properties-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    document.querySelector('[data-profile-action="profile"]')?.addEventListener('click', () => {
      document.getElementById('profile-account-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    mainContainer.querySelectorAll('[data-edit-property]').forEach(button => {
      button.addEventListener('click', () => this.renderPropertyEditPage(button.dataset.editProperty));
    });
    document.getElementById('btn-profile-review')?.addEventListener('click', () => this.renderAdminVerificationPage());
    document.getElementById('btn-profile-administrators')?.addEventListener('click', () => this.renderAdministratorsPage());
    const whatsappForm = document.getElementById('profile-whatsapp-form');
    document.getElementById('btn-add-whatsapp')?.addEventListener('click', () => {
      document.getElementById('profile-whatsapp-row').hidden = true;
      whatsappForm.hidden = false;
      whatsappForm.querySelector('input').focus();
    });
    whatsappForm?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const status = document.getElementById('profile-whatsapp-status');
      const submitButton = event.currentTarget.querySelector('button[type="submit"]');
      const whatsappNumber = new FormData(event.currentTarget).get('whatsappNumber').trim();
      submitButton.disabled = true;
      status.textContent = 'Saving...';
      try {
        await ApiService.updateWhatsappNumber(user.id, whatsappNumber);
        store.setState({ user: { ...user, whatsapp: whatsappNumber } });
        this.renderUserProfilePage();
      } catch (error) {
        status.textContent = error.message || 'Unable to save WhatsApp number. Please try again.';
        submitButton.disabled = false;
      }
    });
  }

  async renderPropertyEditPage(propertyId) {
    const mainContainer = document.getElementById('main-content');
    const user = store.getState().user;
    if (!mainContainer || !user) return;

    document.body.classList.remove('home-page');
    mainContainer.classList.remove('home-page');
    mainContainer.innerHTML = `<section class="property-search-page property-edit-page"><div class="property-search-heading"><span class="auth-eyebrow">EDIT LISTING</span><h1>Edit Property</h1><p>Loading property details...</p></div></section>`;

    let property;
    try {
      property = await ApiService.getPropertyForEdit(propertyId, user.id);
    } catch (error) {
      mainContainer.innerHTML = `<section class="property-search-page"><p class="agents-status agents-status-error">Unable to load this property: ${error.message}</p></section>`;
      return;
    }

    if (!property) {
      mainContainer.innerHTML = `<section class="property-search-page"><p class="agents-status agents-status-error">Property not found or you do not have access to edit it.</p></section>`;
      return;
    }

    mainContainer.innerHTML = `
      <section class="property-search-page property-edit-page">
        <div class="property-search-heading"><span class="auth-eyebrow">EDIT LISTING</span><h1>Edit Property</h1><p>Reference ${property.reference_number}. Changes are saved to your listing.</p></div>
        <form class="auth-form" id="property-edit-form">
          <div class="auth-fields">
            <label class="sell-title-field">Title *<input name="title" value="${property.title || ''}" required></label>
            <label>Price *<input name="price" type="number" min="0" value="${property.price || 0}" required></label>
            <label>Purpose *<select name="purpose"><option value="sale" ${property.purpose === 'sale' ? 'selected' : ''}>For sale</option><option value="rent" ${property.purpose === 'rent' ? 'selected' : ''}>For rent</option></select></label>
            <label>Property type<input name="propertyType" value="${property.property_type || ''}"></label>
            <label>Bedrooms<input name="bedrooms" type="number" min="0" value="${property.bedrooms || 0}"></label>
            <label>Bathrooms<input name="bathrooms" type="number" min="0" value="${property.bathrooms || 0}"></label>
            <label>Area (sqft)<input name="areaSqft" type="number" min="0" value="${property.area_sqft || 0}"></label>
            <label>City<input name="city" value="${property.city || ''}"></label>
            <label class="sell-span-full">Description<textarea name="description" rows="5">${property.description || ''}</textarea></label>
          </div>
          <div class="auth-actions">
            <button class="btn-outline" type="button" id="btn-edit-cancel">Cancel</button>
            <button class="btn-primary" type="submit">Save changes</button>
          </div>
          <p class="auth-status" id="property-edit-status" role="status"></p>
        </form>
      </section>
    `;

    document.getElementById('btn-edit-cancel')?.addEventListener('click', () => this.renderUserProfilePage());
    document.getElementById('property-edit-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const status = document.getElementById('property-edit-status');
      const submitButton = event.currentTarget.querySelector('button[type="submit"]');
      const formData = new FormData(event.currentTarget);
      submitButton.disabled = true;
      status.textContent = 'Saving changes...';
      try {
        await ApiService.updateProperty(propertyId, user.id, {
          title: formData.get('title').trim(),
          price: Number(formData.get('price')),
          purpose: formData.get('purpose'),
          property_type: formData.get('propertyType') || null,
          bedrooms: Number(formData.get('bedrooms')) || 0,
          bathrooms: Number(formData.get('bathrooms')) || 0,
          area_sqft: Number(formData.get('areaSqft')) || 0,
          city: formData.get('city') || null,
          description: formData.get('description').trim()
        });
        this.renderUserProfilePage();
      } catch (error) {
        status.textContent = error.message || 'Unable to save changes. Please try again.';
        submitButton.disabled = false;
      }
    });
  }

  renderKycUploadPage() {
    const mainContainer = document.getElementById('main-content');
    const state = store.getState();
    if (!mainContainer || !state.user) return;

    const isOwner = state.user.role === 'owner';
    const documents = isOwner
      ? [['identity', 'Owner identity document', 'identity_document']]
      : [
          ['identity', 'Agent identity document', 'identity_document'],
          ['license', 'Valid company license', 'agency_license']
        ];

    document.body.classList.remove('home-page');
    mainContainer.classList.remove('home-page');
    mainContainer.innerHTML = `
      <section class="auth-page">
        <div class="auth-shell">
          <div class="auth-intro">
            <span class="auth-eyebrow">AL MAHA GLOBAL PROPERTY</span>
            <h1>Complete verification</h1>
            <p>Upload your account documents so an administrator can review your ${isOwner ? 'owner' : 'agency'} account. Property deeds and selling authorization are submitted separately for each property.</p>
          </div>
          <form class="auth-form" id="kyc-upload-form">
            <div class="document-upload-fields">
              ${documents.map(([name, label, type]) => `
                <label>${label}<span class="upload-note">PDF, JPG or PNG · maximum 10 MB</span><input name="${name}" data-document-type="${type}" type="file" accept=".pdf,.jpg,.jpeg,.png" required></label>
              `).join('')}
            </div>
            <div class="auth-actions">
              <button class="btn-outline" type="button" id="btn-kyc-home">Back to home</button>
              <button class="btn-primary" type="submit">Upload documents</button>
            </div>
            <p class="auth-status" id="kyc-upload-status" role="status"></p>
          </form>
        </div>
      </section>
    `;

    document.getElementById('btn-kyc-home')?.addEventListener('click', () => this.renderHomepage());
    document.getElementById('kyc-upload-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const status = document.getElementById('kyc-upload-status');
      const submitButton = form.querySelector('button[type="submit"]');
      const entries = [...form.querySelectorAll('input[type="file"]')].map(input => ({
        file: input.files[0],
        type: input.dataset.documentType
      }));

      if (entries.some(entry => !entry.file || !['application/pdf', 'image/jpeg', 'image/png'].includes(entry.file.type) || entry.file.size > 10 * 1024 * 1024)) {
        status.textContent = 'Please select valid PDF, JPG, or PNG files smaller than 10 MB.';
        return;
      }

      submitButton.disabled = true;
      status.textContent = 'Uploading documents...';
      const result = await this.uploadKycDocuments({ id: state.user.id }, entries);
      submitButton.disabled = false;

      if (result.error) {
        status.textContent = result.error.message;
        return;
      }

      status.textContent = `${result.uploadedDocuments.length} document(s) uploaded and confirmed in Supabase. Your account is pending administrator review.`;
      setTimeout(() => this.renderHomepage(), 1200);
    });
  }

  getTranslations(language = store.getState().language || 'en') {
    const translations = {
      en: {
        buy: 'Buy',
        home: 'Home',
        rent: 'Rent',
        offplan: 'Off-Plan',
        commercial: 'Commercial',
        valuation: 'Valuation',
        favorites: 'Favorites',
        signIn: 'Sign In',
        login: 'Log In',
        sell: 'Sell',
        postProperty: 'Post Property',
        heroTitle: 'Find Your Next Property',
        heroSubtitle: 'Discover homes, investments and commercial properties across the UAE and Global',
        location: 'Location',
        country: 'Country',
        city: 'City',
        propertyType: 'Property Type',
        selectPropertyType: 'Select property type',
        maxBudget: 'Max Budget',
        minPrice: 'Min Price',
        maxPrice: 'Max Price',
        language: 'Language',
        currency: 'Currency',
        search: 'Search',
        featuredProperties: 'Featured Properties',
        allResidential: 'All Residential',
        apartment: 'Apartment',
        villa: 'Villa',
        townhouse: 'Townhouse',
        penthouse: 'Penthouse',
        commercialType: 'Commercial',
        land: 'Land',
        advancedSearch: 'Advanced Search',
        bedrooms: 'Bedrooms',
        bathrooms: 'Bathrooms',
        balcony: 'Balcony',
        minArea: 'Min Area (sqft)',
        maxArea: 'Max Area (sqft)',
        furnishing: 'Furnishing',
        anyFurnishing: 'Any furnishing',
        furnished: 'Furnished',
        unfurnished: 'Unfurnished',
        completion: 'Completion',
        anyCompletion: 'Any completion',
        ready: 'Ready',
        offPlanStatus: 'Off-plan',
        parking: 'Parking spaces',
        amenities: 'Amenities',
        amenitiesPlaceholder: 'e.g. pool, gym, sea view',
        anyPrice: 'Any Price',
        verified: 'Verified',
        beds: 'Beds',
        baths: 'Baths',
        sqft: 'sqft',
        contact: 'Contact',
        bookViewing: 'Book Viewing',
        locationPlaceholder: 'e.g. Dubai Marina, Downtown'
      },
      ar: {
        buy: 'شراء',
        home: 'الرئيسية',
        rent: 'إيجار',
        offplan: 'العقارات الجديدة',
        commercial: 'تجاري',
        valuation: 'تقييم',
        favorites: 'المفضلة',
        signIn: 'تسجيل الدخول',
        login: 'دخول',
        sell: 'بيع',
        postProperty: 'إضافة عقار',
        heroTitle: 'ابحث عن عقارك التالي',
        heroSubtitle: 'اكتشف المنازل والاستثمارات والعقارات التجارية في جميع أنحاء الإمارات.',
        location: 'الموقع',
        country: 'الدولة',
        city: 'المدينة',
        propertyType: 'نوع العقار',
        selectPropertyType: 'اختر نوع العقار',
        maxBudget: 'الميزانية القصوى',
        minPrice: 'الحد الأدنى',
        maxPrice: 'الحد الأقصى',
        language: 'اللغة',
        currency: 'العملة',
        search: 'بحث',
        featuredProperties: 'العقارات المميزة',
        allResidential: 'جميع العقارات السكنية',
        apartment: 'شقة',
        villa: 'فيلا',
        townhouse: 'تاون هاوس',
        penthouse: 'بنتهاوس',
        commercialType: 'تجاري',
        land: 'أرض',
        advancedSearch: 'بحث متقدم', bedrooms: 'غرف النوم', bathrooms: 'الحمامات', balcony: 'شرفة', minArea: 'أقل مساحة (قدم²)', maxArea: 'أقصى مساحة (قدم²)', furnishing: 'التأثيث', anyFurnishing: 'أي تأثيث', furnished: 'مفروش', unfurnished: 'غير مفروش', completion: 'حالة الإنجاز', anyCompletion: 'أي حالة', ready: 'جاهز', offPlanStatus: 'على المخطط', parking: 'مواقف السيارات', amenities: 'المرافق', amenitiesPlaceholder: 'مثل: مسبح، نادي، إطلالة بحرية',
        anyPrice: 'أي سعر',
        verified: 'موثوق',
        beds: 'غرف',
        baths: 'حمامات',
        sqft: 'قدم²',
        contact: 'تواصل',
        bookViewing: 'حجز معاينة',
        locationPlaceholder: 'مثل: دبي مارينا، وسط المدينة'
      },
      fr: {
        buy: 'Acheter',
        home: 'Accueil',
        rent: 'Louer',
        offplan: 'À venir',
        commercial: 'Commercial',
        valuation: 'Estimation',
        favorites: 'Favoris',
        signIn: 'Connexion',
        login: 'Se connecter',
        sell: 'Vendre',
        postProperty: 'Publier un bien',
        heroTitle: 'Trouvez votre prochain bien',
        heroSubtitle: 'Découvrez des maisons, des investissements et des biens commerciaux à travers les Émirats.',
        location: 'Localisation',
        country: 'Pays',
        city: 'Ville',
        propertyType: 'Type de bien',
        selectPropertyType: 'Sélectionner le type de bien',
        maxBudget: 'Budget max',
        minPrice: 'Prix min',
        maxPrice: 'Prix max',
        language: 'Langue',
        currency: 'Devise',
        search: 'Rechercher',
        featuredProperties: 'Propriétés en vedette',
        allResidential: 'Tous les biens résidentiels',
        apartment: 'Appartement',
        villa: 'Villa',
        townhouse: 'Maison de ville',
        penthouse: 'Penthouse',
        commercialType: 'Commercial',
        land: 'Terrain',
        advancedSearch: 'Recherche avancée', bedrooms: 'Chambres', bathrooms: 'Salles de bain', balcony: 'Balcon', minArea: 'Surface min (pi²)', maxArea: 'Surface max (pi²)', furnishing: 'Mobilier', anyFurnishing: 'Tout mobilier', furnished: 'Meublé', unfurnished: 'Non meublé', completion: 'Achèvement', anyCompletion: 'Tout achèvement', ready: 'Prêt', offPlanStatus: 'À venir', parking: 'Places de parking', amenities: 'Équipements', amenitiesPlaceholder: 'ex. piscine, salle de sport, vue mer',
        anyPrice: 'N’importe quel prix',
        verified: 'Vérifié',
        beds: 'Chambres',
        baths: 'Salles de bain',
        sqft: 'pi²',
        contact: 'Contacter',
        bookViewing: 'Réserver une visite',
        locationPlaceholder: 'ex. Dubai Marina, Downtown'
      },
      es: {
        buy: 'Comprar',
        home: 'Inicio',
        rent: 'Alquilar',
        offplan: 'Obra nueva',
        commercial: 'Comercial',
        valuation: 'Valoración',
        favorites: 'Favoritos',
        signIn: 'Iniciar sesión',
        login: 'Iniciar sesión',
        sell: 'Vender',
        postProperty: 'Publicar propiedad',
        heroTitle: 'Encuentra tu próxima propiedad',
        heroSubtitle: 'Descubre viviendas, inversiones y propiedades comerciales en todo los Emiratos Árabes.',
        location: 'Ubicación',
        country: 'País',
        city: 'Ciudad',
        propertyType: 'Tipo de propiedad',
        selectPropertyType: 'Seleccionar tipo de propiedad',
        maxBudget: 'Presupuesto máximo',
        minPrice: 'Precio mínimo',
        maxPrice: 'Precio máximo',
        language: 'Idioma',
        currency: 'Moneda',
        search: 'Buscar',
        featuredProperties: 'Propiedades destacadas',
        allResidential: 'Todo residencial',
        apartment: 'Apartamento',
        villa: 'Villa',
        townhouse: 'Adosado',
        penthouse: 'Ático',
        commercialType: 'Comercial',
        land: 'Terreno',
        advancedSearch: 'Búsqueda avanzada', bedrooms: 'Dormitorios', bathrooms: 'Baños', balcony: 'Balcón', minArea: 'Área mínima (pies²)', maxArea: 'Área máxima (pies²)', furnishing: 'Amueblado', anyFurnishing: 'Cualquier estado', furnished: 'Amueblado', unfurnished: 'Sin amueblar', completion: 'Finalización', anyCompletion: 'Cualquier finalización', ready: 'Listo', offPlanStatus: 'Obra nueva', parking: 'Plazas de aparcamiento', amenities: 'Comodidades', amenitiesPlaceholder: 'ej. piscina, gimnasio, vista al mar',
        anyPrice: 'Cualquier precio',
        verified: 'Verificado',
        beds: 'Dormitorios',
        baths: 'Baños',
        sqft: 'pies²',
        contact: 'Contactar',
        bookViewing: 'Reservar visita',
        locationPlaceholder: 'ej. Dubai Marina, Downtown'
      },
      de: {
        buy: 'Kaufen',
        home: 'Startseite',
        rent: 'Mieten',
        offplan: 'Vorverkauf',
        commercial: 'Gewerbe',
        valuation: 'Bewertung',
        favorites: 'Favoriten',
        signIn: 'Anmelden',
        login: 'Anmelden',
        sell: 'Verkaufen',
        postProperty: 'Immobilie posten',
        heroTitle: 'Finden Sie Ihre nächste Immobilie',
        heroSubtitle: 'Entdecken Sie Häuser, Investitionen und Gewerbeimmobilien in den Vereinigten Arabischen Emiraten.',
        location: 'Standort',
        country: 'Land',
        city: 'Stadt',
        propertyType: 'Immobilienart',
        selectPropertyType: 'Immobilienart auswählen',
        maxBudget: 'Max. Budget',
        minPrice: 'Mindestpreis',
        maxPrice: 'Höchstpreis',
        language: 'Sprache',
        currency: 'Währung',
        search: 'Suchen',
        featuredProperties: 'Empfohlene Immobilien',
        allResidential: 'Alle Wohnimmobilien',
        apartment: 'Wohnung',
        villa: 'Villa',
        townhouse: 'Reihenhaus',
        penthouse: 'Penthouse',
        commercialType: 'Gewerbe',
        land: 'Grundstück',
        advancedSearch: 'Erweiterte Suche', bedrooms: 'Schlafzimmer', bathrooms: 'Badezimmer', balcony: 'Balkon', minArea: 'Mindestfläche (ft²)', maxArea: 'Maximalfläche (ft²)', furnishing: 'Möblierung', anyFurnishing: 'Jede Möblierung', furnished: 'Möbliert', unfurnished: 'Unmöbliert', completion: 'Fertigstellung', anyCompletion: 'Jede Fertigstellung', ready: 'Bezugsfertig', offPlanStatus: 'Vorverkauf', parking: 'Parkplätze', amenities: 'Ausstattung', amenitiesPlaceholder: 'z. B. Pool, Fitnessstudio, Meerblick',
        anyPrice: 'Jeder Preis',
        verified: 'Verifiziert',
        beds: 'Schlafzimmer',
        baths: 'Badezimmer',
        sqft: 'ft²',
        contact: 'Kontakt',
        bookViewing: 'Besichtigung buchen',
        locationPlaceholder: 'z. B. Dubai Marina, Downtown'
      },
      zh: {
        buy: '购买',
        home: '首页',
        rent: '租赁',
        offplan: '期房',
        commercial: '商业',
        valuation: '估值',
        favorites: '收藏',
        signIn: '登录',
        login: '登录',
        sell: '出售',
        postProperty: '发布房源',
        heroTitle: '寻找您的下一处房产',
        heroSubtitle: '发现阿联酋地区的住宅、投资和商业地产。',
        location: '位置',
        country: '国家',
        city: '城市',
        propertyType: '房产类型',
        selectPropertyType: '选择房产类型',
        maxBudget: '最高预算',
        minPrice: '最低价格',
        maxPrice: '最高价格',
        language: '语言',
        currency: '货币',
        search: '搜索',
        featuredProperties: '精选房产',
        allResidential: '所有住宅',
        apartment: '公寓',
        villa: '别墅',
        townhouse: '联排别墅',
        penthouse: '顶楼公寓',
        commercialType: '商业地产',
        land: '土地',
        advancedSearch: '高级搜索', bedrooms: '卧室', bathrooms: '浴室', balcony: '阳台', minArea: '最小面积（平方英尺）', maxArea: '最大面积（平方英尺）', furnishing: '装修', anyFurnishing: '不限装修', furnished: '精装', unfurnished: '未装修', completion: '完工状态', anyCompletion: '不限状态', ready: '现房', offPlanStatus: '期房', parking: '停车位', amenities: '设施', amenitiesPlaceholder: '例如：泳池、健身房、海景',
        anyPrice: '任意价格',
        verified: '已核验',
        beds: '卧室',
        baths: '浴室',
        sqft: '平方英尺',
        contact: '联系',
        bookViewing: '预约看房',
        locationPlaceholder: '例如：迪拜海湾, 市中心'
      },
      ru: {
        buy: 'Купить',
        home: 'Главная',
        rent: 'Аренда',
        offplan: 'Новостройки',
        commercial: 'Коммерческая',
        valuation: 'Оценка',
        favorites: 'Избранное',
        signIn: 'Войти',
        login: 'Войти',
        sell: 'Продать',
        postProperty: 'Разместить объект',
        heroTitle: 'Найдите следующую недвижимость',
        heroSubtitle: 'Открывайте дома, инвестиции и коммерческую недвижимость по всему ОАЭ.',
        location: 'Расположение',
        country: 'Страна',
        city: 'Город',
        propertyType: 'Тип недвижимости',
        selectPropertyType: 'Выберите тип недвижимости',
        maxBudget: 'Макс. бюджет',
        minPrice: 'Мин. цена',
        maxPrice: 'Макс. цена',
        language: 'Язык',
        currency: 'Валюта',
        search: 'Поиск',
        featuredProperties: 'Рекомендуемые объекты',
        allResidential: 'Все жилые',
        apartment: 'Квартира',
        villa: 'Вилла',
        townhouse: 'Таунхаус',
        penthouse: 'Пентхаус',
        commercialType: 'Коммерческая',
        land: 'Земля',
        advancedSearch: 'Расширенный поиск', bedrooms: 'Спальни', bathrooms: 'Ванные', balcony: 'Балкон', minArea: 'Мин. площадь (кв. фут)', maxArea: 'Макс. площадь (кв. фут)', furnishing: 'Мебель', anyFurnishing: 'Любая меблировка', furnished: 'Меблировано', unfurnished: 'Без мебели', completion: 'Готовность', anyCompletion: 'Любая готовность', ready: 'Готово', offPlanStatus: 'Новостройка', parking: 'Парковочные места', amenities: 'Удобства', amenitiesPlaceholder: 'например: бассейн, спортзал, вид на море',
        anyPrice: 'Любая цена',
        verified: 'Проверено',
        beds: 'Спальни',
        baths: 'Ванные',
        sqft: 'кв. фут',
        contact: 'Связаться',
        bookViewing: 'Записаться на просмотр',
        locationPlaceholder: 'например: Dubai Marina, Downtown'
      }
    };

    return translations[language] || translations.en;
  }

  formatPrice(value, currency = store.getState().currency || 'AED') {
    const exchangeRates = store.getState().exchangeRates || { AED: 1.0, USD: 0.27, EUR: 0.25, GBP: 0.21, CNY: 1.96, RUB: 9.3 };
    const rate = exchangeRates[currency] || 1;
    const baseRate = exchangeRates.AED || 1;
    const convertedValue = (value * rate) / baseRate;
    const formatterMap = {
      USD: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }),
      AED: new Intl.NumberFormat('en-AE', { style: 'currency', currency: 'AED', maximumFractionDigits: 0 }),
      EUR: new Intl.NumberFormat('en-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }),
      GBP: new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 }),
      CNY: new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', maximumFractionDigits: 0 }),
      RUB: new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 })
    };

    return (formatterMap[currency] || formatterMap.AED).format(convertedValue);
  }

  getCities(country) {
    const cities = {
      AE: ['Dubai', 'Abu Dhabi', 'Sharjah', 'Ajman', 'Ras Al Khaimah'],
      SA: ['Riyadh', 'Jeddah', 'Dammam', 'Makkah', 'Madinah'],
      QA: ['Doha', 'Al Rayyan', 'Al Wakrah', 'Umm Salal'],
      KW: ['Kuwait City', 'Hawally', 'Salmiya', 'Farwaniya'],
      BH: ['Manama', 'Riffa', 'Muharraq', 'Hamad Town'],
      OM: ['Muscat', 'Salalah', 'Sohar', 'Nizwa'],
      JO: ['Amman', 'Aqaba', 'Irbid', 'Zarqa'],
      EG: ['Cairo', 'Giza', 'Alexandria', 'New Cairo'],
      LB: ['Beirut', 'Jounieh', 'Tripoli', 'Byblos'],
      MA: ['Casablanca', 'Marrakesh', 'Rabat', 'Tangier'],
      TN: ['Tunis', 'Sousse', 'Hammamet', 'Sfax'],
      GB: ['London', 'Manchester', 'Birmingham', 'Liverpool'],
      FR: ['Paris', 'Nice', 'Lyon', 'Marseille'],
      ES: ['Madrid', 'Barcelona', 'Valencia', 'Malaga'],
      DE: ['Berlin', 'Munich', 'Frankfurt', 'Hamburg'],
      CN: ['Shanghai', 'Beijing', 'Shenzhen', 'Guangzhou'],
      RU: ['Moscow', 'Saint Petersburg', 'Kazan', 'Sochi'],
      US: [
        'Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut', 'Delaware', 'Florida', 'Georgia',
        'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa', 'Kansas', 'Kentucky', 'Louisiana', 'Maine', 'Maryland',
        'Massachusetts', 'Michigan', 'Minnesota', 'Mississippi', 'Missouri', 'Montana', 'Nebraska', 'Nevada', 'New Hampshire', 'New Jersey',
        'New Mexico', 'New York', 'North Carolina', 'North Dakota', 'Ohio', 'Oklahoma', 'Oregon', 'Pennsylvania', 'Rhode Island', 'South Carolina',
        'South Dakota', 'Tennessee', 'Texas', 'Utah', 'Vermont', 'Virginia', 'Washington', 'West Virginia', 'Wisconsin', 'Wyoming'
      ]
    };

    return cities[country] || [];
  }

  getCountryCurrency(country) {
    const currencies = {
      AE: 'AED',
      SA: 'SAR',
      QA: 'QAR',
      KW: 'KWD',
      BH: 'BHD',
      OM: 'OMR',
      JO: 'JOD',
      EG: 'EGP',
      LB: 'LBP',
      MA: 'MAD',
      TN: 'TND',
      GB: 'GBP',
      FR: 'EUR',
      ES: 'EUR',
      DE: 'EUR',
      CN: 'CNY',
      RU: 'RUB',
      US: 'USD'
    };

    return currencies[country] || 'AED';
  }

  getFormDraftValues(form) {
    const values = {};
    form.querySelectorAll('input, select, textarea').forEach((field) => {
      if (!field.name || field.type === 'file') return;
      if (field.type === 'checkbox') {
        if (!field.checked) return;
        values[field.name] = values[field.name] || [];
        values[field.name].push(field.value);
      } else if (field.type === 'radio') {
        if (field.checked) values[field.name] = field.value;
      } else {
        values[field.name] = field.value;
      }
    });
    return values;
  }

  applyFormDraftValues(form, values) {
    Object.entries(values || {}).forEach(([name, value]) => {
      const fields = form.querySelectorAll(`[name="${name}"]`);
      if (!fields.length) return;
      if (Array.isArray(value)) {
        fields.forEach((field) => { field.checked = value.includes(field.value); });
      } else if (fields[0].type === 'radio' || fields[0].type === 'checkbox') {
        fields.forEach((field) => { field.checked = field.value === value; });
      } else {
        fields[0].value = value;
      }
    });
  }

  saveFormDraft(draftKey, form) {
    if (!draftKey) return;
    localStorage.setItem(draftKey, JSON.stringify(this.getFormDraftValues(form)));
  }

  loadFormDraft(draftKey) {
    if (!draftKey) return null;
    const raw = localStorage.getItem(draftKey);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  clearFormDraft(draftKey) {
    if (draftKey) localStorage.removeItem(draftKey);
  }

  getOffPlanDrafts(userId) {
    const raw = localStorage.getItem(`al_maha_offplan_drafts_${userId}`);
    if (!raw) return {};
    try {
      return JSON.parse(raw) || {};
    } catch {
      return {};
    }
  }

  saveOffPlanDraft(userId, projectName, values) {
    const drafts = this.getOffPlanDrafts(userId);
    drafts[projectName] = values;
    localStorage.setItem(`al_maha_offplan_drafts_${userId}`, JSON.stringify(drafts));
  }

  deleteOffPlanDraft(userId, projectName) {
    const drafts = this.getOffPlanDrafts(userId);
    delete drafts[projectName];
    localStorage.setItem(`al_maha_offplan_drafts_${userId}`, JSON.stringify(drafts));
  }

  async renderOffPlanPage() {
    const mainContainer = document.getElementById('main-content');
    if (!mainContainer) return;
    const user = store.getState().user;
    const canSubmitProject = user && ['owner', 'agent', 'admin'].includes(user.role) && user.verificationStatus === 'approved';

    document.body.classList.remove('home-page');
    mainContainer.classList.remove('home-page');
    mainContainer.innerHTML = `<section class="property-search-page offplan-page"><div class="property-search-heading"><span class="auth-eyebrow">NEW DEVELOPMENTS</span><h1>Off-Plan Projects</h1><p>Explore approved projects, flexible payment plans, and future-ready homes.</p>${canSubmitProject ? '<button class="btn-primary" id="btn-add-offplan-project" type="button">Add Off-Plan Project</button>' : ''}</div><div class="offplan-filter-bar"><input id="offplan-city" type="search" placeholder="City or location"><input id="offplan-budget" type="number" min="0" placeholder="Maximum starting price"><button class="btn-primary" id="btn-offplan-search" type="button">Search projects</button></div><div class="offplan-results" id="offplan-results"><p>Loading projects...</p></div></section>`;

    const loadProjects = async () => {
      const resultContainer = document.getElementById('offplan-results');
      try {
        const projects = await ApiService.getOffPlanProjects({
          city: document.getElementById('offplan-city').value.trim() || undefined,
          maxPrice: Number(document.getElementById('offplan-budget').value) || undefined
        });
        resultContainer.innerHTML = projects.length ? `<div class="offplan-project-grid">${projects.map(project => `
          <article class="offplan-project-card">
            <img src="${project.hero_image || 'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?auto=format&fit=crop&w=1200&q=80'}" alt="${project.name}">
            <div><div class="offplan-card-badges">${project.is_featured ? '<span>Featured</span>' : ''}${project.is_verified ? '<span>Verified</span>' : ''}</div><h2>${project.name}</h2><p>${project.developers?.name || 'Al Maha Global Property'} · ${project.location || project.city || 'Location to be confirmed'}</p><strong>From ${this.formatPrice(Number(project.starting_price || 0), project.currency || 'AED')}</strong><dl><div><dt>Handover</dt><dd>${project.handover_date || 'TBA'}</dd></div><div><dt>Plan</dt><dd>${project.payment_plan || 'Available'}</dd></div></dl><button class="btn-primary" data-project-slug="${project.slug}" type="button">View project</button></div>
          </article>`).join('')}</div>` : '<p>No approved off-plan projects match these filters yet.</p>';
        resultContainer.querySelectorAll('[data-project-slug]').forEach(button => button.addEventListener('click', () => this.renderOffPlanDetail(button.dataset.projectSlug)));
      } catch (error) {
        resultContainer.innerHTML = `<p>Unable to load off-plan projects: ${error.message}</p>`;
      }
    };

    document.getElementById('btn-offplan-search').addEventListener('click', loadProjects);
    document.getElementById('btn-add-offplan-project')?.addEventListener('click', () => this.renderOffPlanSubmissionPage());
    loadProjects();
  }

  async renderAgentsPage() {
    const mainContainer = document.getElementById('main-content');
    if (!mainContainer) return;

    document.body.classList.remove('home-page');
    mainContainer.classList.remove('home-page');
    mainContainer.innerHTML = `<section class="property-search-page agents-page"><div class="property-search-heading"><span class="auth-eyebrow">OUR NETWORK</span><h1>Registered Agents</h1><p>Browse verified agents and agencies registered with Al Maha Global Property.</p></div><div class="offplan-results" id="agents-results"><p class="agents-status">Loading agents...</p></div></section>`;

    const resultContainer = document.getElementById('agents-results');
    try {
      const agents = await ApiService.getAgents();
      console.log('Agents directory result:', agents);
      resultContainer.innerHTML = agents.length ? `<div class="offplan-project-grid">${agents.map(agent => `
        <article class="offplan-project-card">
          <img src="${agent.avatarUrl || 'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?auto=format&fit=crop&w=800&q=80'}" alt="${agent.fullName}">
          <div><h2>${agent.fullName}</h2><p>${agent.companyName || 'Independent Agent'}</p></div>
        </article>`).join('')}</div>` : '<p class="agents-status">No registered agents are available yet.</p>';
    } catch (error) {
      console.error('Agents directory failed to load:', error);
      resultContainer.innerHTML = `<p class="agents-status agents-status-error">Unable to load agents right now. Please try again later.</p>`;
    }
  }

  renderOffPlanSubmissionPage() {
    const mainContainer = document.getElementById('main-content');
    const user = store.getState().user;
    if (!mainContainer || !user || !['owner', 'agent', 'admin'].includes(user.role) || user.verificationStatus !== 'approved') {
      this.renderOffPlanPage();
      return;
    }

    const offPlanCountries = [
      ['AE', 'United Arab Emirates'], ['SA', 'Saudi Arabia'], ['QA', 'Qatar'], ['KW', 'Kuwait'], ['BH', 'Bahrain'], ['OM', 'Oman'],
      ['JO', 'Jordan'], ['EG', 'Egypt'], ['LB', 'Lebanon'], ['MA', 'Morocco'], ['TN', 'Tunisia'],
      ['GB', 'United Kingdom'], ['FR', 'France'], ['ES', 'Spain'],
      ['DE', 'Germany'], ['CN', 'China'], ['RU', 'Russia'], ['US', 'United States']
    ];
    document.body.classList.remove('home-page');
    mainContainer.classList.remove('home-page');
    mainContainer.innerHTML = `
      <section class="property-search-page offplan-submission-page">
        <div class="property-search-heading"><span class="auth-eyebrow">PROJECT SUBMISSION</span><h1>Add Off-Plan Project</h1><p>Your project will be sent to Al Maha Global Property for review before it is published.</p></div>
        <div class="sell-draft-banner" id="offplan-draft-banner" hidden>
          <span>You have saved project drafts.</span>
          <div>
            <select id="offplan-draft-select"></select>
            <button class="btn-primary" id="btn-load-offplan-draft" type="button">Load saved project</button>
            <button class="btn-outline" id="btn-delete-offplan-draft" type="button">Delete draft</button>
          </div>
        </div>
        <form class="auth-form offplan-submission-form" id="offplan-submission-form">
          <div class="auth-fields">
            <label class="sell-title-field">Project name *<input name="name" required></label>
            <div class="offplan-country-city-fields">
              <label>Project slug *<input name="slug" pattern="[a-z0-9-]+" placeholder="example-residences" required></label>
              <label>Country *<select name="country" id="offplan-country" required><option value="" selected disabled>Select country</option>${offPlanCountries.map(([code, name]) => `<option value="${code}">${name}</option>`).join('')}</select></label>
              <label class="offplan-city-field"><span id="offplan-city-label">City</span> *<select name="city" id="offplan-city" required disabled><option value="" selected>Select country first</option></select></label>
            </div>
            <label>Area / community *<input name="location" placeholder="e.g. Business Bay" required></label>
            <label>Handover *<input name="handoverDate" placeholder="Q4 2028" required></label>
            <label>Starting price *<span class="sell-price-field"><span id="offplan-price-currency">AED</span><input name="startingPrice" id="offplan-starting-price" type="number" min="0" required></span></label>
            <label>Down payment (%) *<input name="downPaymentPercentage" id="offplan-down-payment-percentage" type="number" min="0" max="100" required></label>
            <label class="sell-span-full offplan-down-payment-preview">Down payment amount<strong id="offplan-down-payment-amount">Enter a starting price and percentage</strong></label>
            <label>Construction status *<select name="constructionStatus" required><option value="launching">Launching</option><option value="under_construction">Under construction</option><option value="off_plan">Off-plan</option></select></label>
            <label>Construction progress<input name="constructionProgress" type="number" min="0" max="100" value="0"></label>
            <label>Summary payment plan<input name="paymentPlan" placeholder="60/40 payment plan"></label>
            <label class="sell-span-full">Project description *<textarea name="description" rows="5" required></textarea></label>
          </div>
          <section class="sell-form-section"><div class="sell-section-heading"><div><h2>Starter unit type</h2><p>Add at least one unit type. You can add more after project review.</p></div></div><div class="auth-fields"><label>Unit type name *<input name="unitName" placeholder="1 Bedroom Apartment" required></label><label>Bedrooms *<input name="unitBedrooms" type="number" min="0" required></label><label>Bathrooms *<input name="unitBathrooms" type="number" min="0" required></label><label>Starting area (sqft)<input name="unitArea" type="number" min="0"></label><label>Starting price<input name="unitPrice" type="number" min="0"></label><label>Available units<input name="availableUnits" type="number" min="0" value="0"></label></div></section>
          <section class="sell-form-section"><div class="sell-section-heading"><div><h2>Additional payment stage</h2><p>Optional. The down payment stage above is always included.</p></div></div><div class="auth-fields"><label>Stage<input name="paymentStage" placeholder="On handover"></label><label>Percentage<input name="paymentPercentage" type="number" min="0" max="100"></label><label class="sell-span-full">Stage description<textarea name="paymentDescription" rows="2"></textarea></label></div></section>
          <section class="sell-form-section"><div class="sell-section-heading"><div><h2>Media & amenities</h2><p>The cover image and selected amenities are submitted with the project.</p></div></div><div class="auth-fields"><label>Project cover image<input name="coverImage" type="file" accept="image/jpeg,image/png,image/webp"></label><label class="sell-span-full">Amenities (comma separated)<input name="amenities" placeholder="Pool, Gym, Concierge, Parking"></label></div></section>
          <div class="auth-actions"><button class="btn-outline" id="btn-offplan-cancel" type="button">Cancel</button><button class="btn-outline" id="btn-offplan-draft" type="button">Save Draft</button><button class="btn-primary" type="submit">Submit for review</button></div><p class="auth-status" id="offplan-submit-status" role="status"></p>
        </form>
      </section>`;

    const form = document.getElementById('offplan-submission-form');
    const offPlanCountrySelect = document.getElementById('offplan-country');
    const offPlanCitySelect = document.getElementById('offplan-city');
    const offPlanCityLabel = document.getElementById('offplan-city-label');
    const offPlanPriceCurrency = document.getElementById('offplan-price-currency');
    const offPlanStartingPrice = document.getElementById('offplan-starting-price');
    const offPlanDownPaymentPercentage = document.getElementById('offplan-down-payment-percentage');
    const offPlanDownPaymentAmount = document.getElementById('offplan-down-payment-amount');
    const updateOffPlanCities = () => {
      const cities = this.getCities(offPlanCountrySelect.value);
      const locationLabel = offPlanCountrySelect.value === 'US' ? 'State' : 'City';
      offPlanCityLabel.textContent = locationLabel;
      offPlanCitySelect.disabled = cities.length === 0;
      offPlanCitySelect.innerHTML = `<option value="" selected disabled>${cities.length ? `Select ${locationLabel.toLowerCase()}` : `No ${locationLabel.toLowerCase()} options available`}</option>${cities.map(city => `<option value="${city}">${city}</option>`).join('')}`;
      offPlanPriceCurrency.textContent = this.getCountryCurrency(offPlanCountrySelect.value);
    };
    offPlanCountrySelect.addEventListener('change', updateOffPlanCities);
    const updateOffPlanDownPayment = () => {
      const price = Number(offPlanStartingPrice.value) || 0;
      const percentage = Number(offPlanDownPaymentPercentage.value) || 0;
      if (!price || !percentage) {
        offPlanDownPaymentAmount.textContent = 'Enter a starting price and percentage';
        return;
      }
      offPlanDownPaymentAmount.textContent = `${this.formatPrice(price * percentage / 100, offPlanPriceCurrency.textContent)} (${percentage}% of ${this.formatPrice(price, offPlanPriceCurrency.textContent)})`;
    };
    offPlanStartingPrice.addEventListener('input', updateOffPlanDownPayment);
    offPlanDownPaymentPercentage.addEventListener('input', updateOffPlanDownPayment);
    offPlanCountrySelect.addEventListener('change', updateOffPlanDownPayment);

    const offPlanDraftBanner = document.getElementById('offplan-draft-banner');
    const offPlanDraftSelect = document.getElementById('offplan-draft-select');
    const refreshOffPlanDraftList = () => {
      const drafts = this.getOffPlanDrafts(user.id);
      const draftNames = Object.keys(drafts);
      offPlanDraftBanner.hidden = draftNames.length === 0;
      offPlanDraftSelect.innerHTML = draftNames.map(draftName => `<option value="${draftName}">${draftName}</option>`).join('');
    };
    refreshOffPlanDraftList();
    const applyOffPlanDraft = (values) => {
      this.applyFormDraftValues(form, values);
      form.elements.slug.dataset.edited = 'true';
      if (values.country) {
        updateOffPlanCities();
        if (values.city) offPlanCitySelect.value = values.city;
      }
      updateOffPlanDownPayment();
      document.getElementById('offplan-submit-status').textContent = `Draft "${values.name || ''}" loaded. The cover image must be re-attached.`;
    };
    document.getElementById('btn-load-offplan-draft').addEventListener('click', () => {
      const drafts = this.getOffPlanDrafts(user.id);
      const selectedName = offPlanDraftSelect.value;
      if (selectedName && drafts[selectedName]) applyOffPlanDraft(drafts[selectedName]);
    });
    document.getElementById('btn-delete-offplan-draft').addEventListener('click', () => {
      const selectedName = offPlanDraftSelect.value;
      if (!selectedName) return;
      this.deleteOffPlanDraft(user.id, selectedName);
      refreshOffPlanDraftList();
      document.getElementById('offplan-submit-status').textContent = `Draft "${selectedName}" deleted.`;
    });

    form.elements.name.addEventListener('input', () => {
      if (!form.elements.slug.dataset.edited) form.elements.slug.value = form.elements.name.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    });
    form.elements.slug.addEventListener('input', () => { form.elements.slug.dataset.edited = 'true'; });
    document.getElementById('btn-offplan-cancel').addEventListener('click', () => this.renderOffPlanPage());
    document.getElementById('btn-offplan-draft').addEventListener('click', () => {
      const projectName = form.elements.name.value.trim();
      if (!projectName) {
        document.getElementById('offplan-submit-status').textContent = 'Enter a project name before saving a draft.';
        return;
      }
      this.saveOffPlanDraft(user.id, projectName, this.getFormDraftValues(form));
      refreshOffPlanDraftList();
      document.getElementById('offplan-submit-status').textContent = `Draft saved as "${projectName}". You can return and load it later.`;
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const fields = new FormData(form);
      const status = document.getElementById('offplan-submit-status');
      const submitButton = form.querySelector('button[type="submit"]');
      const cover = fields.get('coverImage');
      if (cover?.size && (!['image/jpeg', 'image/png', 'image/webp'].includes(cover.type) || cover.size > 10 * 1024 * 1024)) {
        status.textContent = 'Use a JPG, PNG, or WebP cover image up to 10 MB.';
        return;
      }
      submitButton.disabled = true;
      status.textContent = 'Submitting project...';
      const projectId = crypto.randomUUID();
      let uploadedCoverPath = null;
      try {
        const currencyCode = this.getCountryCurrency(fields.get('country'));
        const startingPrice = Number(fields.get('startingPrice'));
        const downPaymentPercentage = Number(fields.get('downPaymentPercentage'));
        if (cover?.size) {
          const safeName = cover.name.replace(/[^a-zA-Z0-9._-]/g, '_');
          uploadedCoverPath = `${user.id}/${projectId}/${crypto.randomUUID()}-${safeName}`;
          const upload = await supabase.storage.from('project-media').upload(uploadedCoverPath, cover, { contentType: cover.type, upsert: false });
          if (upload.error) throw upload.error;
        }
        const projectResult = await supabase.from('projects').insert({
          id: projectId,
          name: fields.get('name').trim(), slug: fields.get('slug').trim(), description: fields.get('description').trim(),
          country_code: fields.get('country'), city: fields.get('city').trim(), location: fields.get('location').trim(), starting_price: startingPrice,
          currency: currencyCode, handover_date: fields.get('handoverDate').trim(), construction_status: fields.get('constructionStatus'),
          construction_progress: Number(fields.get('constructionProgress')) || 0, payment_plan: fields.get('paymentPlan').trim() || null,
          created_by: user.id, approval_status: 'pending_review'
        }).select('id, slug').single();
        if (projectResult.error) throw projectResult.error;
        const unitResult = await supabase.from('project_unit_types').insert({ project_id: projectId, name: fields.get('unitName').trim(), bedrooms: Number(fields.get('unitBedrooms')), bathrooms: Number(fields.get('unitBathrooms')), min_area_sqft: Number(fields.get('unitArea')) || null, starting_price: Number(fields.get('unitPrice')) || null, available_units: Number(fields.get('availableUnits')) || 0 });
        if (unitResult.error) throw unitResult.error;
        const paymentRows = [{
          project_id: projectId,
          stage: 'Down payment',
          percentage: downPaymentPercentage,
          description: `Due on booking (${this.formatPrice(startingPrice * downPaymentPercentage / 100, currencyCode)})`,
          sort_order: 0
        }];
        const additionalStage = fields.get('paymentStage')?.trim();
        if (additionalStage) {
          paymentRows.push({
            project_id: projectId,
            stage: additionalStage,
            percentage: Number(fields.get('paymentPercentage')) || 0,
            description: fields.get('paymentDescription')?.trim() || null,
            sort_order: 1
          });
        }
        const paymentResult = await supabase.from('project_payment_plan_stages').insert(paymentRows);
        if (paymentResult.error) throw paymentResult.error;
        const amenityRows = fields.get('amenities').split(',').map(value => value.trim()).filter(Boolean).map(amenity_name => ({ project_id: projectId, amenity_name }));
        if (amenityRows.length) {
          const amenityResult = await supabase.from('project_amenities').insert(amenityRows);
          if (amenityResult.error) throw amenityResult.error;
        }
        if (cover?.size) {
          const publicUrl = supabase.storage.from('project-media').getPublicUrl(uploadedCoverPath).data.publicUrl;
          const mediaResult = await supabase.from('project_media').insert({ project_id: projectId, media_type: 'image', storage_path: publicUrl, is_primary: true });
          if (mediaResult.error) throw mediaResult.error;
          const updateResult = await supabase.from('projects').update({ hero_image: publicUrl }).eq('id', projectId);
          if (updateResult.error) throw updateResult.error;
        }
        status.textContent = 'Project submitted for administrator review.';
        this.deleteOffPlanDraft(user.id, fields.get('name').trim());
        form.reset();
      } catch (error) {
        if (uploadedCoverPath) {
          await supabase.storage.from('project-media').remove([uploadedCoverPath]);
        }
        status.textContent = error.message || 'Unable to submit the project.';
        submitButton.disabled = false;
      }
    });
  }

  async renderOffPlanDetail(slug) {
    const mainContainer = document.getElementById('main-content');
    if (!mainContainer) return;
    try {
      const project = await ApiService.getOffPlanProject(slug);
      if (!project) {
        this.renderOffPlanPage();
        return;
      }
      const media = project.project_media || [];
      const amenities = project.project_amenities || [];
      const units = project.project_unit_types || [];
      const payments = [...(project.project_payment_plan_stages || [])].sort((left, right) => left.sort_order - right.sort_order);
      mainContainer.innerHTML = `<section class="offplan-detail-page"><button class="btn-outline" id="btn-offplan-back" type="button">Back to projects</button><div class="offplan-detail-hero"><img src="${project.hero_image || media.find(item => item.is_primary)?.storage_path || 'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?auto=format&fit=crop&w=1600&q=80'}" alt="${project.name}"><div><span class="auth-eyebrow">${project.construction_status || 'OFF-PLAN'}</span><h1>${project.name}</h1><p>${project.location || project.city || ''}</p><strong>From ${this.formatPrice(Number(project.starting_price || 0), project.currency || 'AED')}</strong><button class="btn-primary" id="btn-project-interest" type="button">Register interest</button></div></div><div class="offplan-detail-grid"><section><h2>About the project</h2><p>${project.description || 'Project details will be available shortly.'}</p><h2>Unit types</h2><div class="offplan-unit-list">${units.map(unit => `<article><strong>${unit.name}</strong><span>${unit.bedrooms ?? '-'} bed · ${unit.bathrooms ?? '-'} bath · ${unit.min_area_sqft || '-'} sqft</span><b>From ${this.formatPrice(Number(unit.starting_price || 0), project.currency || 'AED')}</b></article>`).join('') || '<p>Unit types to be announced.</p>'}</div><h2>Payment plan</h2><div class="offplan-payment-list">${payments.map(payment => `<div><strong>${payment.percentage}%</strong><span>${payment.stage}</span><p>${payment.description || ''}</p></div>`).join('') || `<p>${project.payment_plan || 'Payment plan to be announced.'}</p>`}</div></section><aside><h2>Project details</h2><dl><div><dt>Developer</dt><dd>${project.developers?.name || 'N/A'}</dd></div><div><dt>Handover</dt><dd>${project.handover_date || 'TBA'}</dd></div><div><dt>Progress</dt><dd>${project.construction_progress || 0}%</dd></div></dl><h2>Amenities</h2><div class="offplan-amenities">${amenities.map(item => `<span>${item.amenity_name}</span>`).join('') || '<span>Details coming soon</span>'}</div><form class="offplan-interest-form" id="offplan-interest-form" hidden><h2>Register interest</h2><input name="name" placeholder="Full name" required><input name="email" type="email" placeholder="Email address" required><input name="phone" placeholder="Phone number" required><textarea name="message" placeholder="Tell us what you are looking for"></textarea><label><input name="consent" type="checkbox" required> I consent to be contacted about this project.</label><button class="btn-primary" type="submit">Send enquiry</button><p class="auth-status" id="offplan-interest-status"></p></form></aside></div></section>`;
      document.getElementById('btn-offplan-back').addEventListener('click', () => this.renderOffPlanPage());
      document.getElementById('btn-project-interest').addEventListener('click', () => document.getElementById('offplan-interest-form').hidden = false);
      document.getElementById('offplan-interest-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const status = document.getElementById('offplan-interest-status');
        const { error } = await supabase.from('property_inquiries').insert({ project_id: project.id, name: form.get('name'), email: form.get('email'), phone: form.get('phone'), message: form.get('message') || null, consent: true, status: 'new' });
        status.textContent = error ? error.message : 'Thank you. Our project team will contact you shortly.';
      });
    } catch (error) {
      mainContainer.innerHTML = `<section class="property-search-page"><div class="property-search-heading"><h1>Project unavailable</h1><p>${error.message}</p></div></section>`;
    }
  }

  async initializePropertyLocationMap() {
    const mapElement = document.getElementById('sell-location-map');
    const latitudeInput = document.getElementById('sell-latitude');
    const longitudeInput = document.getElementById('sell-longitude');
    const addressInput = document.getElementById('sell-formatted-address');
    const searchInput = addressInput;
    const searchButton = document.getElementById('btn-search-property-location');
    const saveButton = document.getElementById('btn-save-property-location');
    const locationStatus = document.getElementById('sell-location-status');
    const selectedLocation = document.getElementById('sell-selected-location');
    if (!mapElement || !latitudeInput || !longitudeInput) return;

    try {
      const leaflet = await import('https://esm.sh/leaflet@1.9.4');
      const initialPosition = [25.2048, 55.2708];
      const map = leaflet.map(mapElement, { scrollWheelZoom: false }).setView(initialPosition, 11);
      leaflet.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors'
      }).addTo(map);

      const marker = leaflet.marker(initialPosition, { draggable: true }).addTo(map);
      const updateLocation = (latlng, address = '') => {
        latitudeInput.value = latlng.lat.toFixed(6);
        longitudeInput.value = latlng.lng.toFixed(6);
        if (address) {
          addressInput.value = address;
          selectedLocation.textContent = `Saved location: ${address}`;
        }
      };
      const saveMapLocation = async (latlng) => {
        updateLocation(latlng);
        selectedLocation.textContent = 'Saving selected location...';
        try {
          const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(latlng.lat)}&lon=${encodeURIComponent(latlng.lng)}`);
          const result = await response.json();
          const address = result.display_name || `Pin location: ${latlng.lat.toFixed(6)}, ${latlng.lng.toFixed(6)}`;
          updateLocation(latlng, address);
          locationStatus.textContent = 'Location saved from the map pin.';
        } catch (error) {
          const address = `Pin location: ${latlng.lat.toFixed(6)}, ${latlng.lng.toFixed(6)}`;
          updateLocation(latlng, address);
          locationStatus.textContent = 'Map pin location saved.';
        }
      };
      marker.on('dragend', () => saveMapLocation(marker.getLatLng()));
      map.on('click', (event) => {
        marker.setLatLng(event.latlng);
        saveMapLocation(event.latlng);
      });

      searchButton?.addEventListener('click', async () => {
        const query = searchInput.value.trim();
        if (!query) {
          locationStatus.textContent = 'Enter an address, area, or landmark to search.';
          return;
        }

        searchButton.disabled = true;
        locationStatus.textContent = 'Finding location...';
        try {
          const response = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`);
          const results = await response.json();
          if (!results.length) {
            locationStatus.textContent = 'No matching location found. Place the pin manually on the map.';
            return;
          }

          const result = results[0];
          const latlng = leaflet.latLng(Number(result.lat), Number(result.lon));
          map.setView(latlng, 15);
          marker.setLatLng(latlng);
          updateLocation(latlng, result.display_name);
          selectedLocation.textContent = `Saved location: ${result.display_name}`;
          locationStatus.textContent = 'Location selected. You can drag the pin for the exact property position.';
        } catch (error) {
          locationStatus.textContent = 'Location search is unavailable. Place the pin manually on the map.';
        } finally {
          searchButton.disabled = false;
        }
      });

      searchInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          searchButton?.click();
        }
      });

      saveButton?.addEventListener('click', () => {
        const latlng = marker.getLatLng();
        updateLocation(latlng, addressInput.value.trim() || `Pin location: ${latlng.lat.toFixed(6)}, ${latlng.lng.toFixed(6)}`);
        locationStatus.textContent = 'Property location and address saved.';
      });

      selectedLocation.textContent = 'Search for the property or select its point on the map, then save the location.';
    } catch (error) {
      mapElement.classList.add('map-unavailable');
      mapElement.textContent = 'Map could not be loaded. Enter the latitude and longitude manually.';
      latitudeInput.readOnly = false;
      longitudeInput.readOnly = false;
    }
  }

  setupSearchControls() {
    const countrySelect = document.getElementById('search-country');
    const citySelect = document.getElementById('search-city');
    const currency = store.getState().currency || 'AED';

    const updateCities = () => {
      const cities = this.getCities(countrySelect.value);
      citySelect.innerHTML = `<option value="">${this.getTranslations().city}</option>${cities.map(city => `<option value="${city}">${city}</option>`).join('')}`;
    };

    countrySelect?.addEventListener('change', updateCities);
    updateCities();

    document.querySelectorAll('[data-price-currency]').forEach((element) => {
      element.textContent = currency;
    });

    document.getElementById('btn-execute-search')?.addEventListener('click', () => {
      store.setState({
        filters: {
          ...store.getState().filters,
          country: countrySelect.value,
          city: citySelect.value,
          propertyType: document.getElementById('search-type').value,
          minPrice: Number(document.getElementById('search-min-price').value) || 0,
          maxPrice: Number(document.getElementById('search-max-price').value) || 50000000,
          bedrooms: Number(document.getElementById('search-bedrooms')?.value) || 0,
          bathrooms: Number(document.getElementById('search-bathrooms')?.value) || 0,
          balcony: document.getElementById('search-balcony')?.checked || false,
          minAreaSqft: Number(document.getElementById('search-min-area')?.value) || 0,
          maxAreaSqft: Number(document.getElementById('search-max-area')?.value) || 0,
          furnishing: document.getElementById('search-furnishing')?.value || '',
          completionStatus: document.getElementById('search-completion')?.value || '',
          parkingSpaces: Number(document.getElementById('search-parking')?.value) || 0,
          amenities: document.getElementById('search-amenities')?.value.trim() || ''
        }
      });
    });
  }

  handleLocaleChange() {
    this.initHeader();
    if (document.getElementById('auth-form')) {
      this.renderAuthPage();
      return;
    }

    this.renderHomepage();
  }

  renderAuthPage(initialRole = 'buyer') {
    const mainContainer = document.getElementById('main-content');
    if (!mainContainer) return;

    const t = this.getTranslations(store.getState().language || 'en');
    const countries = [
      'Afghanistan', 'Albania', 'Algeria', 'Andorra', 'Angola', 'Antigua and Barbuda', 'Argentina', 'Armenia', 'Australia', 'Austria',
      'Azerbaijan', 'Bahamas', 'Bahrain', 'Bangladesh', 'Barbados', 'Belarus', 'Belgium', 'Belize', 'Benin', 'Bhutan',
      'Bolivia', 'Bosnia and Herzegovina', 'Botswana', 'Brazil', 'Brunei', 'Bulgaria', 'Burkina Faso', 'Burundi', 'Cabo Verde', 'Cambodia',
      'Cameroon', 'Canada', 'Central African Republic', 'Chad', 'Chile', 'China', 'Colombia', 'Comoros', 'Congo', 'Costa Rica',
      'Croatia', 'Cuba', 'Cyprus', 'Czechia', 'Democratic Republic of the Congo', 'Denmark', 'Djibouti', 'Dominica', 'Dominican Republic', 'Ecuador',
      'Egypt', 'El Salvador', 'Equatorial Guinea', 'Eritrea', 'Estonia', 'Eswatini', 'Ethiopia', 'Fiji', 'Finland', 'France',
      'Gabon', 'Gambia', 'Georgia', 'Germany', 'Ghana', 'Greece', 'Grenada', 'Guatemala', 'Guinea', 'Guinea-Bissau',
      'Guyana', 'Haiti', 'Honduras', 'Hungary', 'Iceland', 'India', 'Indonesia', 'Iran', 'Iraq', 'Ireland',
      'Israel', 'Italy', 'Ivory Coast', 'Jamaica', 'Japan', 'Jordan', 'Kazakhstan', 'Kenya', 'Kiribati', 'Kuwait',
      'Kyrgyzstan', 'Laos', 'Latvia', 'Lebanon', 'Lesotho', 'Liberia', 'Libya', 'Liechtenstein', 'Lithuania', 'Luxembourg',
      'Madagascar', 'Malawi', 'Malaysia', 'Maldives', 'Mali', 'Malta', 'Marshall Islands', 'Mauritania', 'Mauritius', 'Mexico',
      'Micronesia', 'Moldova', 'Monaco', 'Mongolia', 'Montenegro', 'Morocco', 'Mozambique', 'Myanmar', 'Namibia', 'Nauru',
      'Nepal', 'Netherlands', 'New Zealand', 'Nicaragua', 'Niger', 'Nigeria', 'North Korea', 'North Macedonia', 'Norway', 'Oman',
      'Pakistan', 'Palau', 'Palestine', 'Panama', 'Papua New Guinea', 'Paraguay', 'Peru', 'Philippines', 'Poland', 'Portugal',
      'Qatar', 'Romania', 'Russia', 'Rwanda', 'Saint Kitts and Nevis', 'Saint Lucia', 'Saint Vincent and the Grenadines', 'Samoa', 'San Marino', 'Sao Tome and Principe',
      'Saudi Arabia', 'Senegal', 'Serbia', 'Seychelles', 'Sierra Leone', 'Singapore', 'Slovakia', 'Slovenia', 'Solomon Islands', 'Somalia',
      'South Africa', 'South Korea', 'South Sudan', 'Spain', 'Sri Lanka', 'Sudan', 'Suriname', 'Sweden', 'Switzerland', 'Syria',
      'Taiwan', 'Tajikistan', 'Tanzania', 'Thailand', 'Timor-Leste', 'Togo', 'Tonga', 'Trinidad and Tobago', 'Tunisia', 'Turkey',
      'Turkmenistan', 'Tuvalu', 'Uganda', 'Ukraine', 'United Arab Emirates', 'United Kingdom', 'United States', 'Uruguay', 'Uzbekistan', 'Vanuatu',
      'Vatican City', 'Venezuela', 'Vietnam', 'Yemen', 'Zambia', 'Zimbabwe'
    ];
    const countryOptions = countries.map(country => `<option value="${country}">${country}</option>`).join('');
    const authText = {
      title: 'Create your Al Maha account',
      subtitle: 'Tell us who you are so we can prepare the right property experience.',
      role: 'I am a',
      buyer: 'Buyer',
      tenant: 'Tenant',
      agent: 'Agent',
      owner: 'Property Owner',
      firstName: 'First name',
      lastName: 'Last name',
      country: 'Country',
      companyName: 'Company name',
      email: 'Email address',
      password: 'Password',
      mobile: 'Mobile number',
      phone: 'Phone number',
      whatsapp: 'WhatsApp number',
      identity: 'Upload official ID',
      license: 'Upload company license',
      fileHint: 'PDF, JPG or PNG',
      submit: 'Submit for verification',
      back: 'Back to home',
      required: 'Required for verification',
      pending: 'Pending Verification: your information will be reviewed by an administrator before the account is approved.',
      invalidFile: 'Please upload a PDF, JPG, or PNG file smaller than 10 MB.'
    };

    document.body.classList.remove('home-page');
    mainContainer.classList.remove('home-page');
    mainContainer.innerHTML = `
      <section class="auth-page">
        <div class="auth-shell">
          <div class="auth-intro">
            <span class="auth-eyebrow">AL MAHA GLOBAL PROPERTY</span>
            <h1>${authText.title}</h1>
            <p>${authText.subtitle}</p>
          </div>
          <form class="auth-form" id="auth-form">
            <div class="auth-section-heading">${authText.role}</div>
            <div class="role-options">
              <label class="role-option"><input type="radio" name="user-role" value="buyer"><span>${authText.buyer}</span></label>
              <label class="role-option"><input type="radio" name="user-role" value="tenant"><span>${authText.tenant}</span></label>
              <label class="role-option"><input type="radio" name="user-role" value="agent"><span>${authText.agent}</span></label>
              <label class="role-option"><input type="radio" name="user-role" value="owner"><span>${authText.owner}</span></label>
            </div>
            <div class="auth-fields">
              <label>${authText.firstName}<input name="firstName" type="text" autocomplete="given-name" required></label>
              <label>${authText.lastName}<input name="lastName" type="text" autocomplete="family-name" required></label>
              <label>${authText.country}
                <select name="country" autocomplete="country" required>
                  <option value="">Select country</option>
                  ${countryOptions}
                </select>
              </label>
              <label>${authText.email} (username)<input name="email" type="email" autocomplete="username" required></label>
              <label>${authText.password}<input name="password" type="password" autocomplete="new-password" minlength="8" required></label>
              <label>${authText.mobile}<input name="mobile" type="tel" autocomplete="tel"></label>
              <label>${authText.phone}<input name="phone" type="tel" autocomplete="tel"></label>
              <label class="agent-whatsapp-field" hidden>${authText.whatsapp}<input name="whatsapp" type="tel" autocomplete="tel"></label>
              <label class="agent-company-field" hidden>${authText.companyName}<input name="companyName" type="text" autocomplete="organization"></label>
            </div>
            <div class="document-upload" id="agent-document" hidden>
              <label>${authText.license}<span class="upload-note">${authText.required} · ${authText.fileHint}</span><input name="license" type="file" accept=".pdf,.jpg,.jpeg,.png"></label>
            </div>
            <div class="document-upload" id="identity-document" hidden>
              <label>${authText.identity}<span class="upload-note">${authText.required} · ${authText.fileHint}</span><input name="identity" type="file" accept=".pdf,.jpg,.jpeg,.png"></label>
            </div>
            <div class="auth-actions">
              <button class="btn-outline" type="button" id="btn-back-home">${authText.back}</button>
              <button class="btn-primary" type="submit">${authText.submit}</button>
            </div>
            <button class="auth-switch" type="button" id="btn-show-login">Already registered? Log in</button>
            <p class="auth-status" id="auth-status" role="status"></p>
          </form>
        </div>
      </section>
    `;

    const roleInputs = [...document.querySelectorAll('input[name="user-role"]')];
    const agentDocument = document.getElementById('agent-document');
    const identityDocument = document.getElementById('identity-document');
    const agentCompanyField = document.querySelector('.agent-company-field');
    const agentWhatsappField = document.querySelector('.agent-whatsapp-field');
    const updateRole = (role) => {
      roleInputs.forEach(input => input.closest('.role-option').classList.toggle('active', input.value === role));
      agentDocument.hidden = role !== 'agent';
      identityDocument.hidden = !['owner', 'agent'].includes(role);
      agentCompanyField.hidden = role !== 'agent';
      agentWhatsappField.hidden = role !== 'agent';
      agentDocument.querySelector('input').required = role === 'agent';
      identityDocument.querySelector('input').required = ['owner', 'agent'].includes(role);
      agentCompanyField.querySelector('input').required = role === 'agent';
      agentWhatsappField.querySelector('input').required = role === 'agent';
    };

    roleInputs.forEach(input => input.addEventListener('change', () => updateRole(input.value)));
    const registrationRole = ['owner', 'agent', 'buyer', 'tenant'].includes(initialRole) ? initialRole : 'buyer';
    const selectedRole = document.querySelector(`input[name="user-role"][value="${registrationRole}"]`);
    selectedRole.checked = true;
    updateRole(registrationRole);
    document.getElementById('btn-back-home')?.addEventListener('click', () => this.renderHomepage());
    document.getElementById('btn-show-login')?.addEventListener('click', () => this.renderLoginPage());
    document.getElementById('auth-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const role = form.elements['user-role'].value;
      const requiredDocuments = role === 'owner'
        ? [form.elements.identity]
        : role === 'agent'
          ? [form.elements.license, form.elements.identity]
          : [];
      const documentFile = requiredDocuments.find(input => input.files[0])?.files[0];

      if (requiredDocuments.some(input => !input.files[0])) {
        document.getElementById('auth-status').textContent = 'Please upload all required verification documents.';
        return;
      }

      if (form.elements.password.value.length < 8) {
        document.getElementById('auth-status').textContent = 'Password must be at least 8 characters.';
        return;
      }

      if (documentFile && requiredDocuments.some(input => !['application/pdf', 'image/jpeg', 'image/png'].includes(input.files[0].type) || input.files[0].size > 10 * 1024 * 1024)) {
        document.getElementById('auth-status').textContent = authText.invalidFile;
        return;
      }

      const submitButton = form.querySelector('button[type="submit"]');
      submitButton.disabled = true;
      document.getElementById('auth-status').textContent = 'Creating your account...';
      const documentEntries = requiredDocuments.map(input => ({
        file: input.files[0],
        type: input.name === 'identity' ? 'identity_document' : 'agency_license'
      }));
      const email = form.elements.email.value.trim();

      if (documentEntries.length > 0) {
        await savePendingKycDocuments(email, documentEntries);
      }

      const { data, error } = await supabase.auth.signUp({
        email,
        password: form.elements.password.value,
        options: {
          emailRedirectTo: getAuthRedirectUrl(),
          data: {
            full_name: `${form.elements.firstName.value.trim()} ${form.elements.lastName.value.trim()}`,
            first_name: form.elements.firstName.value.trim(),
            last_name: form.elements.lastName.value.trim(),
            country: form.elements.country.value,
            phone: form.elements.mobile.value.trim(),
            mobile_phone: form.elements.mobile.value.trim(),
            whatsapp_number: form.elements.whatsapp.value.trim(),
            company_name: form.elements.companyName.value.trim(),
            role
          }
        }
      });

      submitButton.disabled = false;
      if (error) {
        if (documentEntries.length > 0) await removePendingKycDocuments(email);
        document.getElementById('auth-status').textContent = error.message;
        if (/email|confirm/i.test(error.message)) {
          addResendConfirmationButton(form, document.getElementById('auth-status'), email);
        }
        return;
      }

      let uploadResult = null;
      if (data.session && data.user && requiredDocuments.length > 0) {
        uploadResult = await this.uploadKycDocuments(data.user, documentEntries);
        if (uploadResult.error) {
          document.getElementById('auth-status').textContent = `Account created, but document upload failed: ${uploadResult.error.message}`;
          return;
        }
        await removePendingKycDocuments(email);
      }

      const status = document.getElementById('auth-status');
      status.textContent = uploadResult
        ? `${uploadResult.uploadedDocuments.length} document(s) uploaded and confirmed in Supabase. Your account is pending administrator review.`
        : data.session
          ? authText.pending
        : 'Account created. Check your email, verify your account, then sign in to complete document submission.';
      if (!data.session) addResendConfirmationButton(form, status, email);
    });
  }

  renderLoginPage(adminMode = false) {
    const mainContainer = document.getElementById('main-content');
    if (!mainContainer) return;

    document.body.classList.remove('home-page');
    mainContainer.classList.remove('home-page');
    mainContainer.innerHTML = `
      <section class="auth-page login-page">
        <div class="auth-shell login-shell">
          <div class="auth-intro">
            <span class="auth-eyebrow">AL MAHA GLOBAL PROPERTY</span>
            <h1>${adminMode ? 'Administrator sign in' : 'Welcome back'}</h1>
            <p>${adminMode ? 'Use your administrator email and password to access account and submission reviews.' : 'Sign in to manage your property journey.'}</p>
          </div>
          <form class="auth-form" id="login-form">
            <div class="auth-section-heading">${adminMode ? 'Admin login' : 'Log in'}</div>
            <div class="login-fields">
              <label>Email address (username)<input name="email" type="email" autocomplete="username" required></label>
              <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
            </div>
            <button class="auth-switch" type="button" id="btn-forgot-password">Forgot password?</button>
            <div class="auth-actions">
              ${adminMode ? '<button class="btn-outline" type="button" id="btn-admin-login-back">Back to site</button>' : '<button class="btn-outline" type="button" id="btn-show-registration">Create account</button>'}
              <button class="btn-primary" type="submit">${adminMode ? 'Sign in as admin' : 'Log in'}</button>
            </div>
            <p class="auth-status" id="login-status" role="status"></p>
          </form>
        </div>
      </section>
    `;

    document.getElementById('btn-show-registration')?.addEventListener('click', () => this.renderAuthPage());
    document.getElementById('btn-admin-login-back')?.addEventListener('click', () => this.renderHomepage());
    document.getElementById('btn-forgot-password')?.addEventListener('click', () => {
      const email = document.querySelector('#login-form [name="email"]').value.trim();
      this.renderForgotPasswordPage(email);
    });
    document.getElementById('login-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const submitButton = form.querySelector('button[type="submit"]');
      const status = document.getElementById('login-status');
      submitButton.disabled = true;
      status.textContent = 'Signing in...';

      const { data, error } = await supabase.auth.signInWithPassword({
        email: form.elements.email.value.trim(),
        password: form.elements.password.value
      });

      submitButton.disabled = false;
      if (error) {
        status.textContent = error.message;
        if (error.code === 'email_not_confirmed') {
          status.textContent = 'Email not verified.';
          addResendConfirmationButton(form, status, form.elements.email.value.trim());
        }
        return;
      }

      const activeUser = await this.refreshUserProfile(data.user);
      const adminRoles = ['admin', 'platform_owner', 'company_owner', 'company_admin', 'staff'];
      const isApprovedAdmin = activeUser && adminRoles.includes(activeUser.role) && activeUser.verificationStatus === 'approved';
      if (isApprovedAdmin) {
        this.renderAdminVerificationPage();
      } else if (adminMode) {
        status.textContent = activeUser
          ? 'This account does not have approved administrator access.'
          : 'Could not verify administrator access. Try again or contact the site administrator.';
      } else {
        this.initHeader();
        this.renderHomepage();
      }
    });
  }

  renderForgotPasswordPage(initialEmail = '') {
    const mainContainer = document.getElementById('main-content');
    if (!mainContainer) return;

    document.body.classList.remove('home-page');
    mainContainer.classList.remove('home-page');
    mainContainer.innerHTML = `
      <section class="auth-page login-page">
        <div class="auth-shell login-shell">
          <div class="auth-intro">
            <span class="auth-eyebrow">AL MAHA GLOBAL PROPERTY</span>
            <h1>Reset your password</h1>
            <p>Enter your account email and Supabase will send a secure, time-limited reset link.</p>
          </div>
          <form class="auth-form" id="forgot-password-form">
            <div class="login-fields">
              <label>Email address<input name="email" type="email" autocomplete="email" value="${initialEmail}" required></label>
            </div>
            <div class="auth-actions">
              <button class="btn-outline" type="button" id="btn-forgot-back">Back to login</button>
              <button class="btn-primary" type="submit">Send reset link</button>
            </div>
            <p class="auth-status" id="forgot-password-status" role="status"></p>
          </form>
        </div>
      </section>
    `;

    document.getElementById('btn-forgot-back')?.addEventListener('click', () => this.renderLoginPage());
    document.getElementById('forgot-password-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const email = form.elements.email.value.trim();
      const status = document.getElementById('forgot-password-status');
      const submitButton = form.querySelector('button[type="submit"]');
      submitButton.disabled = true;
      status.textContent = 'Requesting reset link...';

      try {
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: getAuthRedirectUrl()
        });
        if (error) {
          status.textContent = error.message.toLowerCase().includes('unable to process request')
            ? 'Supabase could not process the reset request. Check Auth email/SMTP settings and the Auth logs.'
            : error.message;
        } else {
          status.textContent = 'If an account exists for this email, a password reset link has been sent.';
        }
      } catch (error) {
        status.textContent = error.message || 'Unable to send the reset link. Please try again.';
      } finally {
        submitButton.disabled = false;
      }
    });
  }

  renderPasswordResetPage() {
    const mainContainer = document.getElementById('main-content');
    if (!mainContainer) return;

    document.body.classList.remove('home-page');
    mainContainer.classList.remove('home-page');
    mainContainer.innerHTML = `
      <section class="auth-page login-page">
        <div class="auth-shell login-shell">
          <div class="auth-intro">
            <span class="auth-eyebrow">AL MAHA GLOBAL PROPERTY</span>
            <h1>Create a new password</h1>
            <p>Choose a new password for your account.</p>
          </div>
          <form class="auth-form" id="password-reset-form">
            <div class="login-fields">
              <label>New password<input name="password" type="password" autocomplete="new-password" minlength="8" required></label>
              <label>Confirm new password<input name="confirmPassword" type="password" autocomplete="new-password" minlength="8" required></label>
            </div>
            <div class="auth-actions">
              <button class="btn-primary" type="submit">Update password</button>
            </div>
            <p class="auth-status" id="password-reset-status" role="status"></p>
          </form>
        </div>
      </section>
    `;

    document.getElementById('password-reset-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const status = document.getElementById('password-reset-status');
      const submitButton = form.querySelector('button[type="submit"]');
      const password = form.elements.password.value;
      if (password !== form.elements.confirmPassword.value) {
        status.textContent = 'The passwords do not match.';
        return;
      }

      submitButton.disabled = true;
      status.textContent = 'Updating password...';
      const { error } = await supabase.auth.updateUser({ password });
      if (error) {
        status.textContent = error.message;
        submitButton.disabled = false;
        return;
      }

      await supabase.auth.signOut();
      store.setState({ user: null });
      this.initHeader();
      this.renderLoginPage();
      document.getElementById('login-status').textContent = 'Password updated. Sign in with your new password.';
    });
  }

  renderOwnerRegistrationPage() {
    const mainContainer = document.getElementById('main-content');
    if (!mainContainer) return;

    const steps = [
      'Account',
      'Identity',
      'Property',
      'Location',
      'Ownership',
      'Photos',
      'Media',
      'Features',
      'Price',
      'Review'
    ];

    const draft = JSON.parse(localStorage.getItem('al_maha_owner_draft') || '{}');
    const initialValues = {
      fullName: draft.fullName || '',
      email: draft.email || '',
      mobile: draft.mobile || '',
      whatsapp: draft.whatsapp || '',
      password: draft.password || '',
      confirmPassword: draft.confirmPassword || '',
      country: draft.country || 'United Arab Emirates',
      nationality: draft.nationality || 'UAE',
      preferredLanguage: draft.preferredLanguage || 'English',
      dateOfBirth: draft.dateOfBirth || '',
      terms: Boolean(draft.terms),
      privacy: Boolean(draft.privacy),
      accuracy: Boolean(draft.accuracy),
      documentType: draft.documentType || 'Emirates ID',
      documentNumber: draft.documentNumber || '',
      issueDate: draft.issueDate || '',
      expiryDate: draft.expiryDate || '',
      countryOfIssue: draft.countryOfIssue || 'United Arab Emirates',
      ownershipType: draft.ownershipType || 'Individual',
      propertyType: draft.propertyType || 'Apartment',
      propertyStatus: draft.propertyStatus || 'Ready',
      listingTitle: draft.listingTitle || '',
      propertyDescription: draft.propertyDescription || '',
      bedrooms: draft.bedrooms || '',
      bathrooms: draft.bathrooms || '',
      builtUpArea: draft.builtUpArea || '',
      plotArea: draft.plotArea || '',
      floorNumber: draft.floorNumber || '',
      furnishing: draft.furnishing || 'Furnished',
      parkingSpaces: draft.parkingSpaces || '',
      emirate: draft.emirate || 'Dubai',
      city: draft.city || 'Dubai',
      area: draft.area || 'Downtown Dubai',
      community: draft.community || '',
      buildingProject: draft.buildingProject || '',
      buildingNumber: draft.buildingNumber || '',
      unitNumber: draft.unitNumber || '',
      latitude: draft.latitude || '',
      longitude: draft.longitude || '',
      formattedAddress: draft.formattedAddress || '',
      listingPurpose: draft.listingPurpose || 'For Sale',
      price: draft.price || '',
      rentTerm: draft.rentTerm || 'Monthly',
      serviceCharge: draft.serviceCharge || '',
      deposit: draft.deposit || '',
      commission: draft.commission || '',
      paymentTerms: draft.paymentTerms || '',
      negotiable: draft.negotiable || 'Yes',
      listingType: draft.listingType || 'Standard',
      customAmenities: draft.customAmenities || '',
      primaryAmenity: draft.primaryAmenity || ''
    };

    mainContainer.innerHTML = `
      <section class="owner-registration-page">
        <div class="owner-registration-shell">
          <div class="owner-registration-header">
            <span class="auth-eyebrow">AL MAHA GLOBAL PROPERTY</span>
            <h1>Register as Property Owner</h1>
            <p>Create your account and submit your property for verification.</p>
          </div>

          <div class="owner-wizard-progress">
            <div class="owner-progress-meta">
              <span class="owner-step-label">Step 1 of 10</span>
              <span class="owner-progress-status">Account</span>
            </div>
            <div class="owner-progress-track">
              <span class="owner-progress-bar" id="owner-progress-bar"></span>
            </div>
            <div class="owner-step-pills" id="owner-step-pills">
              ${steps.map((step, index) => `<span class="owner-step-pill ${index === 0 ? 'active' : ''}" data-step-index="${index}">${index + 1}</span>`).join('')}
            </div>
          </div>

          <form class="owner-registration-form" id="owner-registration-form" novalidate>
            <section class="owner-step active" data-step="0">
              <div class="owner-step-header">
                <h2>STEP 1 — ACCOUNT REGISTRATION</h2>
              </div>
              <div class="owner-form-grid owner-form-grid-2">
                <label>Full Name *<input name="fullName" type="text" value="${initialValues.fullName}" required></label>
                <label>Email Address *<input name="email" type="email" value="${initialValues.email}" required></label>
                <label>Mobile Number *<input name="mobile" type="tel" value="${initialValues.mobile}" required></label>
                <label>WhatsApp Number<input name="whatsapp" type="tel" value="${initialValues.whatsapp}"></label>
                <label>Password *<input name="password" type="password" value="${initialValues.password}" required></label>
                <label>Confirm Password *<input name="confirmPassword" type="password" value="${initialValues.confirmPassword}" required></label>
                <label>Country *<input name="country" type="text" value="${initialValues.country}" required></label>
                <label>Nationality *<input name="nationality" type="text" value="${initialValues.nationality}" required></label>
                <label>Preferred Language<select name="preferredLanguage"><option value="English" ${initialValues.preferredLanguage === 'English' ? 'selected' : ''}>English</option><option value="Arabic" ${initialValues.preferredLanguage === 'Arabic' ? 'selected' : ''}>Arabic</option><option value="French" ${initialValues.preferredLanguage === 'French' ? 'selected' : ''}>French</option><option value="English (US)" ${initialValues.preferredLanguage === 'English (US)' ? 'selected' : ''}>English (US)</option></select></label>
                <label>Date of Birth<input name="dateOfBirth" type="date" value="${initialValues.dateOfBirth}"></label>
                <label class="owner-file-field">Profile Photo<input name="profilePhoto" type="file" accept="image/jpeg,image/png,image/webp"></label>
              </div>
              <div class="owner-checkboxes">
                <label><input name="terms" type="checkbox" ${initialValues.terms ? 'checked' : ''}> I agree to the Terms & Conditions</label>
                <label><input name="privacy" type="checkbox" ${initialValues.privacy ? 'checked' : ''}> I agree to the Privacy Policy</label>
                <label><input name="accuracy" type="checkbox" ${initialValues.accuracy ? 'checked' : ''}> I confirm that the information provided is accurate</label>
              </div>
            </section>

            <section class="owner-step" data-step="1">
              <div class="owner-step-header">
                <h2>STEP 2 — IDENTITY VERIFICATION</h2>
              </div>
              <div class="owner-form-grid owner-form-grid-2">
                <label>Document Type<select name="documentType"><option value="Emirates ID" ${initialValues.documentType === 'Emirates ID' ? 'selected' : ''}>Emirates ID</option><option value="Passport" ${initialValues.documentType === 'Passport' ? 'selected' : ''}>Passport</option><option value="Other Government ID" ${initialValues.documentType === 'Other Government ID' ? 'selected' : ''}>Other Government ID</option></select></label>
                <label>Document Number *<input name="documentNumber" type="text" value="${initialValues.documentNumber}" required></label>
                <label>Issue Date<input name="issueDate" type="date" value="${initialValues.issueDate}"></label>
                <label>Expiry Date<input name="expiryDate" type="date" value="${initialValues.expiryDate}"></label>
                <label>Country of Issue<input name="countryOfIssue" type="text" value="${initialValues.countryOfIssue}"></label>
              </div>
              <div class="owner-doc-upload-grid">
                <div class="owner-upload-card">
                  <h3>ID Front *</h3>
                  <input name="idFront" type="file" accept=".jpg,.jpeg,.png,.pdf">
                  <small>JPG, JPEG, PNG, PDF</small>
                </div>
                <div class="owner-upload-card">
                  <h3>ID Back *</h3>
                  <input name="idBack" type="file" accept=".jpg,.jpeg,.png,.pdf">
                  <small>JPG, JPEG, PNG, PDF</small>
                </div>
                <div class="owner-upload-card">
                  <h3>Passport copy if applicable</h3>
                  <input name="passportCopy" type="file" accept=".jpg,.jpeg,.png,.pdf">
                  <small>JPG, JPEG, PNG, PDF</small>
                </div>
              </div>
            </section>

            <section class="owner-step" data-step="2">
              <div class="owner-step-header">
                <h2>STEP 3 — PROPERTY OWNERSHIP</h2>
              </div>
              <div class="owner-form-grid owner-form-grid-2">
                <label>Ownership Type *<select name="ownershipType" required><option value="Individual" ${initialValues.ownershipType === 'Individual' ? 'selected' : ''}>Individual</option><option value="Joint Ownership" ${initialValues.ownershipType === 'Joint Ownership' ? 'selected' : ''}>Joint Ownership</option><option value="Company Ownership" ${initialValues.ownershipType === 'Company Ownership' ? 'selected' : ''}>Company Ownership</option><option value="Power of Attorney" ${initialValues.ownershipType === 'Power of Attorney' ? 'selected' : ''}>Power of Attorney</option></select></label>
                <label>Property Type *<select name="propertyType" required><option value="Apartment" ${initialValues.propertyType === 'Apartment' ? 'selected' : ''}>Apartment</option><option value="Villa" ${initialValues.propertyType === 'Villa' ? 'selected' : ''}>Villa</option><option value="Townhouse" ${initialValues.propertyType === 'Townhouse' ? 'selected' : ''}>Townhouse</option><option value="Penthouse" ${initialValues.propertyType === 'Penthouse' ? 'selected' : ''}>Penthouse</option><option value="Duplex" ${initialValues.propertyType === 'Duplex' ? 'selected' : ''}>Duplex</option><option value="Residential Building" ${initialValues.propertyType === 'Residential Building' ? 'selected' : ''}>Residential Building</option><option value="Land" ${initialValues.propertyType === 'Land' ? 'selected' : ''}>Land</option><option value="Office" ${initialValues.propertyType === 'Office' ? 'selected' : ''}>Office</option><option value="Shop" ${initialValues.propertyType === 'Shop' ? 'selected' : ''}>Shop</option><option value="Warehouse" ${initialValues.propertyType === 'Warehouse' ? 'selected' : ''}>Warehouse</option><option value="Factory" ${initialValues.propertyType === 'Factory' ? 'selected' : ''}>Factory</option><option value="Commercial Building" ${initialValues.propertyType === 'Commercial Building' ? 'selected' : ''}>Commercial Building</option><option value="Other" ${initialValues.propertyType === 'Other' ? 'selected' : ''}>Other</option></select></label>
                <label>Property Status *<select name="propertyStatus" required><option value="Ready" ${initialValues.propertyStatus === 'Ready' ? 'selected' : ''}>Ready</option><option value="Off-plan" ${initialValues.propertyStatus === 'Off-plan' ? 'selected' : ''}>Off-plan</option><option value="Under Construction" ${initialValues.propertyStatus === 'Under Construction' ? 'selected' : ''}>Under Construction</option></select></label>
                <label>Property Title / Listing Title *<input name="listingTitle" type="text" value="${initialValues.listingTitle}" required></label>
                <label class="owner-span-2">Property Description *<textarea name="propertyDescription" required>${initialValues.propertyDescription}</textarea></label>
                <label>Number of Bedrooms<input name="bedrooms" type="number" min="0" value="${initialValues.bedrooms}"></label>
                <label>Number of Bathrooms<input name="bathrooms" type="number" min="0" value="${initialValues.bathrooms}"></label>
                <label>Built-up Area<input name="builtUpArea" type="number" min="0" value="${initialValues.builtUpArea}"></label>
                <label>Plot Area<input name="plotArea" type="number" min="0" value="${initialValues.plotArea}"></label>
                <label>Floor Number<input name="floorNumber" type="number" min="0" value="${initialValues.floorNumber}"></label>
                <label>Furnishing<select name="furnishing"><option value="Furnished" ${initialValues.furnishing === 'Furnished' ? 'selected' : ''}>Furnished</option><option value="Unfurnished" ${initialValues.furnishing === 'Unfurnished' ? 'selected' : ''}>Unfurnished</option><option value="Partially Furnished" ${initialValues.furnishing === 'Partially Furnished' ? 'selected' : ''}>Partially Furnished</option></select></label>
                <label>Parking Spaces<input name="parkingSpaces" type="number" min="0" value="${initialValues.parkingSpaces}"></label>
              </div>
            </section>

            <section class="owner-step" data-step="3">
              <div class="owner-step-header">
                <h2>STEP 4 — PROPERTY LOCATION</h2>
              </div>
              <div class="owner-form-grid owner-form-grid-2">
                <label>Country *<input name="locationCountry" type="text" value="${initialValues.country}" required></label>
                <label>Emirate *<input name="emirate" type="text" value="${initialValues.emirate}" required></label>
                <label>City *<input name="city" type="text" value="${initialValues.city}" required></label>
                <label>Area *<input name="area" type="text" value="${initialValues.area}" required></label>
                <label>Community<input name="community" type="text" value="${initialValues.community}"></label>
                <label>Building / Project<input name="buildingProject" type="text" value="${initialValues.buildingProject}"></label>
                <label>Building Number<input name="buildingNumber" type="text" value="${initialValues.buildingNumber}"></label>
                <label>Unit Number<input name="unitNumber" type="text" value="${initialValues.unitNumber}"></label>
                <label>Latitude<input name="latitude" type="text" value="${initialValues.latitude}"></label>
                <label>Longitude<input name="longitude" type="text" value="${initialValues.longitude}"></label>
              </div>
              <div class="owner-map-panel">
                <div class="owner-map-surface">
                  <div class="owner-map-marker" aria-label="Property location marker">⌖</div>
                </div>
                <div class="owner-map-actions">
                  <button type="button" class="btn-outline" id="owner-location-search">Search location</button>
                  <button type="button" class="btn-primary" id="owner-location-confirm">Confirm Property Location</button>
                </div>
                <p class="owner-map-address">${initialValues.formattedAddress}</p>
              </div>
            </section>

            <section class="owner-step" data-step="4">
              <div class="owner-step-header">
                <h2>STEP 5 — TITLE DEED / OWNERSHIP DOCUMENT</h2>
              </div>
              <div class="owner-doc-upload-grid owner-doc-upload-grid-2">
                <div class="owner-upload-card">
                  <h3>Title Deed / Ownership Certificate *</h3>
                  <input name="titleDeed" type="file" accept=".pdf,.jpg,.jpeg,.png">
                  <small>PDF, JPG, JPEG, PNG</small>
                </div>
                <div class="owner-upload-card">
                  <h3>Additional Ownership Document</h3>
                  <input name="additionalOwnershipDoc" type="file" accept=".pdf,.jpg,.jpeg,.png">
                  <small>PDF, JPG, JPEG, PNG</small>
                </div>
                <div class="owner-upload-card">
                  <h3>Purchase Agreement</h3>
                  <input name="purchaseAgreement" type="file" accept=".pdf,.jpg,.jpeg,.png">
                  <small>PDF, JPG, JPEG, PNG</small>
                </div>
                <div class="owner-upload-card">
                  <h3>Power of Attorney if applicable</h3>
                  <input name="powerOfAttorney" type="file" accept=".pdf,.jpg,.jpeg,.png">
                  <small>PDF, JPG, JPEG, PNG</small>
                </div>
                <div class="owner-upload-card owner-upload-card-wide">
                  <h3>Other Supporting Documents</h3>
                  <input name="supportingDocuments" type="file" accept=".pdf,.jpg,.jpeg,.png" multiple>
                  <small>PDF, JPG, JPEG, PNG</small>
                </div>
              </div>
              <p class="owner-security-note">Your documents are securely stored and are only used for property verification. They will not be displayed publicly.</p>
            </section>

            <section class="owner-step" data-step="5">
              <div class="owner-step-header">
                <h2>STEP 6 — PROPERTY PHOTOS</h2>
              </div>
              <div class="owner-photo-upload-box">
                <input name="propertyPhotos" type="file" accept=".jpg,.jpeg,.png,.webp" multiple>
                <small>Minimum 5 photos · Recommended 10–20 photos</small>
              </div>
              <div class="owner-photo-meta">
                <div class="owner-photo-categories">
                  <span>Exterior</span><span>Living Room</span><span>Bedroom</span><span>Bathroom</span><span>Kitchen</span><span>Balcony</span><span>Garden</span><span>Pool</span><span>Parking</span><span>View</span><span>Other</span>
                </div>
                <div class="owner-photo-gallery" id="owner-photo-gallery">
                  <div class="owner-photo-placeholder">Photo preview gallery</div>
                </div>
              </div>
            </section>

            <section class="owner-step" data-step="6">
              <div class="owner-step-header">
                <h2>STEP 7 — PROPERTY VIDEO</h2>
              </div>
              <div class="owner-form-grid owner-form-grid-2">
                <label class="owner-span-2">Property Video<input name="propertyVideo" type="file" accept=".mp4,.mov,.webm"></label>
                <label class="owner-span-2">Property Video URL<input name="propertyVideoUrl" type="url" placeholder="https://www.youtube.com/watch?v=... or Vimeo URL"></label>
              </div>
            </section>

            <section class="owner-step" data-step="7">
              <div class="owner-step-header">
                <h2>STEP 8 — PROPERTY FEATURES</h2>
              </div>
              <div class="owner-feature-grid">
                <label><input type="checkbox" name="amenity" value="Swimming Pool"> Swimming Pool</label>
                <label><input type="checkbox" name="amenity" value="Gym"> Gym</label>
                <label><input type="checkbox" name="amenity" value="Balcony"> Balcony</label>
                <label><input type="checkbox" name="amenity" value="Terrace"> Terrace</label>
                <label><input type="checkbox" name="amenity" value="Garden"> Garden</label>
                <label><input type="checkbox" name="amenity" value="Covered Parking"> Covered Parking</label>
                <label><input type="checkbox" name="amenity" value="Security"> Security</label>
                <label><input type="checkbox" name="amenity" value="CCTV"> CCTV</label>
                <label><input type="checkbox" name="amenity" value="Central Air Conditioning"> Central Air Conditioning</label>
                <label><input type="checkbox" name="amenity" value="Built-in Wardrobes"> Built-in Wardrobes</label>
                <label><input type="checkbox" name="amenity" value="Maid Room"> Maid Room</label>
                <label><input type="checkbox" name="amenity" value="Driver Room"> Driver Room</label>
                <label><input type="checkbox" name="amenity" value="Laundry Room"> Laundry Room</label>
                <label><input type="checkbox" name="amenity" value="Storage Room"> Storage Room</label>
                <label><input type="checkbox" name="amenity" value="Smart Home"> Smart Home</label>
                <label><input type="checkbox" name="amenity" value="Children's Play Area"> Children's Play Area</label>
                <label><input type="checkbox" name="amenity" value="BBQ Area"> BBQ Area</label>
                <label><input type="checkbox" name="amenity" value="Private Beach"> Private Beach</label>
                <label><input type="checkbox" name="amenity" value="Sea View"> Sea View</label>
                <label><input type="checkbox" name="amenity" value="City View"> City View</label>
                <label><input type="checkbox" name="amenity" value="Garden View"> Garden View</label>
                <label><input type="checkbox" name="amenity" value="Community View"> Community View</label>
                <label><input type="checkbox" name="amenity" value="Elevator"> Elevator</label>
                <label><input type="checkbox" name="amenity" value="Reception"> Reception</label>
                <label><input type="checkbox" name="amenity" value="Concierge"> Concierge</label>
                <label><input type="checkbox" name="amenity" value="Pets Allowed"> Pets Allowed</label>
              </div>
              <label class="owner-span-2">Additional custom amenities<input name="customAmenities" type="text" value="${initialValues.customAmenities}" placeholder="e.g. Wine cellar, Solar panels, Staff accommodation"></label>
            </section>

            <section class="owner-step" data-step="8">
              <div class="owner-step-header">
                <h2>STEP 9 — PRICE & LISTING INFORMATION</h2>
              </div>
              <div class="owner-form-grid owner-form-grid-2">
                <label>Listing Purpose *<select name="listingPurpose" required><option value="For Sale" ${initialValues.listingPurpose === 'For Sale' ? 'selected' : ''}>For Sale</option><option value="For Rent" ${initialValues.listingPurpose === 'For Rent' ? 'selected' : ''}>For Rent</option></select></label>
                <label>Price *<input name="price" type="number" min="0" value="${initialValues.price}" required></label>
                <label>Currency<input name="currency" type="text" value="AED" readonly></label>
                <label>Rental Term<select name="rentTerm"><option value="Monthly" ${initialValues.rentTerm === 'Monthly' ? 'selected' : ''}>Monthly</option><option value="Yearly" ${initialValues.rentTerm === 'Yearly' ? 'selected' : ''}>Yearly</option></select></label>
                <label>Service Charge<input name="serviceCharge" type="number" min="0" value="${initialValues.serviceCharge}"></label>
                <label>Deposit<input name="deposit" type="number" min="0" value="${initialValues.deposit}"></label>
                <label>Commission<input name="commission" type="number" min="0" value="${initialValues.commission}"></label>
                <label>Payment Terms<input name="paymentTerms" type="text" value="${initialValues.paymentTerms}"></label>
                <label>Negotiable<select name="negotiable"><option value="Yes" ${initialValues.negotiable === 'Yes' ? 'selected' : ''}>Yes</option><option value="No" ${initialValues.negotiable === 'No' ? 'selected' : ''}>No</option></select></label>
                <label>Listing Type<select name="listingType"><option value="Standard" ${initialValues.listingType === 'Standard' ? 'selected' : ''}>Standard</option><option value="Premium" ${initialValues.listingType === 'Premium' ? 'selected' : ''}>Premium</option><option value="Featured" ${initialValues.listingType === 'Featured' ? 'selected' : ''}>Featured</option></select></label>
              </div>
            </section>

            <section class="owner-step" data-step="9">
              <div class="owner-step-header">
                <h2>STEP 10 — REVIEW BEFORE SUBMISSION</h2>
              </div>
              <div class="owner-review-grid">
                <div class="owner-review-card">
                  <h3>Owner Information</h3>
                  <div id="review-owner"></div>
                </div>
                <div class="owner-review-card">
                  <h3>Property Information</h3>
                  <div id="review-property"></div>
                </div>
                <div class="owner-review-card">
                  <h3>Location</h3>
                  <div id="review-location"></div>
                </div>
                <div class="owner-review-card">
                  <h3>Ownership Information</h3>
                  <div id="review-ownership"></div>
                </div>
                <div class="owner-review-card">
                  <h3>Documents</h3>
                  <div id="review-docs"></div>
                </div>
                <div class="owner-review-card">
                  <h3>Photos / Video</h3>
                  <div id="review-media"></div>
                </div>
                <div class="owner-review-card">
                  <h3>Amenities</h3>
                  <div id="review-amenities"></div>
                </div>
                <div class="owner-review-card">
                  <h3>Price</h3>
                  <div id="review-price"></div>
                </div>
              </div>
              <div class="owner-checklist">
                <label><input type="checkbox" checked> Identity document uploaded</label>
                <label><input type="checkbox" checked> Ownership document uploaded</label>
                <label><input type="checkbox" checked> Property information completed</label>
                <label><input type="checkbox" checked> Location confirmed</label>
                <label><input type="checkbox" checked> Required photos uploaded</label>
                <label><input type="checkbox" checked> Terms accepted</label>
              </div>
            </section>

            <div class="owner-form-actions">
              <button type="button" class="btn-outline" id="owner-back-btn">Back</button>
              <button type="button" class="btn-outline" id="owner-draft-btn">Save Draft</button>
              <button type="button" class="btn-primary" id="owner-next-btn">Save & Continue</button>
              <button type="submit" class="btn-primary is-hidden" id="owner-submit-btn">SUBMIT PROPERTY FOR VERIFICATION</button>
            </div>
            <p class="owner-form-status" id="owner-form-status" aria-live="polite"></p>
          </form>
        </div>
      </section>
    `;

    const stepsEls = [...document.querySelectorAll('.owner-step')];
    const stepPills = [...document.querySelectorAll('.owner-step-pill')];
    const progressBar = document.getElementById('owner-progress-bar');
    const stepLabel = document.querySelector('.owner-step-label');
    const stepStatus = document.querySelector('.owner-progress-status');
    const form = document.getElementById('owner-registration-form');
    let currentStep = 0;

    const persistDraft = () => {
      const formData = new FormData(form);
      const draftObject = Object.fromEntries(formData.entries());
      draftObject.terms = form.querySelector('[name="terms"]')?.checked || false;
      draftObject.privacy = form.querySelector('[name="privacy"]')?.checked || false;
      draftObject.accuracy = form.querySelector('[name="accuracy"]')?.checked || false;
      const selectedAmenities = [...form.querySelectorAll('input[name="amenity"]:checked')].map(checkbox => checkbox.value);
      draftObject.amenities = selectedAmenities;
      localStorage.setItem('al_maha_owner_draft', JSON.stringify(draftObject));
    };

    const getFormSnapshot = () => {
      const formData = new FormData(form);
      const values = Object.fromEntries(formData.entries());
      values.terms = form.querySelector('[name="terms"]')?.checked || false;
      values.privacy = form.querySelector('[name="privacy"]')?.checked || false;
      values.accuracy = form.querySelector('[name="accuracy"]')?.checked || false;
      values.amenities = [...form.querySelectorAll('input[name="amenity"]:checked')].map(checkbox => checkbox.value);
      return values;
    };

    const updateReviewSummary = () => {
      const values = getFormSnapshot();
      document.getElementById('review-owner').innerHTML = `
        <p><strong>Name:</strong> ${values.fullName || '—'}</p>
        <p><strong>Email:</strong> ${values.email || '—'}</p>
        <p><strong>Mobile:</strong> ${values.mobile || '—'}</p>
        <p><strong>Country:</strong> ${values.country || '—'}</p>
      `;
      document.getElementById('review-property').innerHTML = `
        <p><strong>Title:</strong> ${values.listingTitle || '—'}</p>
        <p><strong>Type:</strong> ${values.propertyType || '—'}</p>
        <p><strong>Status:</strong> ${values.propertyStatus || '—'}</p>
        <p><strong>Bedrooms:</strong> ${values.bedrooms || '—'}</p>
      `;
      document.getElementById('review-location').innerHTML = `
        <p><strong>Location:</strong> ${values.area || '—'} ${values.city ? ',' : ''} ${values.city || ''}</p>
        <p><strong>Coordinates:</strong> ${values.latitude || '—'}, ${values.longitude || '—'}</p>
      `;
      document.getElementById('review-ownership').innerHTML = `
        <p><strong>Ownership:</strong> ${values.ownershipType || '—'}</p>
        <p><strong>Document:</strong> ${values.documentType || '—'} ${values.documentNumber ? `(${values.documentNumber})` : ''}</p>
      `;
      document.getElementById('review-docs').innerHTML = `
        <p><strong>Title deed:</strong> ${document.querySelector('[name="titleDeed"]')?.files?.[0]?.name || 'Not uploaded'}</p>
        <p><strong>Identity:</strong> ${document.querySelector('[name="idFront"]')?.files?.[0]?.name || 'Not uploaded'}</p>
      `;
      document.getElementById('review-media').innerHTML = `
        <p><strong>Photos:</strong> ${document.querySelector('[name="propertyPhotos"]')?.files?.length || 0}</p>
        <p><strong>Video URL:</strong> ${values.propertyVideoUrl || 'Not provided'}</p>
      `;
      document.getElementById('review-amenities').innerHTML = `<p>${(values.amenities || []).join(', ') || 'No amenities selected'}</p>`;
      document.getElementById('review-price').innerHTML = `
        <p><strong>Purpose:</strong> ${values.listingPurpose || '—'}</p>
        <p><strong>Price:</strong> AED ${values.price || '0'}</p>
        <p><strong>Type:</strong> ${values.listingType || '—'}</p>
      `;
    };

    const updateWizard = () => {
      stepsEls.forEach((step, index) => step.classList.toggle('active', index === currentStep));
      stepPills.forEach((pill, index) => pill.classList.toggle('active', index === currentStep));
      stepLabel.textContent = `Step ${currentStep + 1} of ${steps.length}`;
      stepStatus.textContent = steps[currentStep];
      progressBar.style.width = `${((currentStep + 1) / steps.length) * 100}%`;
      document.getElementById('owner-next-btn').textContent = currentStep === steps.length - 1 ? 'Submit for Verification' : 'Save & Continue';
      document.getElementById('owner-submit-btn').classList.toggle('is-hidden', currentStep !== steps.length - 1);
      document.getElementById('owner-next-btn').classList.toggle('is-hidden', currentStep === steps.length - 1);
      document.getElementById('owner-back-btn').disabled = currentStep === 0;
      updateReviewSummary();
    };

    const validateStep = (index) => {
      const step = stepsEls[index];
      const requiredFields = [...step.querySelectorAll('[required]')];
      for (const field of requiredFields) {
        if (!field.value.trim()) {
          field.focus();
          document.getElementById('owner-form-status').textContent = `Please complete the required field: ${field.previousElementSibling?.textContent || field.name}`;
          return false;
        }
      }

      if (index === 0) {
        const password = form.querySelector('[name="password"]').value;
        const confirmPassword = form.querySelector('[name="confirmPassword"]').value;
        if (password.length < 8) {
          document.getElementById('owner-form-status').textContent = 'Password must be at least 8 characters.';
          return false;
        }
        if (password !== confirmPassword) {
          document.getElementById('owner-form-status').textContent = 'Passwords do not match.';
          return false;
        }
        const email = form.querySelector('[name="email"]').value.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          document.getElementById('owner-form-status').textContent = 'Enter a valid email address.';
          return false;
        }
        if (!form.querySelector('[name="terms"]').checked || !form.querySelector('[name="privacy"]').checked || !form.querySelector('[name="accuracy"]').checked) {
          document.getElementById('owner-form-status').textContent = 'Please accept the required declaration checkboxes.';
          return false;
        }
      }

      if (index === 1) {
        const idFront = form.querySelector('[name="idFront"]').files[0];
        const idBack = form.querySelector('[name="idBack"]').files[0];
        if (!idFront || !idBack) {
          document.getElementById('owner-form-status').textContent = 'Upload both sides of the identity document.';
          return false;
        }
      }

      if (index === 3) {
        const latitudeValue = form.querySelector('[name="latitude"]').value.trim();
        const longitudeValue = form.querySelector('[name="longitude"]').value.trim();
        const lat = Number(latitudeValue);
        const lng = Number(longitudeValue);
        if (!latitudeValue || !longitudeValue || !Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180 || (lat === 0 && lng === 0)) {
          document.getElementById('owner-form-status').textContent = 'Choose and confirm the property location on the map before continuing.';
          return false;
        }
      }

      document.getElementById('owner-form-status').textContent = '';
      return true;
    };

    const goToStep = (nextIndex) => {
      currentStep = Math.max(0, Math.min(nextIndex, steps.length - 1));
      updateWizard();
    };

    document.getElementById('owner-back-btn')?.addEventListener('click', () => {
      if (currentStep > 0) goToStep(currentStep - 1);
    });

    document.getElementById('owner-next-btn')?.addEventListener('click', () => {
      if (!validateStep(currentStep)) return;
      persistDraft();
      if (currentStep < steps.length - 1) {
        goToStep(currentStep + 1);
      }
    });

    document.getElementById('owner-draft-btn')?.addEventListener('click', () => {
      persistDraft();
      document.getElementById('owner-form-status').textContent = 'Draft saved locally. You can continue later.';
    });

    document.getElementById('owner-location-search')?.addEventListener('click', () => {
      const city = form.querySelector('[name="city"]').value || 'Dubai';
      const area = form.querySelector('[name="area"]').value || 'Downtown';
      document.querySelector('.owner-map-address').textContent = `${area}, ${city}, United Arab Emirates`;
      form.querySelector('[name="formattedAddress"]').value = `${area}, ${city}, United Arab Emirates`;
      form.querySelector('[name="latitude"]').value = '25.2048';
      form.querySelector('[name="longitude"]').value = '55.2708';
      document.getElementById('owner-form-status').textContent = 'Location updated. Please confirm the property location.';
    });

    document.getElementById('owner-location-confirm')?.addEventListener('click', () => {
      const lat = form.querySelector('[name="latitude"]').value;
      const lng = form.querySelector('[name="longitude"]').value;
      document.getElementById('owner-form-status').textContent = `Property location confirmed: ${lat}, ${lng}`;
    });

    form.addEventListener('input', () => {
      persistDraft();
      updateReviewSummary();
    });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!validateStep(currentStep)) return;
      persistDraft();

      const submitButton = document.getElementById('owner-submit-btn');
      const statusElement = document.getElementById('owner-form-status');
      const values = getFormSnapshot();
      const documentSpecs = [
        ['idFront', 'identity_front'],
        ['idBack', 'identity_back'],
        ['passportCopy', 'passport_copy'],
        ['titleDeed', 'property_deed'],
        ['additionalOwnershipDoc', 'additional_ownership_document'],
        ['purchaseAgreement', 'purchase_agreement'],
        ['powerOfAttorney', 'power_of_attorney']
      ];
      const documentEntries = documentSpecs.flatMap(([name, type]) => Array.from(form.querySelector(`[name="${name}"]`)?.files || []).map(file => ({ file, type })));
      const supportingDocuments = Array.from(form.querySelector('[name="supportingDocuments"]')?.files || []);
      supportingDocuments.forEach((file, index) => documentEntries.push({ file, type: `supporting_document_${index + 1}` }));
      const propertyPhotoFiles = Array.from(form.querySelector('[name="propertyPhotos"]')?.files || []);
      const propertyVideoFile = form.querySelector('[name="propertyVideo"]')?.files?.[0];
      const profilePhotoFile = form.querySelector('[name="profilePhoto"]')?.files?.[0];
      const validDocumentTypes = ['application/pdf', 'image/jpeg', 'image/png'];
      const invalidDocument = documentEntries.find(({ file }) => !validDocumentTypes.includes(file.type) || file.size > 10 * 1024 * 1024);
      const invalidPhoto = propertyPhotoFiles.find(file => !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024);
      const invalidProfilePhoto = profilePhotoFile && (!['image/jpeg', 'image/png', 'image/webp'].includes(profilePhotoFile.type) || profilePhotoFile.size > 10 * 1024 * 1024);
      const invalidVideo = propertyVideoFile && (!['video/mp4', 'video/quicktime', 'video/webm'].includes(propertyVideoFile.type) || propertyVideoFile.size > 50 * 1024 * 1024);

      if (invalidDocument || invalidPhoto || invalidProfilePhoto || invalidVideo) {
        statusElement.textContent = 'Check selected files: documents must be PDF, JPG, or PNG up to 10 MB; images up to 10 MB; videos up to 50 MB.';
        return;
      }

      submitButton.disabled = true;
      statusElement.textContent = 'Uploading selected files and submitting your registration...';
      statusElement.classList.remove('success');
      const uploadedPropertyMediaPaths = [];
      let uploadedProfilePhotoPath = null;
      let profilePhotoUrl = null;

      try {
        let currentUser = store.getState().user;
        const email = (values.email || '').trim();
        const password = values.password || '';
        const ownerName = (values.fullName || '').trim();
        const firstName = ownerName.split(' ')[0] || 'Owner';
        const lastName = ownerName.split(' ').slice(1).join(' ') || 'User';

        if (!currentUser && email && password) {
          const { data, error } = await supabase.auth.signUp({
            email,
            password,
            options: {
              emailRedirectTo: getAuthRedirectUrl(),
              data: {
                full_name: ownerName,
                first_name: firstName,
                last_name: lastName,
                country: values.country || 'United Arab Emirates',
                phone: values.mobile || '',
                mobile_phone: values.mobile || '',
                role: 'owner'
              }
            }
          });

          if (error) throw error;
          if (!data.session) {
            throw new Error('Account created. Verify your email, sign in, then restart this submission and attach the files again.');
          }
          currentUser = data?.user ? {
            id: data.user.id,
            email: data.user.email,
            firstName,
            role: 'owner',
            verificationStatus: 'pending_verification'
          } : null;

          if (data?.user && data.user.email) {
            await supabase.from('users').upsert({
              id: data.user.id,
              email: data.user.email,
              username: data.user.email,
              full_name: ownerName,
              first_name: firstName,
              last_name: lastName,
              country: values.country || 'United Arab Emirates',
              phone: values.mobile || '',
              mobile_phone: values.mobile || '',
              role: 'owner',
              verification_status: 'pending_verification'
            }, { onConflict: 'id' });
          }
        }

        const activeUser = currentUser || store.getState().user;
        if (!activeUser?.id) {
          throw new Error('Unable to create a linked account. Please sign in and try again.');
        }
        const { data: authData } = await supabase.auth.getSession();
        if (authData.session?.user.id !== activeUser.id) {
          throw new Error('Sign in with the account for this submission before uploading its files.');
        }

        if (documentEntries.length > 0) {
          const docResult = await this.uploadKycDocuments({ id: activeUser.id, email: activeUser.email || email }, documentEntries);
          if (docResult.error) throw new Error(docResult.error.message || 'Document upload failed.');
        }

        const propertyId = crypto.randomUUID();
        const propertyMediaRows = [];
        for (const [index, file] of propertyPhotoFiles.entries()) {
          const safeFilename = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
          const storagePath = `${activeUser.id}/${propertyId}/${crypto.randomUUID()}-${safeFilename}`;
          const upload = await supabase.storage.from('property-images').upload(storagePath, file, { contentType: file.type, upsert: false });
          if (upload.error) throw upload.error;
          uploadedPropertyMediaPaths.push(storagePath);
          propertyMediaRows.push({ property_id: propertyId, media_type: 'image', url: storagePath, is_primary: index === 0 });
        }

        if (propertyVideoFile) {
          const safeFilename = propertyVideoFile.name.replace(/[^a-zA-Z0-9._-]/g, '_');
          const storagePath = `${activeUser.id}/${propertyId}/${crypto.randomUUID()}-${safeFilename}`;
          const upload = await supabase.storage.from('property-images').upload(storagePath, propertyVideoFile, { contentType: propertyVideoFile.type, upsert: false });
          if (upload.error) throw upload.error;
          uploadedPropertyMediaPaths.push(storagePath);
          propertyMediaRows.push({ property_id: propertyId, media_type: 'video', url: storagePath, is_primary: false });
        }

        if (profilePhotoFile) {
          const safeFilename = profilePhotoFile.name.replace(/[^a-zA-Z0-9._-]/g, '_');
          uploadedProfilePhotoPath = `${activeUser.id}/profiles/${crypto.randomUUID()}-${safeFilename}`;
          const upload = await supabase.storage.from('project-media').upload(uploadedProfilePhotoPath, profilePhotoFile, { contentType: profilePhotoFile.type, upsert: false });
          if (upload.error) throw upload.error;
          profilePhotoUrl = supabase.storage.from('project-media').getPublicUrl(uploadedProfilePhotoPath).data.publicUrl;
        }

        const slugBase = (values.listingTitle || `${values.propertyType || 'Property'} ${values.city || 'Location'}`)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/(^-|-$)/g, '') || 'property';
        const reference = `AMP-${String(Date.now()).slice(-8)}`;

        const propertyApprovalStatus = activeUser.verificationStatus === 'approved' ? 'approved' : 'pending_verification';
        const propertyPayload = {
          id: propertyId,
          reference_number: reference,
          title: values.listingTitle || `${values.propertyType || 'Property'} in ${values.city || 'Dubai'}`,
          slug: `${slugBase}-${Date.now()}`,
          description: values.propertyDescription || 'Owner-submitted property listing pending verification.',
          price: Number(values.price || 0),
          currency: 'AED',
          purpose: (values.listingPurpose || 'For Sale').toLowerCase().includes('rent') ? 'rent' : 'sale',
          property_type: values.propertyType || 'Apartment',
          category: 'residential',
          bedrooms: Number(values.bedrooms || 0),
          bathrooms: Number(values.bathrooms || 0),
          area_sqft: Number(values.builtUpArea || 0),
          plot_area_sqft: Number(values.plotArea || 0),
          floor_number: Number(values.floorNumber || 0),
          furnishing: values.furnishing || 'Unspecified',
          completion_status: values.propertyStatus || 'Ready',
          ownership: values.ownershipType || 'Individual',
          latitude: Number(values.latitude),
          longitude: Number(values.longitude),
          is_verified: propertyApprovalStatus === 'approved',
          is_featured: false,
          status: propertyApprovalStatus,
          agent_id: null,
          project_id: null
        };

        const { data: insertedProperty, error: propertyError } = await supabase
          .from('properties')
          .insert([propertyPayload])
          .select('id, reference_number')
          .single();

        if (propertyError) throw propertyError;

        if (propertyMediaRows.length > 0) {
          const { error: mediaError } = await supabase.from('property_media').insert(propertyMediaRows);
          if (mediaError) throw mediaError;
        }

        const profileUpdate = {
          id: activeUser.id,
          email: activeUser.email || email,
          username: (activeUser.email || email || '').trim(),
          full_name: ownerName,
          first_name: firstName,
          last_name: lastName,
          country: values.country || 'United Arab Emirates',
          phone: values.mobile || '',
          mobile_phone: values.mobile || '',
          role: 'owner',
          verification_status: 'pending_verification'
        };
        if (profilePhotoUrl) profileUpdate.avatar_url = profilePhotoUrl;
        const { error: profileError } = await supabase.from('users').upsert(profileUpdate, { onConflict: 'id' });
        if (profileError) throw profileError;

        if (!store.getState().user) {
          store.setState({
            user: {
              id: activeUser.id,
              email: activeUser.email || email,
              firstName,
              role: 'owner',
              verificationStatus: 'pending_verification'
            }
          });
          this.initHeader();
        }

        statusElement.textContent = `Your property registration was submitted for verification. Reference: ${reference}. An administrator will review your documents and listing.`;
        statusElement.classList.add('success');
        submitButton.textContent = 'Submitted';
        localStorage.removeItem('al_maha_owner_draft');
      } catch (error) {
        if (uploadedPropertyMediaPaths.length) {
          await supabase.storage.from('property-images').remove(uploadedPropertyMediaPaths);
        }
        if (uploadedProfilePhotoPath) {
          await supabase.storage.from('project-media').remove([uploadedProfilePhotoPath]);
        }
        console.error('Owner registration submission failed:', error);
        statusElement.textContent = error?.message || 'Unable to submit your registration right now. Please try again.';
        statusElement.classList.remove('success');
      } finally {
        submitButton.disabled = false;
      }
    });

    updateWizard();
  }

  async renderSellPage() {
    const mainContainer = document.getElementById('main-content');
    if (!mainContainer) return;

    const user = store.getState().user;
    if (user && ['owner', 'agent'].includes(user.role)) {
      const refreshedUser = await this.refreshUserProfile(user);
      const currentUser = refreshedUser || user;
      if (currentUser.verificationStatus !== 'approved') {
        this.renderKycUploadPage();
        return;
      }
    }

    if (!user || !['owner', 'agent'].includes(user.role)) {
      if (user && ['owner', 'agent'].includes(user.role)) {
        this.renderKycUploadPage();
      } else {
        this.renderSellerRegistrationChoice();
      }
      return;
    }

    const t = this.getTranslations(store.getState().language || 'en');
    const sellCountries = [
      ['AE', 'United Arab Emirates'], ['SA', 'Saudi Arabia'], ['QA', 'Qatar'], ['KW', 'Kuwait'], ['BH', 'Bahrain'], ['OM', 'Oman'],
      ['JO', 'Jordan'], ['EG', 'Egypt'], ['LB', 'Lebanon'], ['MA', 'Morocco'], ['TN', 'Tunisia'],
      ['GB', 'United Kingdom'], ['FR', 'France'], ['ES', 'Spain'],
      ['DE', 'Germany'], ['CN', 'China'], ['RU', 'Russia'], ['US', 'United States']
    ];
    const amenities = [
      'Swimming Pool', 'Gym', 'Balcony', 'Terrace', 'Garden', 'Covered Parking', 'Security', 'CCTV',
      'Central Air Conditioning', 'Built-in Wardrobes', 'Maid Room', 'Driver Room', 'Laundry Room',
      'Storage Room', 'Smart Home', "Children's Play Area", 'BBQ Area', 'Private Beach', 'Sea View',
      'City View', 'Garden View', 'Community View', 'Elevator', 'Reception', 'Concierge', 'Pets Allowed'
    ];
    const propertyVerificationDocuments = user.role === 'agent'
      ? [
          ['ownerIdentity', 'Owner identity document', 'owner_identity', 'Must match the title deed owner.'],
          ['agencyAuthorization', 'Owner authorization to agency', 'agency_authorization', 'Signed authority for your agency to sell this property.'],
          ['titleDeed', 'Title deed / ownership certificate', 'title_deed', 'Property ownership evidence.'],
          ['agencyLicense', 'Valid company license', 'agency_license', 'Current company trade or agency license.']
        ]
      : [
          ['ownerIdentity', 'Owner identity document', 'owner_identity', 'Must match the title deed owner.'],
          ['titleDeed', 'Title deed / ownership certificate', 'title_deed', 'Property ownership evidence.']
        ];
    document.body.classList.remove('home-page');
    mainContainer.classList.remove('home-page');
    mainContainer.innerHTML = `
      <section class="property-search-page sell-page">
        <div class="property-search-heading">
          <span class="auth-eyebrow">AL MAHA GLOBAL PROPERTY</span>
          <h1>${t.sell} ${t.postProperty}</h1>
          <p>Share your property with verified buyers and tenants.</p>
        </div>
        <div class="sell-draft-banner" id="sell-draft-banner" hidden>
          <span>You have a saved property draft. Load it to continue where you left off.</span>
          <div><button class="btn-primary" id="btn-load-sell-draft" type="button">Load saved property</button><button class="btn-outline" id="btn-discard-sell-draft" type="button">Discard draft</button></div>
        </div>
        <form class="sell-form auth-form" id="sell-form">
          <div class="auth-fields">
            <label class="sell-title-field">Property title<input name="title" type="text" required></label>
            <label>Property type<select name="type" required><option value="">${t.selectPropertyType}</option><option>Apartment</option><option>Villa</option><option>Townhouse</option><option>Penthouse</option><option>Commercial</option><option>Land</option></select></label>
            <label>Country<select name="country" id="sell-country" required><option value="" selected disabled>Select country</option>${sellCountries.map(([code, name]) => `<option value="${code}">${name}</option>`).join('')}</select></label>
            <label><span id="sell-city-label">City</span><select name="city" id="sell-city" required disabled><option value="" selected>Select country first</option></select></label>
            <label>Price *<span class="sell-price-field"><span id="sell-price-currency">AED</span><input name="price" type="text" inputmode="numeric" pattern="[0-9]{1,14}" maxlength="14" required></span></label>
            <label>Area (sqft)<input name="area" type="number" min="0" required></label>
            <div class="sell-room-fields"><label class="sell-small-field">Bedrooms<input name="bedrooms" type="text" inputmode="numeric" pattern="[0-9]{1,2}" maxlength="2" required></label><label class="sell-small-field">Bathrooms<input name="bathrooms" type="text" inputmode="numeric" pattern="[0-9]{1,2}" maxlength="2" required></label></div>
            <label class="sell-span-full">Property description *<textarea name="description" rows="5" required placeholder="Describe the property, its condition, highlights, and nearby amenities."></textarea></label>
          </div>
          <section class="sell-form-section">
            <div class="sell-section-heading"><div><h2>Property Ownership Verification</h2><p>Upload the title deed for this property and a matching owner identity document. Both files are private and reviewed before this listing can be published.</p></div></div>
            <div class="auth-fields property-verification-fields">
              ${propertyVerificationDocuments.map(([name, label, type, hint]) => `<label>${label} *<input name="${name}" data-property-document-type="${type}" type="file" accept="application/pdf,image/jpeg,image/png" required><small>${hint} PDF, JPG, JPEG, PNG up to 10 MB</small></label>`).join('')}
            </div>
            <p class="auth-status" id="sell-verification-status" role="status"></p>
          </section>
          <section class="sell-form-section">
            <div class="sell-section-heading"><div><h2>Property Photos</h2><p>Upload at least 5 images. JPG, JPEG, PNG, or WebP up to 10 MB each. Recommended: 10-20 photos.</p></div><strong id="sell-photo-count">0 / 5 minimum</strong></div>
            <label class="photo-dropzone" id="photo-dropzone" for="sell-photo-input"><input id="sell-photo-input" type="file" accept="image/jpeg,image/png,image/webp" multiple><span>Drop photos here or <strong>browse files</strong></span></label>
            <div class="sell-photo-gallery" id="sell-photo-gallery" aria-live="polite"></div>
            <p class="auth-status" id="sell-photo-status" role="status"></p>
          </section>
          <section class="sell-form-section">
            <div class="sell-section-heading"><div><h2>Property Amenities</h2><p>Select all features available at this property.</p></div></div>
            <div class="amenities-grid">${amenities.map(amenity => `<label><input name="amenities" type="checkbox" value="${amenity}"><span>${amenity}</span></label>`).join('')}</div>
            <label class="sell-custom-amenity">Additional amenities<input name="customAmenities" type="text" placeholder="e.g. private cinema, wine cellar"></label>
          </section>
          <section class="sell-form-section">
            <div class="sell-section-heading"><div><h2>Property location</h2><p>Search for the property, click the map, or drag the pin to confirm its exact position.</p></div></div>
            <div id="sell-location-map" class="sell-location-map" aria-label="Property location map"></div>
            <label class="sell-location-address"><span>Formatted address</span><span class="sell-location-search"><input id="sell-formatted-address" name="formattedAddress" type="search" placeholder="Enter city, address, building, or landmark"><button class="btn-outline" id="btn-search-property-location" type="button">Find location</button></span></label>
            <p class="sell-selected-location" id="sell-selected-location" role="status"></p>
            <input id="sell-latitude" name="latitude" type="hidden">
            <input id="sell-longitude" name="longitude" type="hidden">
            <div class="sell-location-actions"><button class="btn-primary" id="btn-save-property-location" type="button">Save location</button></div>
            <p class="auth-status" id="sell-location-status" role="status"></p>
          </section>
          <div class="auth-actions">
            <button class="btn-outline" type="button" id="btn-sell-back">${t.home}</button>
            <button class="btn-outline" type="button" id="btn-sell-draft">Save Draft</button>
            <button class="btn-primary" type="submit">Submit Property</button>
          </div>
          <p class="auth-status" id="sell-status" role="status"></p>
        </form>
      </section>
    `;

    document.getElementById('btn-sell-back')?.addEventListener('click', () => this.renderHomepage());
    const sellForm = document.getElementById('sell-form');
    const sellDraftKey = `al_maha_sell_draft_${user.id}`;
    const countrySelect = document.getElementById('sell-country');
    const citySelect = document.getElementById('sell-city');
    const cityLabel = document.getElementById('sell-city-label');
    const priceCurrency = document.getElementById('sell-price-currency');
    const photoInput = document.getElementById('sell-photo-input');
    const photoDropzone = document.getElementById('photo-dropzone');
    const photoGallery = document.getElementById('sell-photo-gallery');
    const photoCount = document.getElementById('sell-photo-count');
    const photoStatus = document.getElementById('sell-photo-status');
    const uploadedPhotos = [];
    this.initializePropertyLocationMap();
    const renderPhotos = () => {
      photoCount.textContent = `${uploadedPhotos.length} / 5 minimum`;
      photoGallery.innerHTML = uploadedPhotos.map((photo, index) => `
        <article class="sell-photo-card ${photo.cover ? 'is-cover' : ''}">
          <button class="sell-photo-preview" type="button" data-photo-preview="${index}" aria-label="Enlarge property photo ${index + 1}"><img src="${photo.url}" alt="Property upload ${index + 1}"></button>
          <div class="sell-photo-card-controls">
            <div><button type="button" data-photo-cover="${index}" title="Set as cover photo">${photo.cover ? 'Cover photo' : 'Set cover'}</button><button type="button" data-photo-remove="${index}" title="Remove photo">&#215;</button></div>
          </div>
        </article>
      `).join('');
    };
    const addPhotos = (files) => {
      const validTypes = ['image/jpeg', 'image/png', 'image/webp'];
      const invalidFile = [...files].find(file => !validTypes.includes(file.type) || file.size > 10 * 1024 * 1024);
      if (invalidFile) {
        photoStatus.textContent = 'Use JPG, JPEG, PNG, or WebP images up to 10 MB each.';
        return;
      }
      [...files].forEach(file => uploadedPhotos.push({ file, url: URL.createObjectURL(file), cover: uploadedPhotos.length === 0 }));
      photoStatus.textContent = '';
      renderPhotos();
    };
    photoInput?.addEventListener('change', () => addPhotos(photoInput.files));
    photoDropzone?.addEventListener('dragover', (event) => { event.preventDefault(); photoDropzone.classList.add('is-dragging'); });
    photoDropzone?.addEventListener('dragleave', () => photoDropzone.classList.remove('is-dragging'));
    photoDropzone?.addEventListener('drop', (event) => { event.preventDefault(); photoDropzone.classList.remove('is-dragging'); addPhotos(event.dataTransfer.files); });
    photoGallery?.addEventListener('click', (event) => {
      const preview = event.target.closest('[data-photo-preview]');
      if (preview) {
        const photo = uploadedPhotos[Number(preview.dataset.photoPreview)];
        const previewOverlay = document.createElement('div');
        previewOverlay.className = 'photo-preview-overlay';
        previewOverlay.innerHTML = `<button class="photo-preview-close" type="button" aria-label="Close image preview">&#215;</button><img src="${photo.url}" alt="Property image preview">`;
        previewOverlay.addEventListener('click', (previewEvent) => {
          if (previewEvent.target === previewOverlay || previewEvent.target.closest('.photo-preview-close')) previewOverlay.remove();
        });
        document.body.append(previewOverlay);
        return;
      }
      const button = event.target.closest('button');
      if (!button) return;
      const index = Number(button.dataset.photoRemove ?? button.dataset.photoCover);
      if (button.dataset.photoRemove !== undefined) {
        URL.revokeObjectURL(uploadedPhotos[index].url);
        uploadedPhotos.splice(index, 1);
        if (uploadedPhotos.length && !uploadedPhotos.some(photo => photo.cover)) uploadedPhotos[0].cover = true;
      } else if (button.dataset.photoCover !== undefined) {
        uploadedPhotos.forEach((photo, photoIndex) => { photo.cover = photoIndex === index; });
      }
      renderPhotos();
    });
    countrySelect?.addEventListener('change', () => {
      const cities = this.getCities(countrySelect.value);
      const locationLabel = countrySelect.value === 'US' ? 'State' : 'City';
      cityLabel.textContent = locationLabel;
      citySelect.disabled = cities.length === 0;
      citySelect.innerHTML = `<option value="" selected disabled>${cities.length ? `Select ${locationLabel.toLowerCase()}` : `No ${locationLabel.toLowerCase()} options available`}</option>${cities.map(city => `<option value="${city}">${city}</option>`).join('')}`;
      priceCurrency.textContent = this.getCountryCurrency(countrySelect.value);
    });

    const sellDraft = this.loadFormDraft(sellDraftKey);
    const applySellDraft = (draftValues) => {
      this.applyFormDraftValues(sellForm, draftValues);
      if (draftValues.country) {
        countrySelect.dispatchEvent(new Event('change'));
        if (draftValues.city) citySelect.value = draftValues.city;
      }
      document.getElementById('sell-status').textContent = 'Draft loaded. Photos and verification documents must be re-attached.';
    };
    const sellDraftBanner = document.getElementById('sell-draft-banner');
    if (sellDraft) {
      sellDraftBanner.hidden = false;
    }
    document.getElementById('btn-load-sell-draft')?.addEventListener('click', () => {
      applySellDraft(sellDraft);
      sellDraftBanner.hidden = true;
    });
    document.getElementById('btn-discard-sell-draft')?.addEventListener('click', () => {
      this.clearFormDraft(sellDraftKey);
      sellDraftBanner.hidden = true;
    });
    document.getElementById('btn-sell-draft')?.addEventListener('click', () => {
      this.saveFormDraft(sellDraftKey, sellForm);
      document.getElementById('sell-status').textContent = 'Draft saved. You can return and finish this listing later.';
    });
    document.getElementById('sell-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (uploadedPhotos.length < 5) {
        photoStatus.textContent = 'Please upload at least 5 property photos before submitting.';
        photoDropzone.focus();
        return;
      }
      const formData = new FormData(event.currentTarget);
      const submitButton = event.currentTarget.querySelector('button[type="submit"]');
      const status = document.getElementById('sell-status');
      const verificationStatus = document.getElementById('sell-verification-status');
      const listingUser = store.getState().user;
      const verificationFiles = [...event.currentTarget.querySelectorAll('[data-property-document-type]')].map(input => ({
        file: input.files[0],
        type: input.dataset.propertyDocumentType
      }));
      const validVerificationTypes = ['application/pdf', 'image/jpeg', 'image/png'];
      if (verificationFiles.some(({ file }) => !file?.size || !validVerificationTypes.includes(file.type) || file.size > 10 * 1024 * 1024)) {
        verificationStatus.textContent = listingUser.role === 'agent'
          ? 'Upload the owner ID, agency authorization, title deed, and valid company licence as PDF, JPG, JPEG, or PNG files up to 10 MB.'
          : 'Upload a valid title deed and matching owner ID as PDF, JPG, JPEG, or PNG files up to 10 MB.';
        return;
      }
      const propertyType = formData.get('type');
      const propertyCategory = ['Commercial'].includes(propertyType) ? 'commercial' : propertyType === 'Land' ? 'land' : 'residential';
      const identifier = crypto.randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase();
      const titleSlug = formData.get('title').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      const propertyId = crypto.randomUUID();

      submitButton.disabled = true;
      status.textContent = 'Saving your property...';
      const uploadedVerificationPaths = [];
      const uploadedStoragePaths = [];
      const verificationRows = [];
      const mediaRows = [];
      try {
        for (const document of verificationFiles) {
          const safeFilename = document.file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
          const storagePath = `${listingUser.id}/${propertyId}/${document.type}-${crypto.randomUUID()}-${safeFilename}`;
          const uploadResult = await supabase.storage.from('property-verification-documents').upload(storagePath, document.file, {
            contentType: document.file.type,
            upsert: false
          });
          if (uploadResult.error) throw uploadResult.error;

          uploadedVerificationPaths.push(storagePath);
          verificationRows.push({
            property_id: propertyId,
            owner_id: listingUser.id,
            document_type: document.type,
            submitted_by_role: listingUser.role,
            storage_path: storagePath,
            original_filename: document.file.name,
            mime_type: document.file.type
          });
        }

        for (const photo of uploadedPhotos) {
          const safeFilename = photo.file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
          const storagePath = `${listingUser.id}/${propertyId}/${crypto.randomUUID()}-${safeFilename}`;
          const uploadResult = await supabase.storage.from('property-images').upload(storagePath, photo.file, {
            contentType: photo.file.type,
            upsert: false
          });
          if (uploadResult.error) throw uploadResult.error;

          uploadedStoragePaths.push(storagePath);
          mediaRows.push({
            property_id: propertyId,
            media_type: 'image',
            url: storagePath,
            is_primary: photo.cover
          });
        }

        const propertyResult = await supabase.from('properties').insert({
          id: propertyId,
          owner_id: listingUser.id,
          reference_number: `AMP-${identifier}`,
          slug: `${titleSlug || 'property'}-${identifier.toLowerCase()}`,
          title: formData.get('title').trim(),
          description: formData.get('description').trim(),
          price: Number(formData.get('price')),
          currency: this.getCountryCurrency(formData.get('country')),
          purpose: 'sale',
          property_type: propertyType,
          category: propertyCategory,
          bedrooms: Number(formData.get('bedrooms')),
          bathrooms: Number(formData.get('bathrooms')),
          area_sqft: Number(formData.get('area')),
          country_code: formData.get('country'),
          city: formData.get('city'),
          latitude: formData.get('latitude') ? Number(formData.get('latitude')) : null,
          longitude: formData.get('longitude') ? Number(formData.get('longitude')) : null,
          status: 'under_review'
        }).select('id, reference_number').single();

        if (propertyResult.error) throw propertyResult.error;

        const verificationResult = await supabase.from('property_verification_documents').insert(verificationRows);
        if (verificationResult.error) throw verificationResult.error;

        const selectedAmenities = formData.getAll('amenities');
        const customAmenities = formData.get('customAmenities').split(',').map(value => value.trim()).filter(Boolean);
        const amenityRows = [...selectedAmenities, ...customAmenities].map(amenity => ({
          property_id: propertyResult.data.id,
          amenity_name: amenity
        }));
        if (amenityRows.length) {
          const amenitiesResult = await supabase.from('property_amenities').insert(amenityRows);
          if (amenitiesResult.error) throw amenitiesResult.error;
        }

        const mediaResult = await supabase.from('property_media').insert(mediaRows);
        if (mediaResult.error) throw mediaResult.error;

        this.renderPropertySubmissionPage({
          title: formData.get('title'),
          city: formData.get('city'),
          country: formData.get('country'),
          price: formData.get('price'),
          currency: this.getCountryCurrency(formData.get('country')),
          photoCount: uploadedPhotos.length,
          referenceNumber: propertyResult.data.reference_number,
          verificationStatus: 'Under review'
        });
        this.clearFormDraft(sellDraftKey);
      } catch (error) {
        if (uploadedVerificationPaths.length) {
          await supabase.storage.from('property-verification-documents').remove(uploadedVerificationPaths);
        }
        if (uploadedStoragePaths.length) {
          await supabase.storage.from('property-images').remove(uploadedStoragePaths);
        }
        console.error('Property submission failed:', error);
        status.textContent = error.message || 'Unable to save this property. Please try again.';
        submitButton.disabled = false;
      }
    });
  }

  renderSellerListingChoice() {
    const mainContainer = document.getElementById('main-content');
    const user = store.getState().user;
    if (!mainContainer || !user || !['owner', 'agent'].includes(user.role) || user.verificationStatus !== 'approved') {
      this.renderSellPage();
      return;
    }

    document.body.classList.remove('home-page');
    mainContainer.classList.remove('home-page');
    mainContainer.innerHTML = `
      <section class="property-search-page seller-listing-choice-page">
        <div class="property-search-heading"><span class="auth-eyebrow">CREATE LISTING</span><h1>What are you listing?</h1><p>Choose the listing type to continue with the right submission details.</p></div>
        <div class="seller-listing-choice-grid">
          <button class="seller-listing-choice" id="btn-ready-property" type="button"><strong>Ready Property</strong><span>Upload an existing apartment, villa, commercial unit, land, or resale property.</span></button>
          <button class="seller-listing-choice" id="btn-offplan-project" type="button"><strong>Off-Plan Project</strong><span>Upload project information, unit types, payment plan, amenities, and project media for review.</span></button>
        </div>
        <button class="btn-outline" id="btn-listing-choice-back" type="button">Back to profile</button>
      </section>
    `;

    document.getElementById('btn-ready-property').addEventListener('click', () => this.renderSellPage());
    document.getElementById('btn-offplan-project').addEventListener('click', () => this.renderOffPlanSubmissionPage());
    document.getElementById('btn-listing-choice-back').addEventListener('click', () => this.renderUserProfilePage());
  }

  renderSellerRegistrationChoice() {
    const mainContainer = document.getElementById('main-content');
    if (!mainContainer) return;

    document.body.classList.remove('home-page');
    mainContainer.classList.remove('home-page');
    mainContainer.innerHTML = `
      <section class="auth-page seller-choice-page">
        <div class="seller-choice-shell">
          <div class="seller-choice-heading"><span class="auth-eyebrow">AL MAHA GLOBAL PROPERTY</span><h1>Register to post a property</h1><p>Choose the account type that represents the party selling the property.</p></div>
          <div class="seller-choice-grid">
            <button class="seller-choice-card" id="btn-register-owner" type="button"><strong>Property Owner</strong><span>Register as the legal owner and verify your identity before submitting each property with its title deed.</span></button>
            <button class="seller-choice-card" id="btn-register-agent" type="button"><strong>Agency / Agent</strong><span>Register your agency with personal ID and a valid company licence, then submit owner authorization for each property.</span></button>
          </div>
          <button class="btn-outline seller-choice-home-button" id="btn-seller-choice-home" type="button">Back to home</button>
        </div>
      </section>
    `;

    document.getElementById('btn-register-owner')?.addEventListener('click', () => this.renderAuthPage('owner'));
    document.getElementById('btn-register-agent')?.addEventListener('click', () => this.renderAuthPage('agent'));
    document.getElementById('btn-seller-choice-home')?.addEventListener('click', () => this.renderHomepage());
  }

  renderPropertySubmissionPage(property) {
    const mainContainer = document.getElementById('main-content');
    if (!mainContainer) return;

    const countryNames = {
      AE: 'United Arab Emirates', SA: 'Saudi Arabia', QA: 'Qatar', KW: 'Kuwait', BH: 'Bahrain', OM: 'Oman',
      JO: 'Jordan', EG: 'Egypt', LB: 'Lebanon', MA: 'Morocco', TN: 'Tunisia',
      GB: 'United Kingdom', FR: 'France', ES: 'Spain',
      DE: 'Germany', CN: 'China', RU: 'Russia', US: 'United States'
    };
    document.body.classList.remove('home-page');
    mainContainer.classList.remove('home-page');
    mainContainer.innerHTML = `
      <section class="property-search-page sell-page">
        <div class="property-search-heading submission-confirmation">
          <span class="auth-eyebrow">PROPERTY SUBMITTED</span>
          <h1>Your property is ready</h1>
          <p>${property.title} has been saved with the details below.</p>
          <div class="submission-summary">
            <div><span>Location</span><strong>${property.city}, ${countryNames[property.country] || property.country}</strong></div>
            <div><span>Price</span><strong>${property.currency} ${Number(property.price).toLocaleString()}</strong></div>
            <div><span>Reference</span><strong>${property.referenceNumber}</strong></div>
            <div><span>Property verification</span><strong>${property.verificationStatus}</strong></div>
          </div>
          <div class="auth-actions">
            <button class="btn-outline" id="btn-submission-dashboard" type="button">My profile</button>
            <button class="btn-primary" id="btn-submission-add" type="button">Add another property</button>
          </div>
        </div>
      </section>
    `;

    document.getElementById('btn-submission-dashboard')?.addEventListener('click', () => this.renderUserProfilePage());
    document.getElementById('btn-submission-add')?.addEventListener('click', () => this.renderSellPage());
  }

  getPropertyCoordinates(property) {
    if (property?.latitude == null || property?.longitude == null || property.latitude === '' || property.longitude === '') return null;
    const latitude = Number(property.latitude);
    const longitude = Number(property.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
    if (latitude === 0 && longitude === 0) return null;
    return { latitude, longitude };
  }

  async showPropertyMap(property) {
    const coordinates = this.getPropertyCoordinates(property);
    if (!coordinates) return;

    document.getElementById('property-map-modal')?.remove();
    const { latitude, longitude } = coordinates;
    const openMapUrl = `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=16/${latitude}/${longitude}`;
    const overlay = document.createElement('div');
    overlay.id = 'property-map-modal';
    overlay.className = 'property-map-backdrop';
    overlay.innerHTML = `
      <section class="property-map-dialog" role="dialog" aria-modal="true" aria-labelledby="property-map-title">
        <button class="property-map-close" type="button" aria-label="Close map">&#215;</button>
        <div class="property-map-heading"><span class="auth-eyebrow">PROPERTY LOCATION</span><h2 id="property-map-title">${escapeHtml(property.title)}</h2><p>${escapeHtml(property.location || 'Location pin')}</p></div>
        <div class="property-map-frame" aria-label="Map showing property location"></div>
        <p class="property-map-coordinates">${latitude.toFixed(6)}, ${longitude.toFixed(6)}</p>
        <a class="btn-outline property-map-external" href="${escapeHtml(openMapUrl)}" target="_blank" rel="noopener">Open larger map</a>
      </section>
    `;
    document.body.append(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('.property-map-close').addEventListener('click', close);
    overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
    document.addEventListener('keydown', function closeOnEscape(event) {
      if (event.key === 'Escape' && document.body.contains(overlay)) close();
      if (!document.body.contains(overlay)) document.removeEventListener('keydown', closeOnEscape);
    });

    const mapElement = overlay.querySelector('.property-map-frame');
    try {
      const leaflet = await import('https://esm.sh/leaflet@1.9.4');
      const map = leaflet.map(mapElement, { scrollWheelZoom: false }).setView([latitude, longitude], 15);
      leaflet.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors'
      }).addTo(map);
      leaflet.marker([latitude, longitude]).addTo(map).bindPopup(escapeHtml(property.title)).openPopup();
    } catch (error) {
      mapElement.textContent = 'Map could not be loaded. Use Open larger map to view this location.';
    }
  }

  bindPropertyActions(container, properties) {
    container.querySelectorAll('[data-property-action]').forEach(button => {
      button.addEventListener('click', () => {
        const property = properties.find(item => item.id === button.dataset.propertyId);
        if (property) this.showPropertyGallery(property, button.dataset.propertyAction);
      });
    });
    container.querySelectorAll('[data-property-map]').forEach(button => {
      button.addEventListener('click', () => {
        const property = properties.find(item => item.id === button.dataset.propertyId);
        if (property) this.showPropertyMap(property);
      });
    });
  }

  showPropertyGallery(property, initialMode = 'gallery') {
    document.getElementById('property-gallery-modal')?.remove();
    const media = (property.images || [])
      .filter(item => ['image', 'video'].includes(item.type) && safeHttpUrl(item.url))
      .map(item => ({ ...item, url: safeHttpUrl(item.url) }));
    if (!media.length && safeHttpUrl(property.image)) media.push({ url: safeHttpUrl(property.image), type: 'image', isPrimary: true });
    let currentIndex = Math.max(0, media.findIndex(item => item.isPrimary));
    let mode = initialMode;
    const canRequest = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(property.id || '');
    const overlay = document.createElement('div');
    overlay.id = 'property-gallery-modal';
    overlay.className = 'property-gallery-backdrop';
    overlay.innerHTML = `
      <section class="property-gallery-dialog" role="dialog" aria-modal="true" aria-labelledby="property-gallery-title">
        <button class="property-gallery-close" type="button" aria-label="Close gallery">&#215;</button>
        <div class="property-gallery-main">
          <div class="property-gallery-stage"></div>
          <div class="property-gallery-thumbnails" aria-label="Property photos"></div>
        </div>
        <div class="property-gallery-sidebar">
          <span class="auth-eyebrow">${property.verified ? 'VERIFIED LISTING' : 'PROPERTY LISTING'}</span>
          <h2 id="property-gallery-title">${escapeHtml(property.title)}</h2>
          <strong class="property-gallery-price">${escapeHtml(property.currency || 'AED')} ${Number(property.price || 0).toLocaleString('en-US')}</strong>
          <p>${escapeHtml(property.location || 'United Arab Emirates')}</p>
          <div class="listing-features"><span>${Number(property.bedrooms || 0)} beds</span><span>${Number(property.bathrooms || 0)} baths</span><span>${Number(property.areaSqft || 0).toLocaleString('en-US')} sqft</span></div>
          <div class="property-gallery-request"></div>
        </div>
      </section>
    `;
    document.body.append(overlay);

    const stage = overlay.querySelector('.property-gallery-stage');
    const thumbnails = overlay.querySelector('.property-gallery-thumbnails');
    const requestPanel = overlay.querySelector('.property-gallery-request');
    const renderMedia = () => {
      const current = media[currentIndex];
      stage.innerHTML = current
        ? `${current.type === 'video'
          ? `<video src="${escapeHtml(current.url)}" controls playsinline preload="metadata"></video>`
          : `<img src="${escapeHtml(current.url)}" alt="${escapeHtml(property.title)} photo ${currentIndex + 1}" loading="eager">`}
          ${media.length > 1 ? `<button class="property-gallery-prev" type="button" aria-label="Previous photo">&#x2039;</button><button class="property-gallery-next" type="button" aria-label="Next photo">&#x203A;</button>` : ''}
          <span class="property-gallery-count">${currentIndex + 1} / ${media.length}</span>`
        : '<div class="property-gallery-empty">No uploaded photos</div>';
      thumbnails.innerHTML = media.map((item, index) => `<button type="button" class="property-gallery-thumbnail ${index === currentIndex ? 'is-active' : ''}" data-gallery-index="${index}" aria-label="Show item ${index + 1}">${item.type === 'video' ? '<span>Video</span>' : `<img src="${escapeHtml(item.url)}" alt="" loading="lazy">`}</button>`).join('');
      stage.querySelector('.property-gallery-prev')?.addEventListener('click', () => {
        currentIndex = (currentIndex - 1 + media.length) % media.length;
        renderMedia();
      });
      stage.querySelector('.property-gallery-next')?.addEventListener('click', () => {
        currentIndex = (currentIndex + 1) % media.length;
        renderMedia();
      });
      thumbnails.querySelectorAll('[data-gallery-index]').forEach(button => button.addEventListener('click', () => {
        currentIndex = Number(button.dataset.galleryIndex);
        renderMedia();
      }));
    };

    const renderRequestPanel = () => {
      if (mode === 'gallery') {
        requestPanel.innerHTML = `
          <h3>Interested in this property?</h3>
          <div class="property-gallery-actions">
            <button class="btn-outline" type="button" data-request-type="contact">Contact dealer</button>
            <button class="btn-primary" type="button" data-request-type="viewing">Book a viewing</button>
          </div>
        `;
        requestPanel.querySelectorAll('[data-request-type]').forEach(button => button.addEventListener('click', () => {
          mode = button.dataset.requestType;
          renderRequestPanel();
        }));
        return;
      }

      if (!canRequest) {
        requestPanel.innerHTML = '<p class="property-gallery-request-status" role="status">Enquiries are available for published listings only.</p><button class="btn-outline" type="button" data-request-back>Back to photos</button>';
        requestPanel.querySelector('[data-request-back]').addEventListener('click', () => { mode = 'gallery'; renderRequestPanel(); });
        return;
      }

      const actionLabel = mode === 'viewing' ? 'Book a viewing' : 'Contact dealer';
      const defaultMessage = mode === 'viewing' ? 'I would like to arrange a viewing for this property.' : 'Please contact me about this property.';
      requestPanel.innerHTML = `
        <h3>${actionLabel}</h3>
        <form class="property-inquiry-form">
          <label>Your name<input name="name" maxlength="120" autocomplete="name" required></label>
          <label>Email<input name="email" type="email" maxlength="254" autocomplete="email" required></label>
          <label>Phone<input name="phone" type="tel" maxlength="50" autocomplete="tel" required></label>
          <label>Message<textarea name="message" maxlength="3000" required>${defaultMessage}</textarea></label>
          <label class="property-inquiry-consent"><input name="consent" type="checkbox" required><span>I consent to be contacted about this property.</span></label>
          <button class="btn-primary" type="submit">Send request</button>
          <button class="btn-outline" type="button" data-request-back>Back to photos</button>
          <p class="property-gallery-request-status" role="status"></p>
        </form>
      `;
      requestPanel.querySelector('[data-request-back]').addEventListener('click', () => { mode = 'gallery'; renderRequestPanel(); });
      requestPanel.querySelector('form').addEventListener('submit', async event => {
        event.preventDefault();
        const form = event.currentTarget;
        const submitButton = form.querySelector('button[type="submit"]');
        const status = form.querySelector('.property-gallery-request-status');
        submitButton.disabled = true;
        status.textContent = 'Sending your request...';
        try {
          const { error } = await supabase.from('property_inquiries').insert({
            property_id: property.id,
            agent_id: property.agentId || null,
            name: form.elements.name.value.trim(),
            phone: form.elements.phone.value.trim(),
            email: form.elements.email.value.trim(),
            message: `${mode === 'viewing' ? 'Viewing request' : 'Contact request'}\n\n${form.elements.message.value.trim()}`,
            consent: form.elements.consent.checked
          });
          if (error) throw error;
          status.textContent = 'Request sent. The dealer will contact you soon.';
          form.reset();
        } catch (error) {
          status.textContent = error.message || 'Unable to send your request. Please try again.';
          submitButton.disabled = false;
        }
      });
    };

    overlay.querySelector('.property-gallery-close').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', event => { if (event.target === overlay) overlay.remove(); });
    document.addEventListener('keydown', function closeOnEscape(event) {
      if (event.key === 'Escape' && document.body.contains(overlay)) overlay.remove();
      if (!document.body.contains(overlay)) document.removeEventListener('keydown', closeOnEscape);
    });
    renderMedia();
    renderRequestPanel();
  }

  async renderPropertySearchPage(purpose = 'sale') {
    const mainContainer = document.getElementById('main-content');
    if (!mainContainer) return;

    const state = store.getState();
    const t = this.getTranslations(state.language || 'en');
    const properties = await ApiService.getProperties({ purpose });
    const countryOptions = [
      ['AE', 'United Arab Emirates'], ['GB', 'United Kingdom'], ['FR', 'France'], ['ES', 'Spain'],
      ['DE', 'Germany'], ['CN', 'China'], ['RU', 'Russia'], ['US', 'United States']
    ].map(([value, label]) => `<option value="${value}">${label}</option>`).join('');

    document.body.classList.remove('home-page');
    mainContainer.classList.remove('home-page');
    mainContainer.innerHTML = `
      <section class="property-search-page">
        <div class="property-search-heading">
          <span class="auth-eyebrow">AL MAHA GLOBAL PROPERTY</span>
          <h1>${purpose === 'rent' ? t.rent : t.buy} ${t.search}</h1>
          <p>${t.heroSubtitle}</p>
        </div>
        <div class="property-search-panel">
          <div class="search-tabs">
            <button class="search-tab ${purpose === 'sale' ? 'active' : ''}" data-search-purpose="sale">${t.buy.toUpperCase()}</button>
            <button class="search-tab ${purpose === 'rent' ? 'active' : ''}" data-search-purpose="rent">${t.rent.toUpperCase()}</button>
          </div>
          <div class="search-grid">
            <div class="search-field">
              <label>${t.location}</label>
              <div class="location-fields">
                <select id="search-country" aria-label="${t.country}">
                  <option value="">${t.country}</option>
                  ${countryOptions}
                </select>
                <select id="search-city" aria-label="${t.city}"><option value="">${t.city}</option></select>
              </div>
            </div>
            <div class="search-field">
              <label>${t.propertyType}</label>
              <select id="search-type">
                <option value="" selected disabled>${t.selectPropertyType}</option>
                <option value="Apartment">${t.apartment}</option>
                <option value="Villa">${t.villa}</option>
                <option value="Townhouse">${t.townhouse}</option>
                <option value="Penthouse">${t.penthouse}</option>
                <option value="Commercial">${t.commercialType}</option>
                <option value="Land">${t.land}</option>
              </select>
            </div>
            <div class="search-field">
              <label>${t.maxBudget}</label>
              <div class="price-fields">
                <div class="price-input-wrap"><span data-price-currency>${state.currency}</span><input type="number" id="search-min-price" min="0" placeholder="${t.minPrice}"></div>
                <div class="price-input-wrap"><span data-price-currency>${state.currency}</span><input type="number" id="search-max-price" min="0" placeholder="${t.maxPrice}"></div>
              </div>
            </div>
            <button class="btn-primary" id="btn-execute-search" type="button">${t.search}</button>
          </div>
          <details class="advanced-search" id="advanced-search">
            <summary>${t.advancedSearch}</summary>
            <div class="advanced-search-grid">
              <label>${t.bedrooms}<select id="search-bedrooms"><option value="">Any</option><option value="1">1+</option><option value="2">2+</option><option value="3">3+</option><option value="4">4+</option><option value="5">5+</option></select></label>
              <label>${t.bathrooms}<select id="search-bathrooms"><option value="">Any</option><option value="1">1+</option><option value="2">2+</option><option value="3">3+</option><option value="4">4+</option><option value="5">5+</option></select></label>
              <div class="area-range">
                <label>${t.minArea}<input type="number" id="search-min-area" min="0" placeholder="0"></label>
                <label>${t.maxArea}<input type="number" id="search-max-area" min="0" placeholder="Any"></label>
              </div>
              <label>${t.furnishing}<select id="search-furnishing"><option value="">${t.anyFurnishing}</option><option value="furnished">${t.furnished}</option><option value="unfurnished">${t.unfurnished}</option></select></label>
              <label>${t.completion}<select id="search-completion"><option value="">${t.anyCompletion}</option><option value="ready">${t.ready}</option><option value="off-plan">${t.offPlanStatus}</option></select></label>
              <label>${t.parking}<input type="number" id="search-parking" min="0" placeholder="Any"></label>
              <label>${t.amenities}<input type="text" id="search-amenities" placeholder="${t.amenitiesPlaceholder}"></label>
              <label class="advanced-check"><input type="checkbox" id="search-balcony"> ${t.balcony}</label>
            </div>
          </details>
        </div>
        </div>
        <section class="property-search-results">
          <h2>${purpose === 'rent' ? t.rent : t.buy} ${t.featuredProperties}</h2>
          <div class="property-results-grid">
            ${properties.map(p => `
              <div class="listing-card">
                <div class="listing-image-container"><button class="listing-gallery-trigger" type="button" data-property-action="gallery" data-property-id="${escapeHtml(p.id)}" aria-label="View photos for ${escapeHtml(p.title)}"><img src="${escapeHtml(p.image)}" alt="${escapeHtml(p.title)}"></button>${p.verified ? `<span class="badge-verified">✓ ${t.verified}</span>` : ''}</div>
                <div class="listing-content">
                  <div class="listing-price">${this.formatPrice(p.price, state.currency)}</div>
                  <div class="listing-features"><span>${p.bedrooms} ${t.beds}</span><span>${p.bathrooms} ${t.baths}</span><span>${p.areaSqft} ${t.sqft}</span></div>
                  <h3 class="listing-title">${p.title}</h3>
                  <div class="listing-location">${p.location}</div>
                  <div class="listing-actions-footer">${this.getPropertyCoordinates(p) ? `<button class="btn-outline" type="button" data-property-map data-property-id="${escapeHtml(p.id)}">View map</button>` : ''}<button class="btn-outline" type="button" data-property-action="contact" data-property-id="${escapeHtml(p.id)}">Contact dealer</button><button class="btn-primary" type="button" data-property-action="viewing" data-property-id="${escapeHtml(p.id)}">Book a viewing</button></div>
                </div>
              </div>
            `).join('')}
          </div>
        </section>
      </section>
    `;

    document.querySelectorAll('[data-search-purpose]').forEach(button => {
      button.addEventListener('click', () => this.renderPropertySearchPage(button.dataset.searchPurpose));
    });
    this.setupSearchControls();
    this.bindPropertyActions(mainContainer, properties);
  }

  initHeader() {
    const headerContainer = document.getElementById('site-header');
    if (!headerContainer) return;

    const state = store.getState();
    const t = this.getTranslations(state.language || 'en');
    const isLocalHost = ['localhost', '127.0.0.1'].includes(window.location.hostname);
    const logoUrl = isLocalHost
      ? new URL('../../assets/icons/icont.png', import.meta.url).href
      : 'https://almahaglobalproperty.com/assets/icons/icont.png';
    const loggedInLabel = state.user ? 'Welcome' : t.login;
    const accountStatusLabel = state.user && ['owner', 'agent'].includes(state.user.role)
      ? state.user.verificationStatus === 'approved' ? 'Verified account' : 'Under verification'
      : '';
    const canPostProperty = state.user
      && ['owner', 'agent'].includes(state.user.role)
      && state.user.verificationStatus === 'approved';

    headerContainer.innerHTML = `
      <header class="site-header">
        <div class="container navbar">
          <a href="#" class="brand-logo" id="brand-home" aria-label="Al Maha Global Property home">
            <img src="${logoUrl}" alt="Al Maha Global Property logo" />
            <span class="brand-text">AL MAHA <span>GLOBAL PROPERTY</span></span>
          </a>
          <nav class="nav-links">
            <a href="#" data-route="home" id="nav-home">${t.home}</a>
            <a href="#" data-route="buy">${t.buy}</a>
            <a href="#" data-route="rent">${t.rent}</a>
            <a href="#" data-route="offplan">${t.offplan}</a>
            <a href="#" data-route="commercial">${t.commercial}</a>
            <a href="#" data-route="agents">Agents</a>
            <a href="#" data-route="contact">Contact</a>
          </nav>
          <div class="header-controls">
            <div class="header-select-wrap">
              <label for="header-language">LANG</label>
              <select id="header-language" title="${t.language}">
                <option value="en" ${state.language === 'en' ? 'selected' : ''}>EN</option>
                <option value="ar" ${state.language === 'ar' ? 'selected' : ''}>AR</option>
                <option value="fr" ${state.language === 'fr' ? 'selected' : ''}>FR</option>
                <option value="es" ${state.language === 'es' ? 'selected' : ''}>ES</option>
                <option value="de" ${state.language === 'de' ? 'selected' : ''}>DE</option>
                <option value="zh" ${state.language === 'zh' ? 'selected' : ''}>ZH</option>
                <option value="ru" ${state.language === 'ru' ? 'selected' : ''}>RU</option>
              </select>
            </div>
            <div class="header-select-wrap">
              <label for="header-currency">CUR</label>
              <select id="header-currency" title="${t.currency}">
                <option value="USD" ${state.currency === 'USD' ? 'selected' : ''}>USD</option>
                <option value="AED" ${state.currency === 'AED' ? 'selected' : ''}>AED</option>
                <option value="EUR" ${state.currency === 'EUR' ? 'selected' : ''}>EUR</option>
                <option value="GBP" ${state.currency === 'GBP' ? 'selected' : ''}>GBP</option>
                <option value="CNY" ${state.currency === 'CNY' ? 'selected' : ''}>CNY</option>
                <option value="RUB" ${state.currency === 'RUB' ? 'selected' : ''}>RUB</option>
              </select>
            </div>
          </div>
          <div class="nav-actions">
            <button class="btn-outline btn-admin-login" id="btn-admin-login" type="button">Admin login</button>
            <button class="btn-outline btn-sign-in" id="btn-sign-in" type="button">${loggedInLabel}</button>
            ${accountStatusLabel ? `<span class="account-status-label ${state.user.verificationStatus === 'approved' ? 'is-approved' : ''}" role="status">${accountStatusLabel}</span>` : ''}
            ${state.user ? '<button class="btn-outline btn-logout" id="btn-logout" type="button" title="Log out" aria-label="Log out"><span aria-hidden="true">&#x21AA;</span></button>' : ''}
            ${['admin', 'platform_owner', 'company_owner', 'company_admin', 'staff'].includes(state.user?.role) && state.user?.verificationStatus === 'approved' ? '<button class="btn-outline btn-admin-dashboard" id="btn-admin-dashboard" type="button">Admin dashboard</button>' : ''}
            <button class="btn-primary btn-sell" id="btn-sell" title="${t.sell}" aria-label="${t.sell}"><span class="sell-icon" aria-hidden="true">⌂</span><span>${t.sell}</span></button>
          </div>
        </div>
      </header>
    `;

    const languageSelect = document.getElementById('header-language');
    const currencySelect = document.getElementById('header-currency');
    const signInButton = document.getElementById('btn-sign-in');
    const adminLoginButton = document.getElementById('btn-admin-login');
    const logoutButton = document.getElementById('btn-logout');
    const adminDashboardButton = document.getElementById('btn-admin-dashboard');
    const sellButton = document.getElementById('btn-sell');
    const homeLinks = [document.getElementById('brand-home'), document.getElementById('nav-home')];
    const buyLink = document.querySelector('[data-route="buy"]');
    const rentLink = document.querySelector('[data-route="rent"]');
    const contactLink = document.querySelector('[data-route="contact"]');

    if (state.user && signInButton) {
      signInButton.textContent = `Welcome, ${state.user.firstName || 'User'}`;
    }

    homeLinks.forEach((link) => link?.addEventListener('click', (event) => {
      event.preventDefault();
      this.renderHomepage();
    }));

    buyLink?.addEventListener('click', (event) => {
      event.preventDefault();
      this.renderPropertySearchPage('sale');
    });

    rentLink?.addEventListener('click', (event) => {
      event.preventDefault();
      this.renderPropertySearchPage('rent');
    });
    document.querySelector('[data-route="offplan"]')?.addEventListener('click', (event) => {
      event.preventDefault();
      this.renderOffPlanPage();
    });
    document.querySelector('[data-route="agents"]')?.addEventListener('click', (event) => {
      event.preventDefault();
      if (!store.getState().user) {
        this.renderLoginPage();
        return;
      }
      this.renderAgentsPage();
    });
    contactLink?.addEventListener('click', (event) => {
      event.preventDefault();
      this.renderContactPage();
    });

    signInButton?.addEventListener('click', async () => {
      let activeUser = store.getState().user;
      if (!activeUser) {
        const { data } = await supabase.auth.getSession();
        if (data.session?.user) {
          activeUser = await this.refreshUserProfile(data.session.user);
        }
      }

      if (activeUser) {
        this.renderUserProfilePage();
      } else {
        this.renderLoginPage();
      }
    });
    adminLoginButton?.addEventListener('click', () => this.renderLoginPage(true));
    logoutButton?.addEventListener('click', async () => {
      logoutButton.disabled = true;
      const { error } = await supabase.auth.signOut();
      if (error) {
        logoutButton.disabled = false;
        logoutButton.title = error.message;
        return;
      }

      store.setState({ user: null });
      this.initHeader();
      this.renderHomepage();
    });
    adminDashboardButton?.addEventListener('click', () => this.renderAdminVerificationPage());
    sellButton?.addEventListener('click', () => {
      if (canPostProperty) {
        this.renderSellerListingChoice();
        return;
      }

      if (state.user && ['owner', 'agent'].includes(state.user.role)) {
        this.renderKycUploadPage();
        return;
      }

      this.renderSellerRegistrationChoice();
    });

    languageSelect?.addEventListener('change', (event) => {
      store.setState({ language: event.target.value });
      this.handleLocaleChange();
    });

    currencySelect?.addEventListener('change', (event) => {
      store.setState({ currency: event.target.value });
      this.renderHomepage();
    });

  }

  async renderHomepage() {
    const mainContainer = document.getElementById('main-content');
    if (!mainContainer) return;

    const state = store.getState();
    const t = this.getTranslations(state.language || 'en');

    document.body.classList.add('home-page');
    mainContainer.classList.add('home-page');
    document.documentElement.lang = state.language || 'en';

    const properties = await ApiService.getProperties();

    mainContainer.innerHTML = `
      <div class="construction-notice" role="status">UNDER CONSTRUCTION</div>
      <section class="hero-section">
        <div class="container">
          <h1 class="hero-title">${t.heroTitle}</h1>
          <p class="hero-subtitle">${t.heroSubtitle}</p>
        </div>
      </section>

      <section class="container" style="padding: 40px 24px 60px;">
        <h2 style="font-size: 2rem; margin-bottom: 24px;">${t.featuredProperties}</h2>
        <div class="property-results-grid">
          ${properties.map(p => `
            <div class="listing-card">
              <div class="listing-image-container">
                <button class="listing-gallery-trigger" type="button" data-property-action="gallery" data-property-id="${escapeHtml(p.id)}" aria-label="View photos for ${escapeHtml(p.title)}"><img src="${escapeHtml(p.image)}" alt="${escapeHtml(p.title)}"></button>
                ${p.verified ? `<span class="badge-verified">✓ ${t.verified}</span>` : ''}
              </div>
              <div class="listing-content">
                <div class="listing-price">${this.formatPrice(p.price, state.currency)}</div>
                <div class="listing-features">
                  <span>${p.bedrooms} ${t.beds}</span>
                  <span>${p.bathrooms} ${t.baths}</span>
                  <span>${p.areaSqft} ${t.sqft}</span>
                </div>
                <h3 class="listing-title">${p.title}</h3>
                <div class="listing-location">${p.location}</div>
                <div class="listing-actions-footer">
                  ${this.getPropertyCoordinates(p) ? `<button class="btn-outline" type="button" data-property-map data-property-id="${escapeHtml(p.id)}">View map</button>` : ''}
                  <button class="btn-outline" type="button" data-property-action="gallery" data-property-id="${escapeHtml(p.id)}">View photos${p.images?.length > 1 ? ` (${p.images.length})` : ''}</button>
                  <button class="btn-outline" type="button" data-property-action="contact" data-property-id="${escapeHtml(p.id)}">Contact dealer</button>
                  <button class="btn-primary" type="button" data-property-action="viewing" data-property-id="${escapeHtml(p.id)}">${t.bookViewing}</button>
                </div>
              </div>
            </div>
          `).join('')}
        </div>
      </section>
    `;

    this.bindPropertyActions(mainContainer, properties);

  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.app = new AlMahaApp();
});