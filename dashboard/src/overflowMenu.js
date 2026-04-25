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

  // Position relative to trigger
  trigger.style.position = 'relative';
  trigger.parentElement.style.position = 'relative';
  trigger.parentElement.appendChild(menu);

  // Ensure menu is visible within viewport
  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      menu.style.right = '0';
      menu.style.left = 'auto';
    }
    if (rect.bottom > window.innerHeight) {
      menu.style.bottom = '100%';
      menu.style.top = 'auto';
      menu.style.marginBottom = '4px';
      menu.style.marginTop = '0';
    }
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
