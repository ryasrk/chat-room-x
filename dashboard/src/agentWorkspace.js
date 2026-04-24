/**
 * agentWorkspace.js
 * Shared rendering and view helpers for the AI Agent room sidebar and workspace page.
 */

import {
  getAgentRoomFiles,
  getAgentRoomFile,
  getAgentRoomFileReview,
  downloadAgentRoomFile,
  downloadAgentRoomWorkspace,
  runAgentRoomPython,
  updateAgentRoomFileReview,
} from './authClient.js';
import { rs, escapeHtml, getFileLanguage, renderCodeWithLineNumbers, sanitizeClassToken } from './roomsUtils.js';
import { normalizeWorkspaceEntriesResponse, normalizeWorkspaceFileContentResponse } from './agentWorkspaceData.js';
import {
  buildWorkspaceHtmlPreviewDocument,
  extractWorkspaceHtmlAssetRefs,
  isHtmlWorkspaceFile,
  isPythonWorkspaceFile,
  resolveWorkspaceAssetPath,
} from './agentWorkspacePreview.js';
import { showToast } from './utils.js';

const REVIEW_STATUS_LABELS = {
  draft: 'Draft',
  in_review: 'In review',
  changes_requested: 'Changes requested',
  approved: 'Approved',
  promoted: 'Promoted',
};

export function resetAgentRoomSidebar() {
  rs.agentRoomLogs = [];
  rs.agentRoomFileAuthors = new Map();
  rs.agentRoomSelectedFile = null;
  rs.agentRoomFileContent = '';
  rs.agentRoomFileReview = null;
  rs.agentRoomPreviewMode = 'code';
  rs.agentRoomExecutionResult = null;
  rs.agentRoomSelectedTab = 'chat';
  rs.agentRoomProgressTimeline = [];
  rs.agentRoomWorkspaceFiles = [];
  rs.sidebarCollapsed = false;
  renderConnectionState();
  renderAgentLogs();
  renderAgentFiles();
  renderAgentProgress();
}

export function renderConnectionState() {
  if (!rs.panel) return;
  const s = rs.agentRoomConnectionState;
  const dot = `<span class="status-ring status-${s}"></span>`;

  rs.panel.querySelectorAll('#agent-room-connection-state, #room-connection-state').forEach((stateEl) => {
    stateEl.hidden = rs.currentRoomMode !== 'agent';
    stateEl.className = `agent-room-connection connection-${sanitizeClassToken(s)}`;
    stateEl.innerHTML = `${dot}${escapeHtml(s)}`;
    if (s === 'offline' && rs.currentAgentRoomId) {
      stateEl.innerHTML += ' <span style="font-size:0.7em; margin-left:4px; opacity:0.7">(retrying...)</span>';
    }
  });
}

export function renderAgentProgress() {
  if (!rs.panel) return;
  const containers = rs.panel.querySelectorAll('#agent-room-progress-items, #room-agent-progress');
  if (!containers.length) return;

  const countBadge = rs.panel.querySelector('#room-artifacts-count');
  const sidebarBadge = rs.panel.querySelector('#sidebar-activity-count');
  const artifactCount = rs.agentRoomProgressTimeline.reduce((sum, item) => sum + (item.artifacts?.length || 0), 0);
  const activityCount = rs.agentRoomProgressTimeline.length;
  if (countBadge) {
    countBadge.textContent = String(artifactCount);
    countBadge.hidden = artifactCount === 0;
  }
  if (sidebarBadge) {
    sidebarBadge.textContent = String(activityCount);
    sidebarBadge.hidden = activityCount === 0;
  }

  const emptyHtml = '<div class="workspace-empty-state">No agent activity yet.</div>';
  const itemsHtml = rs.agentRoomProgressTimeline.length === 0
    ? emptyHtml
    : rs.agentRoomProgressTimeline.slice().reverse().map((item) => {
        const timeStr = formatTimestamp(item.timestamp);
        const tools = Array.isArray(item.tools) && item.tools.length > 0
          ? `<div class="progress-tools">${item.tools.map((tool) => `<div class="progress-tool-item">${escapeHtml(formatProgressTool(tool))}</div>`).join('')}</div>`
          : '';
        const artifacts = Array.isArray(item.artifacts) && item.artifacts.length > 0
          ? `<div class="progress-artifacts">${item.artifacts.map((artifact) => `
              <button type="button" class="progress-artifact" data-artifact-path="${escapeHtml(artifact.path)}" title="${escapeHtml(artifact.path)}">
                <span>📄</span>${escapeHtml(artifact.path.split('/').pop() || artifact.path)}
              </button>
            `).join('')}</div>`
          : '';
        return `
          <article class="agent-room-progress-entry">
            <div class="progress-header">
              <span class="progress-agent">@${escapeHtml(item.agent_name || 'agent')}</span>
              <span class="progress-count">${escapeHtml(timeStr || 'recent')}</span>
            </div>
            ${tools}
            ${artifacts}
          </article>
        `;
      }).join('');

  containers.forEach((container) => {
    container.innerHTML = itemsHtml;
  });
}

function formatProgressTool(tool) {
  if (typeof tool === 'string') {
    return tool;
  }

  if (!tool || typeof tool !== 'object') {
    return 'Unknown tool';
  }

  const toolName = String(tool.tool || tool.name || 'tool').trim();
  const toolPath = String(tool.path || '').trim();
  const toolStatus = String(tool.status || '').trim().toLowerCase();

  // Skill tool formatting
  if (toolName === 'search_skills') {
    return `🔍 search_skills • ${toolStatus || 'done'}`;
  }
  if (toolName === 'read_skill') {
    return `📖 read_skill • ${toolStatus || 'done'}`;
  }
  if (toolName === 'list_skill_files') {
    return `📂 list_skill_files • ${toolStatus || 'done'}`;
  }

  if (toolPath && toolStatus) {
    return `${toolName} • ${toolPath} • ${toolStatus}`;
  }
  if (toolPath) {
    return `${toolName} • ${toolPath}`;
  }
  if (toolStatus) {
    return `${toolName} • ${toolStatus}`;
  }
  return toolName;
}

export function renderAgentLogs() {
  if (!rs.panel) return;
  const containers = rs.panel.querySelectorAll('#agent-room-logs-content, #room-agent-logs');
  if (!containers.length) return;

  const html = rs.agentRoomLogs.length === 0
    ? '<div class="workspace-empty-state">No logs yet.</div>'
    : rs.agentRoomLogs.slice().reverse().map((log) => renderLogEntry(log)).join('');

  containers.forEach((el) => {
    el.innerHTML = html;
    el.scrollTop = 0;
  });
}

export async function refreshAgentFiles() {
  if (!rs.currentAgentRoomId) return;
  try {
    const data = await getAgentRoomFiles(rs.currentAgentRoomId);
    rs.agentRoomWorkspaceFiles = normalizeWorkspaceEntriesResponse(data);
    renderAgentFiles();
  } catch (err) {
    console.error('Failed to get workspace files:', err);
  }
}

// ── File Icons (SVG) ──────────────────────────────────────────
const svgIconFolder = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4.5V12a1 1 0 001 1h10a1 1 0 001-1V6a1 1 0 00-1-1H8L6.5 3.5H3A1 1 0 002 4.5z"/></svg>';
const svgIconFile = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2H4a1 1 0 00-1 1v10a1 1 0 001 1h8a1 1 0 001-1V6L9 2z"/><path d="M9 2v4h4"/></svg>';
const svgIconCode = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 4L2 8l3.5 4"/><path d="M10.5 4L14 8l-3.5 4"/></svg>';
const svgIconImage = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="12" height="12" rx="1"/><circle cx="5.5" cy="5.5" r="1"/><path d="M14 10l-3-3-7 7"/></svg>';
const svgIconMarkdown = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3" width="14" height="10" rx="1"/><path d="M4 10V6l2 2.5L8 6v4"/><path d="M11 8l1.5 2L14 8"/></svg>';
const svgIconData = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="8" cy="4" rx="5" ry="2"/><path d="M3 4v4c0 1.1 2.2 2 5 2s5-.9 5-2V4"/><path d="M3 8v4c0 1.1 2.2 2 5 2s5-.9 5-2V8"/></svg>';
const svgIconStyle = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L4 14"/><circle cx="4" cy="5" r="2"/><circle cx="12" cy="11" r="2"/></svg>';

const FILE_ICON_MAP = {
  js: svgIconCode, ts: svgIconCode, jsx: svgIconCode, tsx: svgIconCode,
  py: svgIconCode, go: svgIconCode, rs: svgIconCode, rb: svgIconCode,
  html: svgIconCode, vue: svgIconCode, svelte: svgIconCode,
  css: svgIconStyle, scss: svgIconStyle, less: svgIconStyle,
  md: svgIconMarkdown, mdx: svgIconMarkdown,
  json: svgIconData, yaml: svgIconData, yml: svgIconData, toml: svgIconData, xml: svgIconData, csv: svgIconData,
  png: svgIconImage, jpg: svgIconImage, jpeg: svgIconImage, gif: svgIconImage, svg: svgIconImage, webp: svgIconImage,
};

function getFileIcon(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  return FILE_ICON_MAP[ext] || svgIconFile;
}

export function renderAgentFiles() {
  if (!rs.panel) return;
  const files = normalizeWorkspaceEntriesResponse(rs.agentRoomWorkspaceFiles);
  const containers = rs.panel.querySelectorAll('#agent-room-file-list');
  if (!containers.length) return;

  function ensureDirectoryNode(root, parts) {
    let curr = root;
    for (const part of parts) {
      if (!part) continue;
      if (!curr[part] || curr[part] === null) {
        curr[part] = {};
      }
      curr = curr[part];
    }
    return curr;
  }

  function buildTree(entries) {
    const root = {};
    for (const entry of entries) {
      const path = typeof entry?.path === 'string' ? entry.path : '';
      if (!path || path.startsWith('agent/')) continue;

      const parts = path.split('/').filter(Boolean);
      if (!parts.length) continue;

      if (entry.type === 'directory') {
        ensureDirectoryNode(root, parts);
        continue;
      }

      const parent = ensureDirectoryNode(root, parts.slice(0, -1));
      parent[parts[parts.length - 1]] = null;
    }
    return root;
  }

  const tree = buildTree(files);

  function renderTree(node, pathPrefix = '', depth = 0) {
    if (!node) return '';
    let html = '';
    const keys = Object.keys(node).sort((a, b) => {
      const aIsDir = node[a] !== null;
      const bIsDir = node[b] !== null;
      if (aIsDir && !bIsDir) return -1;
      if (!aIsDir && bIsDir) return 1;
      return a.localeCompare(b);
    });

    for (const key of keys) {
      const isDir = node[key] !== null;
      const fullPath = pathPrefix ? `${pathPrefix}/${key}` : key;
      if (isDir) {
        html += `
          <div class="agent-file-item agent-file-dir" style="--depth:${depth};">
            <span class="agent-file-icon">${svgIconFolder}</span>
            <span class="agent-file-name">${escapeHtml(key)}</span>
          </div>
        `;
        html += renderTree(node[key], fullPath, depth + 1);
      } else {
        const isSelected = rs.agentRoomSelectedFile === fullPath;
        const selClass = isSelected ? ' is-active' : '';
        const authorInfo = rs.agentRoomFileAuthors.get(fullPath);
        const authorHtml = authorInfo
          ? `<span class="agent-file-author" title="Created or modified by @${escapeHtml(authorInfo.agent_name)} via ${escapeHtml(authorInfo.tool || 'tool')}">@${escapeHtml(authorInfo.agent_name)}</span>`
          : '';

        html += `
          <button type="button" class="agent-file-item${selClass}" data-file-path="${fullPath}" data-file-kind="file" style="--depth:${depth};">
            <span class="agent-file-icon">${getFileIcon(key)}</span>
            <span class="agent-file-main">
              <span class="agent-file-name">${escapeHtml(key)}</span>
            </span>
            ${authorHtml}
          </button>
        `;
      }
    }
    return html;
  }

  // Get current search filter
  const searchInput = rs.panel.querySelector('#sidebar-file-search');
  const searchTerm = (searchInput?.value || '').toLowerCase().trim();

  // Filter files by search term
  const filteredFiles = searchTerm
    ? files.filter(f => {
        const path = typeof f?.path === 'string' ? f.path : '';
        return path.toLowerCase().includes(searchTerm);
      })
    : files;

  const html = files.length === 0
    ? '<div class="sidebar-empty-state">Workspace is empty.</div>'
    : filteredFiles.length === 0
      ? '<div class="sidebar-empty-state">No files match your search.</div>'
      : renderTree(buildTree(filteredFiles));

  containers.forEach((container) => {
    container.innerHTML = html;
  });

  // Update file count badge
  const fileCountBadge = rs.panel.querySelector('#sidebar-files-count');
  const fileCount = files.filter(f => f.type !== 'directory').length;
  if (fileCountBadge) {
    fileCountBadge.textContent = String(fileCount);
    fileCountBadge.hidden = fileCount === 0;
  }
}

export async function openAgentFile(path) {
  if (!rs.currentAgentRoomId) return;
  rs.agentRoomSelectedFile = path;
  rs.agentRoomPreviewMode = isHtmlWorkspaceFile(path) ? 'live' : 'code';
  rs.agentRoomExecutionResult = null;
  rs.agentRoomFileReview = null;
  renderAgentFiles();
  renderSelectedFileReview();

  const title = rs.panel?.querySelector('#agent-room-file-title');
  const meta = rs.panel?.querySelector('#agent-room-file-meta');
  const previews = rs.panel?.querySelectorAll('#agent-room-file-preview') || [];
  if (!previews.length) return;

  if (title) title.innerText = path;
  if (meta) {
    const authorInfo = rs.agentRoomFileAuthors.get(path);
    meta.innerText = authorInfo
      ? `Last touched by @${authorInfo.agent_name}${authorInfo.tool ? ` via ${authorInfo.tool}` : ''}`
      : 'Previewing workspace file';
  }
  previews.forEach((preview) => {
    preview.innerHTML = '<div class="file-preview-state">Loading preview...</div>';
  });

  try {
    const data = await getAgentRoomFile(rs.currentAgentRoomId, path);
    rs.agentRoomFileContent = normalizeWorkspaceFileContentResponse(data);
    await refreshSelectedAgentFileReview();
    await renderAgentFilePreview();
  } catch (err) {
    previews.forEach((preview) => {
      preview.innerHTML = `<div class="file-preview-state file-preview-state-error">Error: ${escapeHtml(err.message)}</div>`;
    });
  }
}

export function setAgentWorkspacePreviewMode(mode) {
  if (!rs.agentRoomSelectedFile) return;
  if (!['code', 'live', 'output'].includes(mode)) return;
  rs.agentRoomPreviewMode = mode;
  renderAgentFilePreview().catch((error) => {
    showToast(error instanceof Error ? error.message : 'Failed to switch preview mode.', 'error');
  });
}

/**
 * Toggle fullscreen mode for the workspace preview panel.
 * In fullscreen, the preview takes over the entire viewport with a floating toolbar.
 */
export function togglePreviewFullscreen() {
  const workspaceMain = rs.panel?.querySelector('.workspace-main');
  if (!workspaceMain) return;

  const isFullscreen = workspaceMain.classList.toggle('is-fullscreen');
  const fullscreenBtn = rs.panel?.querySelector('#agent-room-fullscreen-btn');
  if (fullscreenBtn) {
    fullscreenBtn.textContent = isFullscreen ? '⛶ Exit Fullscreen' : '⛶ Fullscreen';
  }

  // Handle Escape key to exit fullscreen
  if (isFullscreen) {
    const handleEscape = (e) => {
      if (e.key === 'Escape') {
        workspaceMain.classList.remove('is-fullscreen');
        if (fullscreenBtn) fullscreenBtn.textContent = '⛶ Fullscreen';
        document.removeEventListener('keydown', handleEscape);
        syncWorkspacePreviewActions();
      }
    };
    document.addEventListener('keydown', handleEscape);
  }
}

export async function runSelectedAgentPythonFile() {
  if (!rs.currentAgentRoomId || !isPythonWorkspaceFile(rs.agentRoomSelectedFile)) return;

  const previews = rs.panel?.querySelectorAll('#agent-room-file-preview') || [];
  previews.forEach((preview) => {
    preview.innerHTML = '<div class="file-preview-state">Running Python...</div>';
  });

  try {
    const data = await runAgentRoomPython(rs.currentAgentRoomId, rs.agentRoomSelectedFile, []);
    rs.agentRoomExecutionResult = data.result || null;
    rs.agentRoomPreviewMode = 'output';
    await renderAgentFilePreview();
  } catch (error) {
    previews.forEach((preview) => {
      preview.innerHTML = `<div class="file-preview-state file-preview-state-error">Error: ${escapeHtml(error.message)}</div>`;
    });
  }
}

export async function downloadSelectedAgentFile() {
  if (!rs.currentAgentRoomId || !rs.agentRoomSelectedFile) return;

  try {
    const { blob, fileName } = await downloadAgentRoomFile(rs.currentAgentRoomId, rs.agentRoomSelectedFile);
    const url = window.URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.URL.revokeObjectURL(url);
  } catch (error) {
    showToast(error instanceof Error ? error.message : 'Failed to download file.', 'error');
  }
}

export async function setSelectedAgentFileReviewStatus(status) {
  if (!rs.currentAgentRoomId || !rs.agentRoomSelectedFile) return;

  try {
    const data = await updateAgentRoomFileReview(rs.currentAgentRoomId, rs.agentRoomSelectedFile, status, '');
    rs.agentRoomFileReview = data.review || null;
    renderSelectedFileReview();
    showToast(`File marked as ${REVIEW_STATUS_LABELS[status] || status}.`, 'success');
  } catch (error) {
    showToast(error instanceof Error ? error.message : 'Failed to update file review state.', 'error');
  }
}

async function renderAgentFilePreview() {
  const previews = rs.panel?.querySelectorAll('#agent-room-file-preview') || [];
  if (!previews.length) return;

  syncWorkspacePreviewActions();

  const path = rs.agentRoomSelectedFile;
  const content = rs.agentRoomFileContent || '';
  if (!path) {
    previews.forEach((preview) => {
      preview.innerHTML = '<div class="workspace-empty-state">Choose an artifact or workspace file to preview it here.</div>';
    });
    return;
  }

  if (rs.agentRoomPreviewMode === 'output' && rs.agentRoomExecutionResult) {
    const result = rs.agentRoomExecutionResult;
    const stdoutHtml = result.stdout ? escapeHtml(result.stdout) : '<span class="workspace-run-empty">No stdout</span>';
    const stderrHtml = result.stderr ? escapeHtml(result.stderr) : '<span class="workspace-run-empty">No stderr</span>';
    const html = `
      <div class="workspace-run-output">
        <div class="workspace-run-summary">
          <span class="workspace-run-badge ${result.exitCode === 0 ? 'is-success' : 'is-error'}">Exit ${escapeHtml(String(result.exitCode))}</span>
          <span class="workspace-run-command">${escapeHtml(result.command || 'python')}</span>
          <span class="workspace-run-venv">${escapeHtml(result.venvPath || '.venv')}</span>
        </div>
        <div class="workspace-run-panels">
          <section class="workspace-run-panel">
            <h5>stdout</h5>
            <pre>${stdoutHtml}</pre>
          </section>
          <section class="workspace-run-panel ${result.stderr ? 'has-error' : ''}">
            <h5>stderr</h5>
            <pre>${stderrHtml}</pre>
          </section>
        </div>
      </div>
    `;
    previews.forEach((preview) => {
      preview.innerHTML = html;
    });
    return;
  }

  if (rs.agentRoomPreviewMode === 'live' && isHtmlWorkspaceFile(path) && content) {
    const previewDoc = await buildLivePreviewDocument(path, content);
    previews.forEach((preview) => {
      preview.innerHTML = '<div class="workspace-live-shell"><iframe class="workspace-live-preview" sandbox="allow-scripts"></iframe></div>';
      const iframe = preview.querySelector('.workspace-live-preview');
      if (iframe) {
        iframe.srcdoc = previewDoc;
      }
    });
    return;
  }

  const language = getFileLanguage(path);
  const html = content
    ? (language === 'markdown'
        ? `<div class="file-preview-content"><pre class="file-preview-markdown"><code>${escapeHtml(content)}</code></pre></div>`
        : `<div class="file-preview-content"><pre class="file-preview-code"><code class="language-${escapeHtml(language)}">${renderCodeWithLineNumbers(content)}</code></pre></div>`)
    : '<div class="workspace-empty-state">This file is empty.</div>';

  previews.forEach((preview) => {
    preview.innerHTML = html;
  });
}

async function buildLivePreviewDocument(path, htmlContent) {
  const refs = extractWorkspaceHtmlAssetRefs(htmlContent);
  const styles = new Map();
  const scripts = new Map();

  await Promise.all(refs.styles.map(async (ref) => {
    const resolved = resolveWorkspaceAssetPath(path, ref);
    if (!resolved || !rs.currentAgentRoomId) return;
    try {
      const data = await getAgentRoomFile(rs.currentAgentRoomId, resolved);
      styles.set(ref, normalizeWorkspaceFileContentResponse(data));
    } catch {
      // Leave unresolved assets untouched in preview mode.
    }
  }));

  await Promise.all(refs.scripts.map(async (ref) => {
    const resolved = resolveWorkspaceAssetPath(path, ref);
    if (!resolved || !rs.currentAgentRoomId) return;
    try {
      const data = await getAgentRoomFile(rs.currentAgentRoomId, resolved);
      scripts.set(ref, normalizeWorkspaceFileContentResponse(data));
    } catch {
      // Leave unresolved assets untouched in preview mode.
    }
  }));

  return buildWorkspaceHtmlPreviewDocument({ htmlContent, styles, scripts });
}

function syncWorkspacePreviewActions() {
  const codeBtn = rs.panel?.querySelector('#agent-room-view-code-btn');
  const downloadBtn = rs.panel?.querySelector('#agent-room-download-file-btn');
  const liveBtn = rs.panel?.querySelector('#agent-room-view-live-btn');
  const fullscreenBtn = rs.panel?.querySelector('#agent-room-fullscreen-btn');
  const runBtn = rs.panel?.querySelector('#agent-room-run-python-btn');
  const requestReviewBtn = rs.panel?.querySelector('#agent-room-request-review-btn');
  const requestChangesBtn = rs.panel?.querySelector('#agent-room-request-changes-btn');
  const approveBtn = rs.panel?.querySelector('#agent-room-approve-file-btn');
  const promoteBtn = rs.panel?.querySelector('#agent-room-promote-file-btn');
  const path = rs.agentRoomSelectedFile;
  const reviewStatus = rs.agentRoomFileReview?.status || 'draft';

  if (downloadBtn) {
    downloadBtn.hidden = !path;
  }

  if (codeBtn) {
    codeBtn.hidden = !path;
    codeBtn.classList.toggle('is-active', rs.agentRoomPreviewMode === 'code');
  }

  if (liveBtn) {
    liveBtn.hidden = !isHtmlWorkspaceFile(path);
    liveBtn.classList.toggle('is-active', rs.agentRoomPreviewMode === 'live');
  }

  // Show fullscreen button when previewing any file
  if (fullscreenBtn) {
    fullscreenBtn.hidden = !path;
    const isFullscreen = rs.panel?.querySelector('.workspace-main')?.classList.contains('is-fullscreen');
    fullscreenBtn.textContent = isFullscreen ? '⛶ Exit Fullscreen' : '⛶ Fullscreen';
  }

  if (runBtn) {
    runBtn.hidden = !isPythonWorkspaceFile(path);
    runBtn.classList.toggle('is-active', rs.agentRoomPreviewMode === 'output');
  }

  if (requestReviewBtn) {
    requestReviewBtn.hidden = !path || reviewStatus === 'in_review' || reviewStatus === 'promoted';
  }

  if (requestChangesBtn) {
    requestChangesBtn.hidden = !path || reviewStatus === 'changes_requested' || reviewStatus === 'promoted';
  }

  if (approveBtn) {
    approveBtn.hidden = !path || reviewStatus === 'approved' || reviewStatus === 'promoted';
  }

  if (promoteBtn) {
    promoteBtn.hidden = !path || reviewStatus !== 'approved';
  }

  renderSelectedFileReview();
}

async function refreshSelectedAgentFileReview() {
  if (!rs.currentAgentRoomId || !rs.agentRoomSelectedFile) {
    rs.agentRoomFileReview = null;
    renderSelectedFileReview();
    return;
  }

  try {
    const data = await getAgentRoomFileReview(rs.currentAgentRoomId, rs.agentRoomSelectedFile);
    rs.agentRoomFileReview = data.review || null;
  } catch {
    rs.agentRoomFileReview = null;
  }
  renderSelectedFileReview();
}

function renderSelectedFileReview() {
  const badge = rs.panel?.querySelector('#agent-room-file-review-badge');
  const meta = rs.panel?.querySelector('#agent-room-file-review-meta');
  const review = rs.agentRoomFileReview;
  const path = rs.agentRoomSelectedFile;

  if (!badge || !meta) return;

  if (!path) {
    badge.hidden = true;
    meta.hidden = true;
    badge.textContent = '';
    meta.textContent = '';
    return;
  }

  const status = review?.status || 'draft';
  badge.hidden = false;
  badge.className = `workspace-review-badge status-${sanitizeClassToken(status, 'draft')}`;
  badge.textContent = REVIEW_STATUS_LABELS[status] || status;

  const updatedBy = review?.updated_by ? ` by ${review.updated_by}` : '';
  const updatedAt = review?.updated_at ? ` on ${new Date(Number(review.updated_at) * 1000).toLocaleString()}` : '';
  meta.hidden = false;
  meta.textContent = `Gate${updatedBy}${updatedAt}`;
}

export async function handleDownloadWorkspace() {
  if (!rs.currentAgentRoomId) return;
  try {
    showToast('Preparing workspace ZIP...', 'info');
    const { blob, fileName } = await downloadAgentRoomWorkspace(rs.currentAgentRoomId);
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName || `workspace-${rs.currentAgentRoomId.substring(0, 8)}.zip`;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

export function handleArtifactsClick() {
  rs.agentRoomSelectedTab = 'workspace';
  showWorkspacePanel();
  refreshAgentFiles();
}

export function showAgentSidebar(show) {
  if (!rs.panel) return;
  const sidebar = rs.panel.querySelector('#room-agent-sidebar');
  const toggle = rs.panel.querySelector('#room-sidebar-toggle');
  const roomBody = rs.panel.querySelector('#room-chat-body');
  const artifactsBtn = rs.panel.querySelector('#room-artifacts-btn');
  const downloadBtn = rs.panel.querySelector('#room-download-btn');

  if (!sidebar || !toggle || !roomBody || !artifactsBtn || !downloadBtn) return;

  const visible = Boolean(show && rs.currentRoomMode === 'agent');
  sidebar.hidden = !visible;
  toggle.hidden = !visible;
  artifactsBtn.hidden = !visible;
  downloadBtn.hidden = !visible;
  roomBody.classList.toggle('has-sidebar', visible);

  if (!visible) {
    rs.sidebarCollapsed = false;
    sidebar.classList.remove('collapsed');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.querySelector('.sidebar-toggle-icon').textContent = '◀';
    return;
  }

  sidebar.classList.toggle('collapsed', rs.sidebarCollapsed);
  toggle.setAttribute('aria-expanded', String(!rs.sidebarCollapsed));
  toggle.querySelector('.sidebar-toggle-icon').textContent = rs.sidebarCollapsed ? '▶' : '◀';
}

export function toggleAgentSidebar() {
  rs.sidebarCollapsed = !rs.sidebarCollapsed;
  showAgentSidebar(true);
}

function showWorkspacePanel() {
  if (!rs.panel) return;
  const workspaceView = rs.panel.querySelector('#room-workspace');
  const roomChat = rs.panel.querySelector('#room-chat');
  if (roomChat) roomChat.hidden = true;
  if (workspaceView) workspaceView.hidden = false;
}

function formatTimestamp(timestamp) {
  if (!timestamp) return '';
  const numeric = Number(timestamp);
  if (!Number.isFinite(numeric)) return String(timestamp);
  const ms = numeric < 1e11 ? numeric * 1000 : numeric;
  return new Date(ms).toLocaleString();
}

function renderLogEntry(log) {
  if (typeof log === 'string') {
    return `<div class="agent-room-log"><div class="agent-room-log-body">${escapeHtml(log)}</div></div>`;
  }

  const level = sanitizeClassToken(log?.level || 'info');
  const agentName = log?.agent_name ? `@${escapeHtml(log.agent_name)}` : 'system';
  const body = escapeHtml(log?.message || log?.content || '');
  const logMeta = log?.meta || {};
  const badges = [];

  // Tool badge
  const toolName = logMeta.tool || log?.tool || '';
  if (toolName) badges.push(`<span class="log-tool-badge">${escapeHtml(toolName)}</span>`);

  // File path badge
  const filePath = logMeta.path || log?.path || '';
  if (filePath) badges.push(`<span class="log-path-badge">📄 ${escapeHtml(filePath)}</span>`);

  // Skill-specific badges
  if (toolName === 'search_skills' && logMeta.query) {
    badges.push(`<span class="log-skill-badge">🔍 "${escapeHtml(logMeta.query)}"</span>`);
    if (logMeta.result_count != null) {
      badges.push(`<span class="log-skill-count">${logMeta.result_count} found</span>`);
    }
  }
  if (toolName === 'read_skill' && logMeta.skill_id) {
    badges.push(`<span class="log-skill-badge">📖 ${escapeHtml(logMeta.skill_name || logMeta.skill_id)}</span>`);
    if (logMeta.file_path && logMeta.file_path !== 'SKILL.md') {
      badges.push(`<span class="log-path-badge">📄 ${escapeHtml(logMeta.file_path)}</span>`);
    }
  }
  if (toolName === 'list_skill_files' && logMeta.skill_id) {
    badges.push(`<span class="log-skill-badge">📂 ${escapeHtml(logMeta.skill_id)}</span>`);
    if (logMeta.result_count != null) {
      badges.push(`<span class="log-skill-count">${logMeta.result_count} entries</span>`);
    }
  }

  return `
    <article class="agent-room-log log-${level}${toolName.startsWith('search_skill') || toolName === 'read_skill' || toolName === 'list_skill_files' ? ' log-skill' : ''}">
      <div class="agent-room-log-header">
        <span class="agent-room-log-agent">${agentName}</span>
        <div class="agent-room-log-badges">
          <span class="agent-room-log-level">${escapeHtml(level)}</span>
          ${badges.join('')}
        </div>
      </div>
      <div class="agent-room-log-body">${body}</div>
    </article>
  `;
}
