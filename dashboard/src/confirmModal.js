/**
 * Reusable confirmation modal — replaces native confirm() and alert() dialogs.
 * Returns a Promise<boolean> for confirm, or void for alert.
 */

let _overlay = null;

function ensureOverlay() {
  if (_overlay) return _overlay;

  _overlay = document.createElement('div');
  _overlay.className = 'modal-overlay confirm-modal-overlay';
  _overlay.style.display = 'none';
  _overlay.innerHTML = `
    <div class="modal modal-sm confirm-modal">
      <div class="confirm-modal-icon" id="confirm-icon"></div>
      <h3 class="confirm-modal-title" id="confirm-title">Confirm</h3>
      <p class="confirm-modal-message" id="confirm-message"></p>
      <div class="modal-actions">
        <button class="btn-secondary" id="confirm-cancel">Cancel</button>
        <button class="btn-primary" id="confirm-ok">OK</button>
      </div>
    </div>
  `;
  document.body.appendChild(_overlay);
  return _overlay;
}

/**
 * Show a confirmation modal.
 * @param {Object} opts
 * @param {string} opts.title - Modal title
 * @param {string} opts.message - Modal message
 * @param {string} [opts.confirmText='Confirm'] - Confirm button text
 * @param {string} [opts.cancelText='Cancel'] - Cancel button text
 * @param {'danger'|'warning'|'info'} [opts.variant='info'] - Visual variant
 * @returns {Promise<boolean>}
 */
export function showConfirm({
  title = 'Confirm',
  message = 'Are you sure?',
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  variant = 'info',
} = {}) {
  const overlay = ensureOverlay();
  const titleEl = overlay.querySelector('#confirm-title');
  const msgEl = overlay.querySelector('#confirm-message');
  const iconEl = overlay.querySelector('#confirm-icon');
  const okBtn = overlay.querySelector('#confirm-ok');
  const cancelBtn = overlay.querySelector('#confirm-cancel');

  titleEl.textContent = title;
  msgEl.textContent = message;
  okBtn.textContent = confirmText;
  cancelBtn.textContent = cancelText;
  cancelBtn.style.display = '';

  // Variant styling
  okBtn.className = variant === 'danger' ? 'btn-danger' : 'btn-primary';
  iconEl.className = `confirm-modal-icon confirm-icon-${variant}`;

  // SVG icons per variant
  const icons = {
    danger: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
    warning: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    info: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  };
  iconEl.innerHTML = icons[variant] || icons.info;

  overlay.style.display = '';

  return new Promise((resolve) => {
    function cleanup() {
      overlay.style.display = 'none';
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
    }

    function onOk() { cleanup(); resolve(true); }
    function onCancel() { cleanup(); resolve(false); }
    function onBackdrop(e) { if (e.target === overlay) { cleanup(); resolve(false); } }
    function onKey(e) { if (e.key === 'Escape') { cleanup(); resolve(false); } }

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);

    // Focus the cancel button for safety (prevents accidental confirm)
    requestAnimationFrame(() => cancelBtn.focus());
  });
}

/**
 * Show an alert modal (single OK button, no cancel).
 * @param {Object} opts
 * @param {string} opts.title
 * @param {string} opts.message
 * @param {string} [opts.okText='OK']
 * @param {'danger'|'warning'|'info'} [opts.variant='info']
 * @returns {Promise<void>}
 */
export async function showAlert({
  title = 'Notice',
  message = '',
  okText = 'OK',
  variant = 'info',
} = {}) {
  const overlay = ensureOverlay();
  overlay.querySelector('#confirm-cancel').style.display = 'none';
  await showConfirm({ title, message, confirmText: okText, variant });
}
