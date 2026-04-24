/**
 * Modal Manager — open/close modals with focus trapping and backdrop clicks.
 */

import { isMobileViewport } from './utils.js';

const $ = (sel) => document.querySelector(sel);

const appEl = $('#app');
const sidebar = $('#sidebar');
const sidebarBackdrop = $('#sidebar-backdrop');
const sidebarToggle = $('#sidebar-toggle');
const plusBtn = $('#plus-btn');
const plusMenu = $('#plus-menu');

const MODAL_FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  'summary',
].join(', ');

export let activeModal = null;
let activeModalTrigger = null;

export function getModalFocusableElements(modal) {
  return Array.from(modal.querySelectorAll(MODAL_FOCUSABLE_SELECTOR))
    .filter((el) => el.getClientRects().length > 0);
}

export function openModal(modal, trigger, onOpen) {
  if (!modal) return;
  if (activeModal && activeModal !== modal) {
    closeModal(activeModal, { restoreFocus: false });
  }
  activeModal = modal;
  activeModalTrigger = trigger instanceof HTMLElement ? trigger : document.activeElement;
  modal.hidden = false;
  onOpen?.();
  window.requestAnimationFrame(() => {
    const panel = modal.querySelector('.modal');
    const focusable = getModalFocusableElements(modal);
    (focusable[0] || panel)?.focus();
  });
}

export function closeModal(modal, { restoreFocus = true } = {}) {
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  if (activeModal === modal) {
    const trigger = activeModalTrigger;
    activeModal = null;
    activeModalTrigger = null;
    if (restoreFocus && trigger instanceof HTMLElement) {
      trigger.focus();
    }
  }
}

export function syncPlusMenuState() {
  if (plusBtn && plusMenu) {
    plusBtn.setAttribute('aria-expanded', plusMenu.hidden ? 'false' : 'true');
  }
}

export function closePlusMenu() {
  if (plusMenu) plusMenu.hidden = true;
  syncPlusMenuState();
}

export function syncSidebarBackdrop() {
  if (!sidebar || !sidebarBackdrop || !sidebarToggle) return;
  const sidebarOpen = !sidebar.classList.contains('collapsed');
  const showBackdrop = isMobileViewport() && sidebarOpen;
  sidebarBackdrop.hidden = !showBackdrop;
  if (appEl) appEl.classList.toggle('sidebar-open', showBackdrop);
  sidebarToggle.setAttribute('aria-expanded', sidebarOpen ? 'true' : 'false');
  sidebarToggle.setAttribute('aria-label', sidebarOpen ? 'Close sidebar' : 'Open sidebar');
}

export function closeSidebar() {
  if (!sidebar || !isMobileViewport()) return;
  sidebar.classList.add('collapsed');
  syncSidebarBackdrop();
}

/** Tab-trap handler for use inside a keydown event listener on document. */
export function handleModalTabTrap(event) {
  if (event.key !== 'Tab' || !activeModal) return;
  const focusable = getModalFocusableElements(activeModal);
  const panel = activeModal.querySelector('.modal');
  if (focusable.length === 0) {
    event.preventDefault();
    panel?.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (!activeModal.contains(active)) {
    event.preventDefault();
    first.focus();
    return;
  }
  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}
