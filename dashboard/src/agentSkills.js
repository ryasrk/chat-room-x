/**
 * Agent Skills UI — manage skills assigned to an agent room.
 * Renders a compact collapsible section inside the workspace sidebar.
 */

import {
  listSkillsCatalog,
  listRoomSkills,
  addRoomSkill,
  removeRoomSkill,
} from './authClient.js';
import { rs } from './roomsUtils.js';
import { showToast } from './utils.js';
import { showConfirm } from './confirmModal.js';

let _container = null;
let _assignedSkills = [];
let _catalogSkills = [];

/**
 * Render the skills section inside the given container.
 */
export function renderSkillSection(container) {
  _container = container;
  container.innerHTML = `
    <summary class="sidebar-accordion-header">
      <span class="sidebar-accordion-icon">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2L2 6l6 4 6-4-6-4z"/><path d="M2 10l6 4 6-4"/></svg>
      </span>
      <span class="sidebar-accordion-title">Skills</span>
      <span class="skill-count sidebar-accordion-badge" hidden>0</span>
      <span class="sidebar-accordion-chevron">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5L6 7.5L9 4.5"/></svg>
      </span>
    </summary>
    <div class="sidebar-accordion-body">
      <div class="skill-add-row">
        <select class="skill-select"><option value="">+ Add skill…</option></select>
      </div>
      <div class="skill-list"></div>
    </div>
  `;

  const select = container.querySelector('.skill-select');
  select.addEventListener('change', async () => {
    const skillId = select.value;
    if (!skillId) return;
    const roomId = rs.currentAgentRoomId;
    if (!roomId) return;
    select.disabled = true;
    try {
      await addRoomSkill(roomId, skillId);
      showToast('Skill added');
      await loadSkills(container);
    } catch (err) {
      showToast('Failed to add skill', 'error');
    } finally {
      select.value = '';
      select.disabled = false;
    }
  });
}

/**
 * Load skills for the current room and update the UI.
 */
export async function loadSkills(container) {
  const target = container || _container;
  if (!target) return;
  _container = target;

  const roomId = rs.currentAgentRoomId;
  if (!roomId) return;

  // Auto-render if not yet initialized
  if (!target.querySelector('.sidebar-accordion-body')) {
    renderSkillSection(target);
  }

  const listEl = target.querySelector('.skill-list');
  const countEl = target.querySelector('.skill-count');
  const selectEl = target.querySelector('.skill-select');
  if (!listEl) return;

  listEl.innerHTML = '<div class="skill-loading">Loading…</div>';

  try {
    const [assignedRes, catalogRes] = await Promise.all([
      listRoomSkills(roomId),
      listSkillsCatalog(),
    ]);

    _assignedSkills = assignedRes?.skills || [];
    _catalogSkills = catalogRes?.skills || [];

    if (countEl) {
      countEl.textContent = _assignedSkills.length;
      countEl.hidden = _assignedSkills.length === 0;
    }

    // Populate select with unassigned skills
    const assignedIds = new Set(_assignedSkills.map((s) => s.skill_id));
    const available = _catalogSkills.filter((s) => !assignedIds.has(s.id));

    selectEl.innerHTML = '<option value="">+ Add skill…</option>';
    for (const skill of available) {
      const opt = document.createElement('option');
      opt.value = skill.id;
      opt.textContent = skill.name;
      selectEl.appendChild(opt);
    }

    if (_assignedSkills.length === 0) {
      listEl.innerHTML = '<div class="skill-empty">No skills assigned</div>';
      return;
    }

    listEl.innerHTML = '';
    for (const skill of _assignedSkills) {
      const item = document.createElement('div');
      item.className = 'skill-item';
      item.innerHTML = `
        <div class="skill-item-top">
          <span class="skill-item-name">🧠 ${escapeHtml(skill.name || skill.skill_id)}</span>
          <button class="skill-remove-btn" title="Remove skill" data-id="${escapeHtml(skill.skill_id)}">×</button>
        </div>
        <div class="skill-item-desc">${escapeHtml(skill.description || '')}</div>
      `;
      listEl.appendChild(item);
    }

    // Remove buttons
    listEl.querySelectorAll('.skill-remove-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const skillId = btn.dataset.id;
        const confirmed = await showConfirm({
          title: 'Remove Skill',
          message: `Remove skill "${skillId}" from this room?`,
          confirmText: 'Remove',
          variant: 'danger',
        });
        if (!confirmed) return;
        btn.disabled = true;
        try {
          await removeRoomSkill(roomId, skillId);
          showToast('Skill removed');
          await loadSkills(target);
        } catch {
          showToast('Failed to remove skill', 'error');
        }
      });
    });
  } catch (err) {
    listEl.innerHTML = '<div class="skill-empty">Failed to load skills</div>';
  }
}

/**
 * Clear skills state (when leaving a room).
 */
export function clearSkills() {
  _assignedSkills = [];
  _catalogSkills = [];
  if (_container) {
    const listEl = _container.querySelector('.skill-list');
    const countEl = _container.querySelector('.skill-count');
    if (listEl) listEl.innerHTML = '';
    if (countEl) countEl.textContent = '0';
  }
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function truncate(str, max) {
  return str.length > max ? str.slice(0, max) + '…' : str;
}
