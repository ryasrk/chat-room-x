/**
 * Overflow Menu — mobile-friendly dropdown for secondary room actions.
 * Replaces inline action buttons on small screens to save vertical space.
 */

let _activeMenu = null;

/**
 * Create and show an overflow menu anchored to a trigger button.
 * @param {HTMLElement} trigger - The button that opens the menu
 * @param {Array<{label: string, icon?: string, action: () => void, danger?: boolean, hidden?: boolean, divider?: boolean}>} items
 */
export function showOverflowMenu(trigger, items) {
  closeOverflowMenu();

  const menu = document.createElement('div');
  menu.className = 'overflow-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'More actions');

  const visibleItems = items.filter((item) => !item.hidden);

  visibleItems.forEach((item, idx) => {
    if (item.divider) {
      const divider = document.createElement('div');
      divider.className = 'overflow-menu-divider';
      divider.setAttribute('role', 'separator');
      menu.appendChild(divider);
    }

    const btn = document.createElement('button');
    btn.className = `overflow-menu-item${item.danger ? ' overflow-menu-item--danger' : ''}`;
    btn.setAttribute('role', 'menuitem');
    btn.type = 'button';
    btn.innerHTML = `${item.icon ? `<span class="overflow-menu-icon">${item.icon}</span>` : ''}
      <span class="overflow-menu-label">${item.label}</span>`;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeOverflowMenu();
      item.action();
    });
    menu.appendChild(btn);
  });

  // Append to body with fixed positioning to avoid overflow:hidden clipping
  document.body.appendChild(menu);

  // Position below the trigger button
  requestAnimationFrame(() => {
    const triggerRect = trigger.getBoundingClientRect();
    let top = triggerRect.bottom + 4;
    let left = triggerRect.right - menu.offsetWidth;

    // Keep within viewport horizontally
    if (left < 8) left = 8;
    if (left + menu.offsetWidth > window.innerWidth - 8) {
      left = window.innerWidth - menu.offsetWidth - 8;
    }

    // If menu would overflow bottom, show above trigger instead
    if (top + menu.offsetHeight > window.innerHeight - 8) {
      top = triggerRect.top - menu.offsetHeight - 4;
    }

    menu.style.position = 'fixed';
    menu.style.top = `${top}px`;
    menu.style.left = `${left}px`;
    menu.style.right = 'auto';
  });

  _activeMenu = menu;

  // Close on outside click
  const closeHandler = (e) => {
    if (!menu.contains(e.target) && e.target !== trigger) {
      closeOverflowMenu();
    }
  };
  // Close on Escape
  const escHandler = (e) => {
    if (e.key === 'Escape') {
      closeOverflowMenu();
      trigger.focus();
    }
  };

  setTimeout(() => {
    document.addEventListener('click', closeHandler, { once: true, capture: true });
    document.addEventListener('keydown', escHandler, { once: true });
  }, 0);

  menu._cleanup = () => {
    document.removeEventListener('click', closeHandler, { capture: true });
    document.removeEventListener('keydown', escHandler);
  };
}

export function closeOverflowMenu() {
  if (_activeMenu) {
    if (_activeMenu._cleanup) _activeMenu._cleanup();
    _activeMenu.remove();
    _activeMenu = null;
  }
}
