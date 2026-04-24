/**
 * Auth UI — Login/Register modal, user menu, profile display.
 */

import { isAuthenticated, getCurrentUser, registerUser, loginUser, logoutUser, onAuthChange, initAuth, updateProfile, changePassword } from './authClient.js';
import { showToast } from './utils.js';
import { setStorageUser, clearUserData } from './chatStorage.js';
import { setConversationUser, clearAllConversations } from './conversationManager.js';

let _onLoginSuccess = null;

/** Scope localStorage keys to the current user */
function scopeUserStorage(userId) {
  setStorageUser(userId);
  setConversationUser(userId);
}

/** Clear all user-scoped data on logout */
function clearUserStorage() {
  clearAllConversations();
  clearUserData();
  setStorageUser(null);
  setConversationUser(null);
}

/**
 * Resize an image file to a square thumbnail and return as base64 data URL.
 * @param {File} file
 * @param {number} size - Target width/height in pixels
 * @returns {Promise<string>} base64 data URL
 */
function resizeImageToBase64(file, size = 128) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        // Center-crop to square
        const min = Math.min(img.width, img.height);
        const sx = (img.width - min) / 2;
        const sy = (img.height - min) / 2;
        ctx.drawImage(img, sx, sy, min, min, 0, 0, size, size);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function onLoginSuccess(callback) {
  _onLoginSuccess = callback;
}

// ── Auth Modal HTML ────────────────────────────────────────────

function createAuthModal() {
  const modal = document.createElement('div');
  modal.id = 'auth-modal';
  modal.className = 'modal-overlay auth-modal-overlay';
  modal.innerHTML = `
    <div class="modal auth-modal">
      <div class="auth-brand">
        <div class="auth-brand-logo">TX</div>
        <h2>Tenrary-X</h2>
        <p>Cloud AI • Collaborative Inference</p>
      </div>
      <div class="auth-tabs">
        <button class="auth-tab active" data-tab="login">Sign In</button>
        <button class="auth-tab" data-tab="register">Create Account</button>
      </div>

      <form id="login-form" class="auth-form">
        <div class="form-group">
          <label for="login-username">Username or Email</label>
          <input type="text" id="login-username" placeholder="username or email" required autocomplete="username" />
        </div>
        <div class="form-group">
          <label for="login-password">Password</label>
          <input type="password" id="login-password" placeholder="password" required autocomplete="current-password" />
        </div>
        <div class="auth-error" id="login-error"></div>
        <button type="submit" class="auth-submit">Sign In</button>
      </form>

      <form id="register-form" class="auth-form" style="display:none">
        <div class="form-group">
          <label for="reg-username">Username</label>
          <input type="text" id="reg-username" placeholder="3-30 chars, letters/numbers/_" required pattern="[a-zA-Z0-9_]{3,30}" autocomplete="username" />
        </div>
        <div class="form-group">
          <label for="reg-email">Email</label>
          <input type="email" id="reg-email" placeholder="you@example.com" required autocomplete="email" />
        </div>
        <div class="form-group">
          <label for="reg-display">Display Name</label>
          <input type="text" id="reg-display" placeholder="optional" autocomplete="name" />
        </div>
        <div class="form-group">
          <label for="reg-password">Password</label>
          <input type="password" id="reg-password" placeholder="min 8 chars, 1 uppercase, 1 digit" required minlength="8" autocomplete="new-password" />
        </div>
        <div class="form-group">
          <label for="reg-confirm">Confirm Password</label>
          <input type="password" id="reg-confirm" placeholder="repeat password" required autocomplete="new-password" />
        </div>
        <div class="auth-error" id="register-error"></div>
        <button type="submit" class="auth-submit">Create Account</button>
      </form>
    </div>
  `;
  document.body.appendChild(modal);
  return modal;
}

// ── User Menu HTML ─────────────────────────────────────────────

function createUserMenu() {
  const container = document.createElement('div');
  container.id = 'user-menu-container';
  container.className = 'user-menu-container';
  container.innerHTML = `
    <button id="user-menu-btn" class="user-menu-btn" title="Account">
      <span class="user-avatar" id="user-avatar">?</span>
    </button>
    <div id="user-dropdown" class="user-dropdown" hidden>
      <div class="user-dropdown-header">
        <span class="user-dropdown-name" id="user-dropdown-name">Guest</span>
        <span class="user-dropdown-username" id="user-dropdown-username">@guest</span>
      </div>
      <hr />
      <button class="user-dropdown-item" id="btn-profile"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="5" r="3"/><path d="M2 15a6 6 0 0 1 12 0"/></svg> Profile</button>
      <button class="user-dropdown-item" id="btn-my-rooms"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="12" height="10" rx="2"/><path d="M6 3V1M10 3V1"/></svg> My Rooms</button>
      <hr />
      <button class="user-dropdown-item user-dropdown-logout" id="btn-logout"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 14H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h3M11 11l3-3-3-3M14 8H6"/></svg> Sign Out</button>
    </div>
  `;
  return container;
}

// ── Profile Modal HTML ─────────────────────────────────────────

function createProfileModal() {
  const modal = document.createElement('div');
  modal.id = 'profile-modal';
  modal.className = 'modal-overlay';
  modal.style.display = 'none';
  modal.innerHTML = `
    <div class="modal modal-sm profile-modal">
      <div class="modal-header-row">
        <h3>Profile Settings</h3>
        <button class="modal-close-btn" id="profile-modal-close">×</button>
      </div>

      <div class="profile-avatar-section">
        <div class="profile-avatar-upload" id="profile-avatar-upload" title="Click to upload avatar">
          <div class="profile-avatar-large" id="profile-avatar-large">?</div>
          <div class="profile-avatar-overlay">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 10v3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-3M11 5L8 2 5 5M8 2v9"/></svg>
          </div>
        </div>
        <input type="file" id="profile-avatar-file" accept="image/*" hidden />
        <div class="profile-username" id="profile-username-display">@username</div>
        <div class="profile-avatar-hint">Click avatar to upload</div>
      </div>

      <form id="profile-form" class="auth-form">
        <div class="form-group">
          <label for="profile-display-name">Display Name</label>
          <input type="text" id="profile-display-name" placeholder="Your display name" maxlength="50" />
        </div>
        <input type="hidden" id="profile-avatar-url" />
        <div class="auth-error" id="profile-error"></div>
        <button type="submit" class="btn-primary" style="width:100%">Save Changes</button>
      </form>

      <hr style="border:none;border-top:1px solid var(--border);margin:20px 0 16px" />

      <details class="profile-password-section">
        <summary class="profile-password-toggle">Change Password</summary>
        <form id="password-form" class="auth-form" style="margin-top:12px">
          <div class="form-group">
            <label for="pw-current">Current Password</label>
            <input type="password" id="pw-current" required autocomplete="current-password" />
          </div>
          <div class="form-group">
            <label for="pw-new">New Password</label>
            <input type="password" id="pw-new" required minlength="8" autocomplete="new-password" placeholder="min 8 chars, 1 uppercase, 1 digit" />
          </div>
          <div class="form-group">
            <label for="pw-confirm">Confirm New Password</label>
            <input type="password" id="pw-confirm" required autocomplete="new-password" />
          </div>
          <div class="auth-error" id="password-error"></div>
          <button type="submit" class="btn-danger" style="width:100%">Change Password</button>
        </form>
      </details>
    </div>
  `;
  document.body.appendChild(modal);
  return modal;
}

// ── Init & Wire ────────────────────────────────────────────────

let authModal = null;
let userMenuEl = null;
let profileModal = null;

export function initAuthUI() {
  const user = initAuth();

  // Create auth modal
  authModal = createAuthModal();

  // Create user menu and insert into header
  userMenuEl = createUserMenu();
  const headerRight = document.querySelector('.header-right');
  if (headerRight) {
    headerRight.prepend(userMenuEl);
  }

  // Wire tab switching
  authModal.querySelectorAll('.auth-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      authModal.querySelectorAll('.auth-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const isLogin = tab.dataset.tab === 'login';
      authModal.querySelector('#login-form').style.display = isLogin ? '' : 'none';
      authModal.querySelector('#register-form').style.display = isLogin ? 'none' : '';
      authModal.querySelector('#login-error').textContent = '';
      authModal.querySelector('#register-error').textContent = '';
    });
  });

  // Wire login form
  authModal.querySelector('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = authModal.querySelector('#login-error');
    errEl.textContent = '';
    const username = authModal.querySelector('#login-username').value.trim();
    const password = authModal.querySelector('#login-password').value;

    try {
      const user = await loginUser(username, password);
      scopeUserStorage(user.id);
      hideAuthModal();
      showApp();
      showToast(`Welcome back, ${user.display_name || user.username}!`, 'success');
      updateUserUI(user);
      if (_onLoginSuccess) _onLoginSuccess(user);
    } catch (err) {
      errEl.textContent = err.message;
    }
  });

  // Wire register form
  authModal.querySelector('#register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = authModal.querySelector('#register-error');
    errEl.textContent = '';
    const username = authModal.querySelector('#reg-username').value.trim();
    const email = authModal.querySelector('#reg-email').value.trim();
    const displayName = authModal.querySelector('#reg-display').value.trim();
    const password = authModal.querySelector('#reg-password').value;
    const confirm = authModal.querySelector('#reg-confirm').value;

    if (password !== confirm) {
      errEl.textContent = 'Passwords do not match';
      return;
    }

    try {
      const user = await registerUser(username, email, password, displayName);
      scopeUserStorage(user.id);
      hideAuthModal();
      showApp();
      showToast(`Account created! Welcome, ${user.display_name || user.username}!`, 'success');
      updateUserUI(user);
      if (_onLoginSuccess) _onLoginSuccess(user);
    } catch (err) {
      errEl.textContent = err.message;
    }
  });

  // Wire user menu toggle
  const menuBtn = userMenuEl.querySelector('#user-menu-btn');
  const dropdown = userMenuEl.querySelector('#user-dropdown');
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.hidden = !dropdown.hidden;
  });
  document.addEventListener('click', () => { dropdown.hidden = true; });

  // Wire logout
  userMenuEl.querySelector('#btn-logout').addEventListener('click', async () => {
    await logoutUser();
    clearUserStorage();
    updateUserUI(null);
    hideApp();
    showToast('Signed out', 'success');
    showAuthModal();
  });

  // Wire profile button
  userMenuEl.querySelector('#btn-profile').addEventListener('click', () => {
    dropdown.hidden = true;
    showProfileModal();
  });

  // Wire "My Rooms" button — navigate to rooms tab
  userMenuEl.querySelector('#btn-my-rooms').addEventListener('click', () => {
    dropdown.hidden = true;
    navigateToView('rooms');
  });

  // ── Profile Modal ──────────────────────────────────────────────
  profileModal = createProfileModal();

  profileModal.querySelector('#profile-modal-close').addEventListener('click', hideProfileModal);
  profileModal.addEventListener('click', (e) => { if (e.target === profileModal) hideProfileModal(); });

  // Avatar upload
  const avatarUploadArea = profileModal.querySelector('#profile-avatar-upload');
  const avatarFileInput = profileModal.querySelector('#profile-avatar-file');
  const avatarHiddenUrl = profileModal.querySelector('#profile-avatar-url');

  avatarUploadArea.addEventListener('click', () => {
    avatarFileInput.click();
  });

  avatarFileInput.addEventListener('change', () => {
    const file = avatarFileInput.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      showToast('Please select an image file', 'error');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      showToast('Image must be under 2 MB', 'error');
      return;
    }
    // Resize and convert to base64
    resizeImageToBase64(file, 128).then((dataUrl) => {
      avatarHiddenUrl.value = dataUrl;
      const avatarEl = profileModal.querySelector('#profile-avatar-large');
      avatarEl.textContent = '';
      const img = document.createElement('img');
      img.src = dataUrl;
      img.alt = 'avatar';
      Object.assign(img.style, { width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' });
      avatarEl.appendChild(img);
      avatarUploadArea.classList.add('has-image');
    }).catch(() => {
      showToast('Failed to process image', 'error');
    });
    avatarFileInput.value = '';
  });

  // Profile form submit
  profileModal.querySelector('#profile-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = profileModal.querySelector('#profile-error');
    errEl.textContent = '';
    const displayName = profileModal.querySelector('#profile-display-name').value.trim();
    const avatarUrl = avatarHiddenUrl.value.trim();

    try {
      const fields = {};
      if (displayName) fields.display_name = displayName;
      if (avatarUrl) fields.avatar_url = avatarUrl;
      if (Object.keys(fields).length === 0) {
        errEl.textContent = 'No changes to save';
        return;
      }
      const user = await updateProfile(fields);
      updateUserUI(user);
      showToast('Profile updated!', 'success');
      hideProfileModal();
    } catch (err) {
      errEl.textContent = err.message;
    }
  });

  // Password change form
  profileModal.querySelector('#password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = profileModal.querySelector('#password-error');
    errEl.textContent = '';
    const current = profileModal.querySelector('#pw-current').value;
    const newPw = profileModal.querySelector('#pw-new').value;
    const confirm = profileModal.querySelector('#pw-confirm').value;

    if (newPw !== confirm) {
      errEl.textContent = 'Passwords do not match';
      return;
    }

    try {
      await changePassword(current, newPw);
      showToast('Password changed! Please sign in again.', 'success');
      hideProfileModal();
      // Force re-login since all sessions are revoked
      await logoutUser();
      clearUserStorage();
      updateUserUI(null);
      hideApp();
      showAuthModal();
    } catch (err) {
      errEl.textContent = err.message;
    }
  });

  // Wire auth change listener
  onAuthChange((user) => {
    if (user) {
      scopeUserStorage(user.id);
    } else {
      clearUserStorage();
    }
    updateUserUI(user);
  });

  // Initial state — gate the app behind auth
  if (user) {
    scopeUserStorage(user.id);
    updateUserUI(user);
    showApp();
  } else {
    updateUserUI(null);
    hideApp();
    showAuthModal();
  }

  return user;
}

/**
 * Check if an avatar URL is valid (not truncated).
 * A base64 data URL for JPEG should be at least ~1KB.
 */
function isValidAvatarUrl(url) {
  if (!url) return false;
  if (url.startsWith('data:')) return url.length > 1000;
  return url.startsWith('http://') || url.startsWith('https://');
}

function setAvatarImage(container, url, fallbackChar) {
  if (isValidAvatarUrl(url)) {
    container.textContent = '';
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    Object.assign(img.style, { width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' });
    img.onerror = () => {
      container.textContent = fallbackChar;
      container.classList.remove('has-avatar');
    };
    container.appendChild(img);
    container.classList.add('has-avatar');
  } else {
    container.textContent = fallbackChar;
    container.classList.remove('has-avatar');
  }
}

function updateUserUI(user) {
  const avatar = userMenuEl.querySelector('#user-avatar');
  const nameEl = userMenuEl.querySelector('#user-dropdown-name');
  const usernameEl = userMenuEl.querySelector('#user-dropdown-username');

  if (user) {
    const fallback = (user.display_name || user.username || '?')[0].toUpperCase();
    if (user.avatar_url) {
      setAvatarImage(avatar, user.avatar_url, fallback);
    } else {
      avatar.textContent = fallback;
      avatar.classList.remove('has-avatar');
    }
    avatar.classList.add('authenticated');
    nameEl.textContent = user.display_name || user.username;
    usernameEl.textContent = `@${user.username}`;
  } else {
    avatar.innerHTML = '';
    avatar.textContent = '?';
    avatar.classList.remove('authenticated', 'has-avatar');
    nameEl.textContent = 'Guest';
    usernameEl.textContent = '@guest';
  }
}

export function showAuthModal() {
  if (authModal) {
    authModal.style.display = 'flex';
    authModal.querySelector('#login-username')?.focus();
  }
}

export function hideAuthModal() {
  if (authModal) {
    authModal.style.display = 'none';
    // Clear forms
    authModal.querySelectorAll('input').forEach((i) => { i.value = ''; });
    authModal.querySelectorAll('.auth-error').forEach((e) => { e.textContent = ''; });
  }
}

/** Hide the main app — show only the login screen */
function hideApp() {
  const app = document.getElementById('app');
  if (app) app.classList.add('auth-gated');
}

/** Show the main app after successful auth */
function showApp() {
  const app = document.getElementById('app');
  if (app) app.classList.remove('auth-gated');
}

// ── Profile Modal ──────────────────────────────────────────────

function showProfileModal() {
  if (!profileModal) return;
  const user = getCurrentUser();
  if (!user) return;

  // Populate fields
  const avatarEl = profileModal.querySelector('#profile-avatar-large');
  const uploadArea = profileModal.querySelector('#profile-avatar-upload');
  const fallback = (user.display_name || user.username || '?')[0].toUpperCase();
  if (isValidAvatarUrl(user.avatar_url)) {
    setAvatarImage(avatarEl, user.avatar_url, fallback);
    uploadArea.classList.add('has-image');
  } else {
    avatarEl.textContent = fallback;
    uploadArea.classList.remove('has-image');
  }
  profileModal.querySelector('#profile-username-display').textContent = `@${user.username}`;
  profileModal.querySelector('#profile-display-name').value = user.display_name || '';
  profileModal.querySelector('#profile-avatar-url').value = user.avatar_url || '';
  profileModal.querySelector('#profile-error').textContent = '';
  profileModal.querySelector('#password-error').textContent = '';

  profileModal.style.display = 'flex';
}

function hideProfileModal() {
  if (profileModal) {
    profileModal.style.display = 'none';
    profileModal.querySelectorAll('input[type=password]').forEach((i) => { i.value = ''; });
  }
}

/** Navigate to a specific view tab */
export function navigateToView(viewName) {
  const tabs = document.querySelectorAll('.nav-tab');
  const panels = document.querySelectorAll('.view-panel');

  tabs.forEach((t) => t.classList.remove('active'));
  panels.forEach((p) => { p.hidden = true; });

  const targetTab = document.querySelector(`.nav-tab[data-view="${viewName}"]`);
  if (targetTab) targetTab.classList.add('active');

  const targetPanel = document.getElementById(`view-${viewName}`);
  if (targetPanel) targetPanel.hidden = false;
}
