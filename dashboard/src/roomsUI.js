/**
 * Rooms UI — Project room list, create/join modals, room chat view.
 */

import {
  listRooms, createRoom, joinRoom, getRoom, leaveRoomApi, deleteRoom,
  getProjectAgentRoomDetails, sendAgentRoomMessage, cancelAgentRoom, sendRoomMessage, getAccessToken,
} from './authClient.js';
import { isAuthenticated, getCurrentUser } from './authClient.js';
import { showToast, copyToClipboard } from './utils.js';
import { showConfirm } from './confirmModal.js';

import { rs, escapeHtml, sanitizeClassToken } from './roomsUtils.js';
import {
  handleAgentTaskFormSubmit,
  handleAgentTaskListChange,
  hydrateAgentRoomTasks,
  refreshAgentRoomTasks,
  renderAgentRoomTasks,
  resetAgentRoomTasks,
  syncAgentTaskAssigneeOptions,
} from './agentRoomTasks.js';
import { applyActiveRoomCard, refreshRoomsList } from './roomsList.js';
import { loadRoomMessages, renderRoomMessages, appendAgentRoomMessage } from './roomChat.js';
import { openAgentConfigModal, closeAgentConfigModal, handleAgentConfigSubmit, handleAgentConfigDelete, updateRoomProviderFields } from './agentConfigModal.js';
import {
  renderConnectionState, renderAgentProgress, renderAgentLogs, renderAgentFiles,
  refreshAgentFiles, openAgentFile, handleDownloadWorkspace, resetAgentRoomSidebar,
  downloadSelectedAgentFile,
  runSelectedAgentPythonFile, setAgentWorkspacePreviewMode, setSelectedAgentFileReviewStatus,
  showAgentSidebar, toggleAgentSidebar, handleArtifactsClick, togglePreviewFullscreen
} from './agentWorkspace.js';
import { connectAgentRoomSocket, closeAgentSocket } from './agentSocket.js';
import { loadAgentMemories, renderAgentMemories, saveAgentMemory, clearAgentMemoryAction } from './agentMemoryPanel.js';
import { renderOrchestrationConfig, handleOrchestrationModeChange, handleAutonomyLevelChange } from './agentOrchestrationConfig.js';
import { loadTokenUsage } from './agentTokenUsage.js';
import { resetHandoffTimeline, renderHandoffTimeline, extractHandoffsFromMessage } from './agentHandoffViz.js';
import { clearAllTypingIndicators } from './agentTypingIndicator.js';
import { loadSnapshots, clearSnapshots, renderSnapshotSection } from './agentSnapshots.js';
import { loadSkills, clearSkills, renderSkillSection } from './agentSkills.js';
import { showOverflowMenu, closeOverflowMenu } from './overflowMenu.js';
import { persistAgentRoomState, clearAgentRoomState } from './sessionRecovery.js';

// ── Rooms Panel (sidebar-like list) ────────────────────────────

export function createRoomsView() {
  const panel = document.createElement('div');
  panel.id = 'view-rooms';
  panel.className = 'view-panel';
  panel.hidden = true;
  panel.innerHTML = `
    <div class="rooms-page">
      <div class="rooms-header">
        <h2>Project Rooms</h2>
        <div class="rooms-actions">
          <button id="create-room-btn" class="btn-primary btn-sm">+ Create Room</button>
          <button id="join-room-btn" class="btn-secondary btn-sm">Join Room</button>
        </div>
      </div>
      <aside class="rooms-sidebar-panel">
        <div class="rooms-sidebar-header">
          <h3>Your Rooms</h3>
          <p>Open a room to collaborate. AI Agent rooms open like normal rooms, with bot members that respond to mentions.</p>
        </div>
        <div class="rooms-list" id="rooms-list">
          <div class="rooms-empty">No rooms yet. Create one or join with an invite code.</div>
        </div>
      </aside>
    </div>

    <!-- Room Chat View (shown when a room is selected) -->
    <div class="room-chat" id="room-chat" hidden role="region" aria-label="Room chat">
      <div class="room-chat-header" role="toolbar" aria-label="Room actions">
        <button id="room-back-btn" class="btn-icon" title="Back to rooms" aria-label="Back to rooms list">
          <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12.5 4.5L7 10l5.5 5.5"/>
            <path d="M7.5 10H16"/>
          </svg>
        </button>
        <div class="room-chat-info">
          <div class="room-chat-info-top">
            <span class="room-chat-kind" id="room-chat-kind">Room</span>
          </div>
          <h3 id="room-chat-name">Room</h3>
          <span id="room-chat-members" class="room-member-count">0 members</span>
        </div>
        <div class="room-chat-actions">
          <span id="room-connection-state" class="agent-room-connection connection-idle" hidden role="status" aria-live="polite" aria-label="Connection status">Idle</span>
          <button id="room-ai-btn" class="btn-sm btn-secondary room-action-primary" title="Open AI agents" hidden aria-label="Open AI agents">AI</button>
          <button id="room-artifacts-btn" class="btn-sm btn-secondary room-action-primary room-artifacts-btn" title="View generated files & artifacts" hidden aria-label="View artifacts">📎 Artifacts <span id="room-artifacts-count" class="artifacts-badge" hidden aria-label="Artifact count">0</span></button>
          <button id="room-download-btn" class="btn-sm btn-secondary room-action-secondary" title="Download workspace ZIP" hidden aria-label="Download workspace as ZIP">📥 ZIP</button>
          <button id="room-invite-btn" class="btn-sm btn-secondary room-action-secondary" title="Copy invite code">Invite</button>
          <button id="room-leave-btn" class="btn-sm btn-secondary room-action-secondary" title="Leave room">Leave</button>
          <button id="room-delete-btn" class="btn-sm btn-danger room-action-secondary" title="Delete room (owner only)" hidden>Delete</button>
          <button id="room-overflow-btn" class="btn-sm btn-secondary room-overflow-trigger" title="More actions" aria-label="More actions" aria-haspopup="menu">⋯</button>
        </div>
      </div>
      <div class="room-chat-note" id="room-chat-note" hidden></div>

      <div class="room-chat-body" id="room-chat-body">
        <div class="room-chat-main">
          <div class="room-thread-header" id="room-thread-header">
            <div class="room-thread-copy">
              <h4>Conversation</h4>
              <p id="room-thread-caption">Discuss work, delegate tasks, and review outputs.</p>
            </div>
          </div>
          <div class="room-messages" id="room-messages" role="log" aria-live="polite" aria-label="Chat messages"></div>
          <div class="xb-progress-bar" id="xb-progress-bar" hidden aria-live="polite" aria-label="Background task progress"></div>
          <div class="agent-typing-indicator" id="agent-typing-indicator" hidden aria-live="polite" aria-label="Agent activity"></div>
          <div class="room-composer">
            <div id="room-mention-menu" class="room-mention-menu" hidden role="listbox" aria-label="Mention suggestions"></div>
            <div class="room-composer-main">
              <input type="text" id="room-input" placeholder="Type a message..." autocomplete="off" aria-label="Message input" aria-autocomplete="list" aria-controls="room-mention-menu" />
              <button id="room-send-btn" class="send-btn" title="Send" aria-label="Send message">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V3M4 7l4-4 4 4"/></svg>
              </button>
              <button id="room-stop-btn" class="send-btn stop-btn" title="Stop AI" aria-label="Stop AI agent" hidden>
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="3" width="10" height="10" rx="1.5"/></svg>
              </button>
            </div>
            <div class="room-composer-hint" id="room-composer-hint">Press @ to mention an agent and delegate a task.</div>
          </div>
        </div>

        <!-- Sidebar Toggle Button -->
        <button class="room-sidebar-toggle" id="room-sidebar-toggle" hidden title="Toggle sidebar" aria-label="Toggle agent sidebar" aria-expanded="true" aria-controls="room-agent-sidebar">
          <span class="sidebar-toggle-icon" aria-hidden="true">◀</span>
        </button>

        <!-- Agent Room Sidebar (only visible for AI Agent rooms) -->
        <aside class="room-agent-sidebar" id="room-agent-sidebar" hidden role="complementary" aria-label="Agent workspace sidebar">
          <div class="sidebar-scroll-body">
            <section class="sidebar-section" role="region" aria-label="Agent progress">
              <button class="sidebar-section-toggle" aria-expanded="true" data-section="progress">
                <span class="sidebar-section-icon">⚡</span>
                <span class="sidebar-section-title">Live Progress</span>
                <span class="sidebar-section-chevron" aria-hidden="true">▾</span>
              </button>
              <div class="sidebar-section-body" id="sidebar-section-progress">
                <div id="room-agent-progress" class="agent-room-progress" role="log" aria-live="polite"></div>
              </div>
            </section>
            <section class="sidebar-section" role="region" aria-label="Handoff timeline">
              <button class="sidebar-section-toggle" aria-expanded="true" data-section="handoffs">
                <span class="sidebar-section-icon">🔀</span>
                <span class="sidebar-section-title">Handoff Flow</span>
                <span class="sidebar-section-chevron" aria-hidden="true">▾</span>
              </button>
              <div class="sidebar-section-body" id="sidebar-section-handoffs">
                <div id="agent-room-handoff-viz" class="agent-room-handoff-viz"></div>
              </div>
            </section>
            <section class="sidebar-section" role="region" aria-label="Activity log">
              <button class="sidebar-section-toggle" aria-expanded="true" data-section="logs">
                <span class="sidebar-section-icon">📋</span>
                <span class="sidebar-section-title">Activity Log</span>
                <span class="sidebar-section-chevron" aria-hidden="true">▾</span>
              </button>
              <div class="sidebar-section-body" id="sidebar-section-logs">
                <div id="room-agent-logs" class="agent-room-logs" role="log" aria-live="polite"></div>
              </div>
            </section>
          </div>
        </aside>
      </div>
    </div>

    <div class="room-ai-page" id="room-ai-page" hidden role="region" aria-label="AI agents">
      <div class="room-chat-header room-ai-header">
        <button id="room-ai-back-btn" class="btn-icon" title="Back to chat" aria-label="Back to chat">
          <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12.5 4.5L7 10l5.5 5.5"/>
            <path d="M7.5 10H16"/>
          </svg>
        </button>
        <div class="room-chat-info">
          <div class="room-chat-info-top">
            <span class="room-chat-kind">AI Agents</span>
          </div>
          <h3>Agent Workspace</h3>
          <span class="room-member-count">Configure specialists for planning, building, review, and documentation.</span>
        </div>
        <div class="room-chat-actions">
          <button class="btn-sm btn-primary" id="room-ai-add-btn" title="Add a new AI bot">+ Add Bot</button>
        </div>
      </div>
      <div class="room-ai-body">
        <div class="room-ai-intro">
          <div class="room-note-eyebrow">Team Setup</div>
          <div class="room-note-title">Manage your AI specialists.</div>
          <div class="room-note-body">Open an agent card to edit its role, tools, and model settings. Add focused specialists when the workflow needs them.</div>
        </div>
        <section class="room-ai-panel room-ai-task-board" aria-label="Structured task board">
          <div class="room-ai-panel-header">
            <div>
              <div class="room-note-eyebrow">Workflow Control</div>
              <div class="room-note-title">Structured task board</div>
              <div class="room-note-body">Track owner-scoped tasks with explicit priority, assignee, and progress instead of burying work in chat history.</div>
            </div>
          </div>
          <form id="agent-room-task-form" class="agent-task-form">
            <input type="text" id="agent-room-task-title" placeholder="Define the next concrete task" maxlength="160" required />
            <div class="agent-task-form-row">
              <select id="agent-room-task-priority" aria-label="Task priority">
                <option value="medium">Medium priority</option>
                <option value="high">High priority</option>
                <option value="low">Low priority</option>
              </select>
              <select id="agent-room-task-assignee" aria-label="Assign task">
                <option value="">Unassigned</option>
              </select>
              <button type="submit" class="btn-sm btn-primary">Add Task</button>
            </div>
            <textarea id="agent-room-task-details" rows="3" maxlength="4000" placeholder="Acceptance criteria, context, or constraints (optional)"></textarea>
          </form>
          <div id="agent-room-task-list" class="agent-task-list"></div>
        </section>
        <section class="room-ai-panel room-ai-orchestration" aria-label="Orchestration settings">
          <div class="room-ai-panel-header">
            <div>
              <div class="room-note-eyebrow">Orchestration</div>
              <div class="room-note-title">Mode & Autonomy</div>
              <div class="room-note-body">Control how agents coordinate, react, and self-organize.</div>
            </div>
          </div>
          <div id="agent-room-orchestration-config"></div>
        </section>
        <section class="room-ai-panel room-ai-token-usage" aria-label="Token usage">
          <div class="room-ai-panel-header">
            <div>
              <div class="room-note-eyebrow">Cost Tracking</div>
              <div class="room-note-title">Token Usage</div>
              <div class="room-note-body">Per-agent token consumption and cumulative totals.</div>
            </div>
          </div>
          <div id="agent-room-token-usage"></div>
        </section>
        <section class="room-ai-panel room-ai-memory" aria-label="Agent memories">
          <div class="room-ai-panel-header">
            <div>
              <div class="room-note-eyebrow">Agent State</div>
              <div class="room-note-title">Private Memories</div>
              <div class="room-note-body">Each agent's private memory — what it remembers between turns.</div>
            </div>
          </div>
          <div id="agent-room-memory-list"></div>
        </section>
        <div class="room-chat-bots room-ai-bots" id="room-ai-bots" role="group" aria-label="AI agents in this room"></div>
      </div>
    </div>

    <!-- Room Workspace View (Alternative to Chat) -->
    <div class="room-workspace" id="room-workspace" hidden>
      <div class="room-chat-header room-workspace-header">
        <button id="workspace-back-btn" class="btn-icon" title="Back to Chat" aria-label="Back to chat">
          <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12.5 4.5L7 10l5.5 5.5"/>
            <path d="M7.5 10H16"/>
          </svg>
        </button>
        <div class="room-chat-info room-workspace-title">
          <span class="workspace-eyebrow">Artifacts</span>
          <h3>Workspace & Deliverables</h3>
          <span class="room-member-count">Review generated files, trace progress, and inspect outputs in one place.</span>
        </div>
        <div class="room-chat-actions">
          <span id="agent-room-connection-state"></span>
          <button id="workspace-download-btn" class="btn-sm btn-secondary" title="Download Workspace">Download ZIP</button>
        </div>
      </div>
      <div class="workspace-body">
        <!-- Mobile tab switcher (hidden on desktop via CSS) -->
        <div class="workspace-tab-bar" role="tablist" aria-label="Workspace view">
          <button class="workspace-tab active" data-workspace-tab="files" role="tab" aria-selected="true">📁 Files</button>
          <button class="workspace-tab" data-workspace-tab="preview" role="tab" aria-selected="false">👁 Preview</button>
        </div>
        <div class="workspace-sidebar" data-workspace-panel="files">
          <details class="sidebar-accordion" open>
            <summary class="sidebar-accordion-header">
              <span class="sidebar-accordion-icon">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h5v5H2z"/><path d="M9 4h5v5H9z"/><path d="M2 11h5v1H2z"/><path d="M9 11h5v1H9z"/></svg>
              </span>
              <span class="sidebar-accordion-title">Files</span>
              <span id="sidebar-files-count" class="sidebar-accordion-badge" hidden>0</span>
              <span class="sidebar-accordion-chevron">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5L6 7.5L9 4.5"/></svg>
              </span>
            </summary>
            <div class="sidebar-accordion-body">
              <div class="sidebar-search-row">
                <input type="text" id="sidebar-file-search" class="sidebar-search-input" placeholder="Search files…" autocomplete="off" />
              </div>
              <div id="agent-room-file-list" class="workspace-file-list"></div>
            </div>
          </details>
          <details class="sidebar-accordion">
            <summary class="sidebar-accordion-header">
              <span class="sidebar-accordion-icon">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M8 5v3l2 1.5"/></svg>
              </span>
              <span class="sidebar-accordion-title">Activity</span>
              <span id="sidebar-activity-count" class="sidebar-accordion-badge" hidden>0</span>
              <span class="sidebar-accordion-chevron">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5L6 7.5L9 4.5"/></svg>
              </span>
            </summary>
            <div class="sidebar-accordion-body">
              <div id="agent-room-progress-items" class="workspace-progress-list"></div>
            </div>
          </details>
          <details class="sidebar-accordion" id="agent-room-snapshots"></details>
          <details class="sidebar-accordion" id="agent-room-skills"></details>
        </div>
        <div class="workspace-main" data-workspace-panel="preview">
          <div class="workspace-preview-header">
            <div class="workspace-preview-title-group">
              <div class="workspace-preview-title-row">
                <h4 id="agent-room-file-title">Select a file</h4>
                <button type="button" id="agent-room-download-file-btn" class="btn-sm btn-secondary" hidden>Download</button>
              </div>
              <p id="agent-room-file-meta">Choose an artifact or workspace file to preview it here.</p>
              <div class="workspace-review-row">
                <span id="agent-room-file-review-badge" class="workspace-review-badge" hidden></span>
                <span id="agent-room-file-review-meta" class="workspace-review-meta" hidden></span>
              </div>
            </div>
            <div class="workspace-preview-actions">
              <button type="button" id="agent-room-view-code-btn" class="btn-sm btn-secondary" hidden>Code</button>
              <button type="button" id="agent-room-view-live-btn" class="btn-sm btn-secondary" hidden>Live Preview</button>
              <button type="button" id="agent-room-fullscreen-btn" class="btn-sm btn-secondary" hidden title="Toggle fullscreen preview">⛶ Fullscreen</button>
              <button type="button" id="agent-room-run-python-btn" class="btn-sm btn-secondary" hidden>Run Python</button>
              <button type="button" id="agent-room-request-review-btn" class="btn-sm btn-secondary" hidden>Request Review</button>
              <button type="button" id="agent-room-request-changes-btn" class="btn-sm btn-secondary" hidden>Request Changes</button>
              <button type="button" id="agent-room-approve-file-btn" class="btn-sm btn-secondary" hidden>Approve</button>
              <button type="button" id="agent-room-promote-file-btn" class="btn-sm btn-secondary" hidden>Promote</button>
            </div>
          </div>
          <div id="agent-room-file-preview" class="workspace-preview-body"></div>
        </div>
      </div>
    </div>

    <!-- Create Room Modal -->
    <div class="modal-overlay" id="create-room-modal" style="display:none">
      <div class="modal modal-sm">
        <h3>Create Project Room</h3>
        <form id="create-room-form">
          <div class="form-group">
            <label for="room-name-input">Room Name</label>
            <input type="text" id="room-name-input" placeholder="e.g. ML Research" required minlength="2" maxlength="50" />
          </div>
          <div class="form-group">
            <label for="room-category-input">Category</label>
            <select id="room-category-input">
              <option value="team">Team</option>
              <option value="ai-agents">AI Agent</option>
            </select>
          </div>
          <div class="form-group">
            <label for="room-desc-input">Description (optional)</label>
            <input type="text" id="room-desc-input" placeholder="What's this room about?" maxlength="200" />
          </div>
          <div class="modal-actions">
            <button type="button" class="btn-secondary" id="create-room-cancel">Cancel</button>
            <button type="submit" class="btn-primary">Create</button>
          </div>
        </form>
      </div>
    </div>

    <!-- Join Room Modal -->
    <div class="modal-overlay" id="join-room-modal" style="display:none">
      <div class="modal modal-sm">
        <h3>Join a Room</h3>
        <form id="join-room-form">
          <div class="form-group">
            <label for="invite-code-input">Invite Code</label>
            <input type="text" id="invite-code-input" placeholder="e.g. a1b2c3d4" required />
          </div>
          <div class="modal-actions">
            <button type="button" class="btn-secondary" id="join-room-cancel">Cancel</button>
            <button type="submit" class="btn-primary">Join</button>
          </div>
        </form>
      </div>
    </div>

    <!-- Add/Edit Agent Modal -->
    <div class="modal-overlay" id="agent-config-modal" style="display:none">
      <div class="modal modal-md">
        <h3 id="agent-config-title">Add AI Bot</h3>
        <form id="agent-config-form">
          <input type="hidden" id="agent-config-mode" value="add" />
          <input type="hidden" id="agent-config-original-name" value="" />

          <!-- Tab navigation -->
          <div class="agent-config-tabs">
            <button type="button" class="agent-config-tab active" data-tab="identity">Identity</button>
            <button type="button" class="agent-config-tab" data-tab="provider">Model</button>
          </div>

          <!-- Tab: Identity -->
          <div class="agent-config-tab-panel active" data-tab-panel="identity">
              <div class="form-group">
                <label for="agent-name-input">Bot Name</label>
                <input type="text" id="agent-name-input" placeholder="e.g. researcher" required minlength="2" maxlength="32" pattern="[a-z][a-z0-9_-]+" title="Lowercase letters, numbers, underscores, hyphens. Must start with a letter." />
                <small class="form-hint">Lowercase, 2-32 chars. Used as @mention handle.</small>
              </div>
              <div class="form-group">
                <label for="agent-role-input">Role Description</label>
                <input type="text" id="agent-role-input" placeholder="e.g. Researches topics and gathers information" required maxlength="200" />
              </div>
              <div class="form-group">
                <label for="agent-prompt-input">System Prompt</label>
                <textarea id="agent-prompt-input" rows="5" placeholder="Custom instructions for this bot's persona and behavior..." maxlength="4000"></textarea>
              </div>
              <div class="form-group">
                <label>Tools</label>
                <div class="agent-tools-checkboxes">
                  <label class="checkbox-label"><input type="checkbox" name="agent-tool" value="list_files" checked /> list_files</label>
                  <label class="checkbox-label"><input type="checkbox" name="agent-tool" value="read_file" checked /> read_file</label>
                  <label class="checkbox-label"><input type="checkbox" name="agent-tool" value="write_file" checked /> write_file</label>
                  <label class="checkbox-label"><input type="checkbox" name="agent-tool" value="update_file" /> update_file</label>
                </div>
              </div>
          </div>

          <!-- Tab: Model — deep work model for ReAct tool loop -->
          <div class="agent-config-tab-panel" data-tab-panel="provider">
              <input type="hidden" id="agent-tier-input" value="worker" />
              <p class="form-hint" style="margin-bottom:8px">
                The model used for tool calling, code generation, and complex reasoning.
              </p>
              <div class="form-group">
                <label for="agent-provider-input">Provider</label>
                <select id="agent-provider-input">
                  <option value="tier" selected>Use Tier Default</option>
                  <option value="enowxai">EnowxAI (Gateway)</option>
                  <option value="openai">OpenAI</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="custom">Custom (OpenAI-compatible)</option>
                </select>
              </div>
              <div class="form-group" id="agent-base-url-group" style="display:none">
                <label for="agent-base-url-input">Base URL</label>
                <input type="url" id="agent-base-url-input" placeholder="https://your-endpoint.com" />
              </div>
              <div class="form-group" id="agent-api-key-group" style="display:none">
                <label for="agent-api-key-input">API Key</label>
                <input type="password" id="agent-api-key-input" placeholder="sk-..." autocomplete="off" />
              </div>
              <div class="form-group" id="agent-model-select-group" style="display:none">
                <label for="agent-model-select-input">Model</label>
                <select id="agent-model-select-input"></select>
              </div>
              <div class="form-group" id="agent-model-text-group" style="display:none">
                <label for="agent-model-text-input">Model Name</label>
                <input type="text" id="agent-model-text-input" placeholder="model-name" maxlength="200" />
              </div>
              <div class="form-group" id="agent-max-tokens-group" style="display:none">
                <label for="agent-max-tokens-input">Max Tokens</label>
                <input type="number" id="agent-max-tokens-input" min="256" max="128000" step="256" placeholder="4096" />
              </div>
              <div class="form-group" id="agent-temperature-group" style="display:none">
                <label for="agent-temperature-input">Temperature</label>
                <input type="number" id="agent-temperature-input" min="0" max="2" step="0.05" placeholder="0.3" />
              </div>
          </div>

          <!-- Router tab removed — no XA classification, all messages go to deep-work directly -->

          <div class="modal-actions">
            <button type="button" class="btn-secondary" id="agent-config-cancel">Cancel</button>
            <button type="button" class="btn-danger" id="agent-config-delete" style="display:none">Delete Bot</button>
            <button type="submit" class="btn-primary" id="agent-config-submit">Add Bot</button>
          </div>
        </form>
      </div>
    </div>
  `;

  rs.panel = panel;
  return panel;
}

function hideMentionMenu() {
  const menu = rs.panel?.querySelector('#room-mention-menu');
  if (!menu) return;
  menu.hidden = true;
  menu.innerHTML = '';
  rs.mentionSelectedIdx = -1;
}

function applyMention(agentName) {
  const input = rs.panel?.querySelector('#room-input');
  if (!input) return;
  const cursor = input.selectionStart ?? input.value.length;
  const prefix = input.value.slice(0, cursor).replace(/(^|\s)@([a-zA-Z0-9_-]*)$/, `$1@${agentName} `);
  const suffix = input.value.slice(cursor);
  input.value = `${prefix}${suffix}`;
  const nextPosition = prefix.length;
  input.focus();
  input.setSelectionRange(nextPosition, nextPosition);
  hideMentionMenu();
}

function showMentionMenu(filter = '') {
  const menu = rs.panel?.querySelector('#room-mention-menu');
  if (!menu || rs.currentRoomMode !== 'agent') return;

  const candidates = rs.currentAgentMembers
    .filter((agent) => agent.name.toLowerCase().includes(filter.toLowerCase()))
    .slice(0, 6);

  if (candidates.length === 0) {
    hideMentionMenu();
    return;
  }

  if (rs.mentionSelectedIdx < 0 || rs.mentionSelectedIdx >= candidates.length) {
    rs.mentionSelectedIdx = 0;
  }

  menu.hidden = false;
  menu.innerHTML = candidates.map((agent, index) => `
    <button type="button" class="room-mention-item${index === rs.mentionSelectedIdx ? ' is-selected' : ''}" data-agent-name="${agent.name}" role="option" aria-selected="${index === rs.mentionSelectedIdx}" id="mention-option-${index}">
      <span class="room-mention-name">@${escapeHtml(agent.name)}</span>
      <span class="room-mention-role">${escapeHtml(agent.role)}</span>
    </button>
  `).join('');

  const input = rs.panel?.querySelector('#room-input');
  if (input) input.setAttribute('aria-activedescendant', `mention-option-${rs.mentionSelectedIdx}`);

  menu.querySelectorAll('.room-mention-item').forEach((item) => {
    item.addEventListener('click', () => applyMention(item.dataset.agentName));
  });
}

function updateMentionMenu() {
  const input = rs.panel?.querySelector('#room-input');
  if (!input || rs.currentRoomMode !== 'agent') {
    hideMentionMenu();
    return;
  }

  const cursor = input.selectionStart ?? input.value.length;
  const match = input.value.slice(0, cursor).match(/(^|\s)@([a-zA-Z0-9_-]*)$/);
  if (!match) {
    hideMentionMenu();
    return;
  }

  showMentionMenu(match[2] || '');
}

export function initRoomsUI() {
  if (!rs.panel) return;

  const createBtn = rs.panel.querySelector('#create-room-btn');
  const joinBtn = rs.panel.querySelector('#join-room-btn');
  const createModal = rs.panel.querySelector('#create-room-modal');
  const joinModal = rs.panel.querySelector('#join-room-modal');
  const createForm = rs.panel.querySelector('#create-room-form');
  const joinForm = rs.panel.querySelector('#join-room-form');
  const backBtn = rs.panel.querySelector('#room-back-btn');
  const inviteBtn = rs.panel.querySelector('#room-invite-btn');
  const leaveBtn = rs.panel.querySelector('#room-leave-btn');
  const roomInput = rs.panel.querySelector('#room-input');
  const roomSendBtn = rs.panel.querySelector('#room-send-btn');
  const roomStopBtn = rs.panel.querySelector('#room-stop-btn');
  const roomAiBtn = rs.panel.querySelector('#room-ai-btn');
  const roomAiBackBtn = rs.panel.querySelector('#room-ai-back-btn');
  const roomAiAddBtn = rs.panel.querySelector('#room-ai-add-btn');
  const roomTaskForm = rs.panel.querySelector('#agent-room-task-form');
  const roomTaskList = rs.panel.querySelector('#agent-room-task-list');

  createBtn.addEventListener('click', () => { createModal.style.display = 'flex'; });
  rs.panel.querySelector('#create-room-cancel').addEventListener('click', () => { createModal.style.display = 'none'; });
  createModal.addEventListener('click', (e) => { if (e.target === createModal) createModal.style.display = 'none'; });

  createForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = rs.panel.querySelector('#room-name-input').value.trim();
    const category = rs.panel.querySelector('#room-category-input').value;
    const desc = rs.panel.querySelector('#room-desc-input').value.trim();
    try {
      await createRoom(name, desc, category);
      createModal.style.display = 'none';
      createForm.reset();
      showToast(`Room "${name}" created!`, 'success');
      await refreshRoomsList({ onOpenTeamRoom: openRoomChat, onOpenAgentRoom: openAgentRoomChat, onCloseRoom: closeRoomChat });
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  joinBtn.addEventListener('click', () => { joinModal.style.display = 'flex'; });
  rs.panel.querySelector('#join-room-cancel').addEventListener('click', () => { joinModal.style.display = 'none'; });
  joinModal.addEventListener('click', (e) => { if (e.target === joinModal) joinModal.style.display = 'none'; });

  joinForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = rs.panel.querySelector('#invite-code-input').value.trim();
    try {
      const data = await joinRoom(code);
      joinModal.style.display = 'none';
      joinForm.reset();
      if (data.already_member) {
        showToast('You are already a member of this room', 'warning');
      } else {
        showToast(`Joined room "${data.room?.name}"!`, 'success');
      }
      await refreshRoomsList({ onOpenTeamRoom: openRoomChat, onOpenAgentRoom: openAgentRoomChat, onCloseRoom: closeRoomChat });
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  backBtn.addEventListener('click', () => {
    closeRoomChat();
  });

  // ── Phase 2: Toggle bot pills on mobile via member count tap ──
  const membersEl = rs.panel.querySelector('#room-chat-members');
  if (membersEl) {
    membersEl.style.cursor = 'pointer';
    membersEl.addEventListener('click', () => {
      const bots = rs.panel.querySelector('#room-ai-bots') || rs.panel.querySelector('#room-chat-bots');
      if (bots && window.innerWidth <= 768) {
        bots.classList.toggle('mobile-expanded');
      }
    });
  }

  // ── Phase 2 & 6: Auto-collapse handoff section on mobile ─────
  if (window.innerWidth <= 768) {
    const handoffToggle = rs.panel.querySelector('.sidebar-section-toggle[data-section="handoffs"]');
    if (handoffToggle) {
      handoffToggle.setAttribute('aria-expanded', 'false');
      const handoffBody = rs.panel.querySelector('#sidebar-section-handoffs');
      if (handoffBody) handoffBody.classList.add('collapsed');
    }
  }

  inviteBtn.addEventListener('click', async () => {
    if (!rs.currentRoomId) return;
    try {
      const data = await getRoom(rs.currentRoomId);
      const code = data.room.invite_code;
      await copyToClipboard(code);
      showToast(`Invite code copied: ${code}`, 'success');
    } catch {
      showToast('Failed to copy invite code', 'error');
    }
  });

  leaveBtn.addEventListener('click', async () => {
    if (!rs.currentRoomId) return;
    const confirmed = await showConfirm({
      title: 'Leave Room',
      message: 'You will no longer receive messages from this room. You can rejoin later with an invite code.',
      confirmText: 'Leave',
      variant: 'warning',
    });
    if (!confirmed) return;
    try {
      await leaveRoomApi(rs.currentRoomId);
      closeRoomChat();
      showToast('Left the room', 'success');
      await refreshRoomsList({ onOpenTeamRoom: openRoomChat, onOpenAgentRoom: openAgentRoomChat, onCloseRoom: closeRoomChat });
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  const deleteBtn = rs.panel.querySelector('#room-delete-btn');
  deleteBtn.addEventListener('click', async () => {
    if (!rs.currentRoomId) return;
    const confirmed = await showConfirm({
      title: 'Delete Room',
      message: 'This will permanently delete the room and all its messages. This action cannot be undone.',
      confirmText: 'Delete Room',
      variant: 'danger',
    });
    if (!confirmed) return;
    try {
      await deleteRoom(rs.currentRoomId);
      closeRoomChat();
      showToast('Room deleted', 'success');
      await refreshRoomsList({ onOpenTeamRoom: openRoomChat, onOpenAgentRoom: openAgentRoomChat, onCloseRoom: closeRoomChat });
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  const downloadBtn = rs.panel.querySelector('#room-download-btn');
  if (downloadBtn) {
    downloadBtn.addEventListener('click', () => handleDownloadWorkspace());
  }

  // ── Overflow menu for mobile ──────────────────────────────────
  const overflowBtn = rs.panel.querySelector('#room-overflow-btn');
  if (overflowBtn) {
    overflowBtn.addEventListener('click', () => {
      const dlBtn = rs.panel.querySelector('#room-download-btn');
      const delBtn = rs.panel.querySelector('#room-delete-btn');
      showOverflowMenu(overflowBtn, [
        { label: 'Download ZIP', icon: '📥', hidden: dlBtn?.hidden, action: () => handleDownloadWorkspace() },
        { label: 'Copy Invite Code', icon: '🔗', action: () => inviteBtn.click() },
        { label: 'Leave Room', icon: '👋', action: () => leaveBtn.click() },
        { divider: true, label: 'Delete Room', icon: '🗑️', danger: true, hidden: delBtn?.hidden, action: () => delBtn?.click() },
      ]);
    });
  }

  if (roomAiBtn) {
    roomAiBtn.addEventListener('click', async () => {
      showRoomAiPage();
      if (rs.currentAgentRoomId) {
        try {
          await refreshAgentRoomTasks();
        } catch (error) {
          showToast(error.message || 'Failed to refresh tasks', 'error');
        }
      }
    });
  }

  if (roomAiBackBtn) {
    roomAiBackBtn.addEventListener('click', () => showRoomChatPage());
  }

  if (roomAiAddBtn) {
    roomAiAddBtn.addEventListener('click', () => openAgentConfigModal('add', null, renderAgentMembers));
  }

  if (roomTaskForm) {
    roomTaskForm.addEventListener('submit', (event) => {
      handleAgentTaskFormSubmit(event);
    });
  }

  if (roomTaskList) {
    roomTaskList.addEventListener('change', (event) => {
      handleAgentTaskListChange(event);
    });
  }

  const sidebarToggle = rs.panel.querySelector('#room-sidebar-toggle');
  if (sidebarToggle) {
    sidebarToggle.addEventListener('click', () => toggleAgentSidebar());
  }

  // Collapsible sidebar section toggles
  rs.panel.querySelectorAll('.sidebar-section-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const section = btn.getAttribute('data-section');
      const body = rs.panel.querySelector(`#sidebar-section-${section}`);
      if (!body) return;
      const isExpanded = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', String(!isExpanded));
      body.classList.toggle('collapsed', isExpanded);
    });
  });

  const workspaceBack = rs.panel.querySelector('#workspace-back-btn');
  if (workspaceBack) {
    workspaceBack.addEventListener('click', () => {
      const workspaceView = rs.panel.querySelector('#room-workspace');
      const roomChat = rs.panel.querySelector('#room-chat');
      if (workspaceView) workspaceView.hidden = true;
      if (roomChat) roomChat.hidden = false;
    });
  }

  // ── Workspace mobile tab switcher ──────────────────────────────
  rs.panel.querySelectorAll('.workspace-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      switchWorkspaceTab(tab.dataset.workspaceTab);
    });
  });

  // File search filter
  const fileSearchInput = rs.panel.querySelector('#sidebar-file-search');
  if (fileSearchInput) {
    let searchDebounce = null;
    fileSearchInput.addEventListener('input', () => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => renderAgentFiles(), 150);
    });
  }

  const artifactsBtn = rs.panel.querySelector('#room-artifacts-btn');
  if (artifactsBtn) {
    artifactsBtn.addEventListener('click', () => {
      handleArtifactsClick();
      const snapshotContainer = rs.panel?.querySelector('#agent-room-snapshots');
      if (snapshotContainer) loadSnapshots(snapshotContainer);
      const skillContainer = rs.panel?.querySelector('#agent-room-skills');
      if (skillContainer) loadSkills(skillContainer);
    });
  }

  const codeViewBtn = rs.panel.querySelector('#agent-room-view-code-btn');
  if (codeViewBtn) {
    codeViewBtn.addEventListener('click', () => setAgentWorkspacePreviewMode('code'));
  }

  const liveViewBtn = rs.panel.querySelector('#agent-room-view-live-btn');
  if (liveViewBtn) {
    liveViewBtn.addEventListener('click', () => setAgentWorkspacePreviewMode('live'));
  }

  const fullscreenBtn = rs.panel.querySelector('#agent-room-fullscreen-btn');
  if (fullscreenBtn) {
    fullscreenBtn.addEventListener('click', () => togglePreviewFullscreen());
  }

  const runPythonBtn = rs.panel.querySelector('#agent-room-run-python-btn');
  if (runPythonBtn) {
    runPythonBtn.addEventListener('click', () => runSelectedAgentPythonFile());
  }

  const requestReviewBtn = rs.panel.querySelector('#agent-room-request-review-btn');
  if (requestReviewBtn) {
    requestReviewBtn.addEventListener('click', () => setSelectedAgentFileReviewStatus('in_review'));
  }

  const requestChangesBtn = rs.panel.querySelector('#agent-room-request-changes-btn');
  if (requestChangesBtn) {
    requestChangesBtn.addEventListener('click', () => setSelectedAgentFileReviewStatus('changes_requested'));
  }

  const approveFileBtn = rs.panel.querySelector('#agent-room-approve-file-btn');
  if (approveFileBtn) {
    approveFileBtn.addEventListener('click', () => setSelectedAgentFileReviewStatus('approved'));
  }

  const promoteFileBtn = rs.panel.querySelector('#agent-room-promote-file-btn');
  if (promoteFileBtn) {
    promoteFileBtn.addEventListener('click', () => setSelectedAgentFileReviewStatus('promoted'));
  }

  const downloadFileBtn = rs.panel.querySelector('#agent-room-download-file-btn');
  if (downloadFileBtn) {
    downloadFileBtn.addEventListener('click', () => downloadSelectedAgentFile());
  }

  // ── Orchestration config event listeners ──────────────────────
  rs.panel.addEventListener('change', (e) => {
    if (e.target.id === 'orch-mode-select') {
      handleOrchestrationModeChange(e.target.value);
    }
    if (e.target.id === 'orch-autonomy-slider') {
      handleAutonomyLevelChange(e.target.value);
    }
  });

  // ── Memory panel event delegation ─────────────────────────────
  rs.panel.addEventListener('click', (e) => {
    const saveBtn = e.target.closest('.agent-memory-save');
    if (saveBtn) {
      saveAgentMemory(saveBtn.dataset.agentName);
      return;
    }
    const clearBtn = e.target.closest('.agent-memory-clear');
    if (clearBtn) {
      clearAgentMemoryAction(clearBtn.dataset.agentName);
    }
  });

  rs.panel.addEventListener('click', async (e) => {
    const mentionBtn = e.target.closest('[data-agent-mention]');
    if (mentionBtn && rs.currentRoomMode === 'agent') {
      applyMention(mentionBtn.dataset.agentMention);
      return;
    }

    const dismissTipBtn = e.target.closest('[data-room-tip-dismiss]');
    if (dismissTipBtn) {
      const roomNote = rs.panel.querySelector('#room-chat-note');
      if (roomNote) {
        roomNote.hidden = true;
        roomNote.innerHTML = '';
      }
      return;
    }

    const artifactCard = e.target.closest('[data-artifact-path]');
    if (artifactCard && rs.currentRoomMode === 'agent') {
        const path = artifactCard.dataset.artifactPath;
        const workspaceView = rs.panel.querySelector("#room-workspace");
        const roomChat = rs.panel.querySelector("#room-chat");
        if (roomChat) roomChat.hidden = true;
        if (workspaceView) workspaceView.hidden = false;
      if (path) {
        await openAgentFile(path);
        const filesPanel = rs.panel.querySelector('.agent-room-panel-files');
        if (filesPanel) filesPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
      return;
    }

    const fileBtn = e.target.closest('[data-file-path]');
    if (fileBtn && rs.currentRoomMode === 'agent') {
      if (fileBtn.dataset.fileKind === 'file') {
        await openAgentFile(fileBtn.dataset.filePath);
      }
      return;
    }
  });

  const doSend = async () => {
    if (!rs.currentRoomId || !roomInput.value.trim()) return;
    const content = roomInput.value.trim();
    roomInput.value = '';
    try {
      if (rs.currentRoomMode === 'agent') {
        await sendAgentRoomMessage(rs.currentAgentRoomId, content);
        hideMentionMenu();
        return;
      }
      await sendRoomMessage(rs.currentRoomId, content);
      await loadRoomMessages(rs.currentRoomId);
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  roomSendBtn.addEventListener('click', doSend);

  // Stop button — cancels active AI agent work
  roomStopBtn.addEventListener('click', async () => {
    if (!rs.currentAgentRoomId) return;
    roomStopBtn.disabled = true;
    try {
      await cancelAgentRoom(rs.currentAgentRoomId);
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      roomStopBtn.disabled = false;
    }
  });

  roomInput.addEventListener('input', updateMentionMenu);
  roomInput.addEventListener('blur', () => {
    setTimeout(() => hideMentionMenu(), 150);
  });
  roomInput.addEventListener('keydown', (e) => {
    const mentionMenu = rs.panel.querySelector('#room-mention-menu');
    const items = mentionMenu ? Array.from(mentionMenu.querySelectorAll('.room-mention-item')) : [];
    const mentionOpen = mentionMenu && !mentionMenu.hidden && items.length > 0;

    if (mentionOpen && e.key === 'ArrowDown') {
      e.preventDefault();
      rs.mentionSelectedIdx = (rs.mentionSelectedIdx + 1 + items.length) % items.length;
      updateMentionMenu();
      return;
    }

    if (mentionOpen && e.key === 'ArrowUp') {
      e.preventDefault();
      rs.mentionSelectedIdx = (rs.mentionSelectedIdx - 1 + items.length) % items.length;
      updateMentionMenu();
      return;
    }

    if (mentionOpen && (e.key === 'Enter' || e.key === 'Tab')) {
      e.preventDefault();
      const selected = items[rs.mentionSelectedIdx] || items[0];
      if (selected?.dataset.agentName) {
        applyMention(selected.dataset.agentName);
      }
      return;
    }

    if (mentionOpen && e.key === 'Escape') {
      e.preventDefault();
      hideMentionMenu();
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
  });

  const agentConfigModal = rs.panel.querySelector('#agent-config-modal');
  const agentConfigForm = rs.panel.querySelector('#agent-config-form');
  const agentConfigCancel = rs.panel.querySelector('#agent-config-cancel');
  const agentConfigDelete = rs.panel.querySelector('#agent-config-delete');

  agentConfigCancel.addEventListener('click', closeAgentConfigModal);
  agentConfigModal.addEventListener('click', (e) => { if (e.target === agentConfigModal) closeAgentConfigModal(); });

  agentConfigForm.addEventListener('submit', (e) => {
    e.preventDefault();
    handleAgentConfigSubmit((agents) => renderAgentMembers(agents));
  });

  agentConfigDelete.addEventListener('click', () => {
    handleAgentConfigDelete((agents) => renderAgentMembers(agents));
  });

  const providerSelect = rs.panel.querySelector('#agent-provider-input');
  if (providerSelect) {
    providerSelect.addEventListener('change', (e) => {
      updateRoomProviderFields(rs.panel, e.target.value).catch((err) => {
        showToast(err instanceof Error ? err.message : 'Failed to update provider fields.', 'error');
      });
    });
  }
}

export async function openRoomChat(roomId) {
  rs.currentRoomId = roomId;
  rs.currentRoomMode = 'team';
  rs.currentAgentRoomId = null;
  closeAgentSocket();
  resetAgentRoomSidebar();
  clearSnapshots();
  clearSkills();
  const roomsPage = rs.panel?.querySelector('.rooms-page');
  const roomChat = rs.panel?.querySelector('#room-chat');
  const roomNote = rs.panel?.querySelector('#room-chat-note');
  const roomBots = rs.panel?.querySelector('#room-chat-bots') || rs.panel?.querySelector('#room-ai-bots');
  const messagesEl = rs.panel?.querySelector('#room-messages');
  const workspaceView = rs.panel?.querySelector('#room-workspace');
  const roomAiPage = rs.panel?.querySelector('#room-ai-page');
  const roomKind = rs.panel?.querySelector('#room-chat-kind');
  const threadCaption = rs.panel?.querySelector('#room-thread-caption');
  const composerHint = rs.panel?.querySelector('#room-composer-hint');
  const roomAiBtn = rs.panel?.querySelector('#room-ai-btn');

  if (roomsPage) roomsPage.hidden = true;
  if (roomChat) roomChat.hidden = false;
  if (workspaceView) workspaceView.hidden = true;
  if (roomAiPage) roomAiPage.hidden = true;
  if (roomAiBtn) roomAiBtn.hidden = true;
  if (messagesEl) messagesEl.innerHTML = '<div class="room-msg room-msg-system">Loading room…</div>';

  // Hide agent-only UI elements for team rooms
  const overflowBtn = rs.panel?.querySelector('#room-overflow-btn');
  const connectionState = rs.panel?.querySelector('#room-connection-state');
  const artifactsBtn = rs.panel?.querySelector('#room-artifacts-btn');
  const downloadBtn = rs.panel?.querySelector('#room-download-btn');
  const stopBtn = rs.panel?.querySelector('#room-stop-btn');
  if (overflowBtn) overflowBtn.hidden = true;
  if (connectionState) connectionState.hidden = true;
  if (artifactsBtn) artifactsBtn.hidden = true;
  if (downloadBtn) downloadBtn.hidden = true;
  if (stopBtn) stopBtn.hidden = true;

  try {
    const data = await getRoom(roomId);
    const nameEl = rs.panel?.querySelector('#room-chat-name');
    const membersEl = rs.panel?.querySelector('#room-chat-members');
    const inputEl = rs.panel?.querySelector('#room-input');
    if (nameEl) nameEl.textContent = data.room.name;
    if (membersEl) membersEl.textContent = `${data.members?.length || 0} members`;
    if (inputEl) inputEl.placeholder = 'Type a message...';
    if (roomKind) roomKind.textContent = 'Team Room';
    if (threadCaption) threadCaption.textContent = 'Collaborate with people in the room.';
    if (composerHint) composerHint.textContent = 'Share updates, decisions, or questions with the team.';
    rs.currentAgentMembers = [];
    if (roomNote) { roomNote.hidden = true; roomNote.textContent = ''; }
    if (roomBots) { roomBots.hidden = true; roomBots.innerHTML = ''; }

    showAgentSidebar(false);

    const user = getCurrentUser();
    const deleteBtn = rs.panel?.querySelector('#room-delete-btn');
    if (deleteBtn) deleteBtn.hidden = !(user && data.room.owner_id === user.id);

    await loadRoomMessages(roomId);

    if (rs.roomPollTimer) clearInterval(rs.roomPollTimer);
    rs.roomPollTimer = setInterval(() => loadRoomMessages(roomId), 3000);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

export async function openAgentRoomChat(projectRoomId) {
  rs.currentRoomId = projectRoomId;
  rs.currentRoomMode = 'agent';
  closeAgentSocket();
  resetAgentRoomSidebar();

  const roomsPage = rs.panel?.querySelector('.rooms-page');
  const roomChat = rs.panel?.querySelector('#room-chat');
  const roomNote = rs.panel?.querySelector('#room-chat-note');
  const roomBots = rs.panel?.querySelector('#room-ai-bots');
  const messagesEl = rs.panel?.querySelector('#room-messages');
  const workspaceView = rs.panel?.querySelector('#room-workspace');
  const roomAiPage = rs.panel?.querySelector('#room-ai-page');
  const roomKind = rs.panel?.querySelector('#room-chat-kind');
  const threadCaption = rs.panel?.querySelector('#room-thread-caption');
  const composerHint = rs.panel?.querySelector('#room-composer-hint');
  const roomAiBtn = rs.panel?.querySelector('#room-ai-btn');

  if (roomsPage) roomsPage.hidden = true;
  if (roomChat) roomChat.hidden = false;
  if (workspaceView) workspaceView.hidden = true;
  if (roomAiPage) roomAiPage.hidden = true;
  if (roomAiBtn) roomAiBtn.hidden = false;
  if (messagesEl) messagesEl.innerHTML = '<div class="room-msg room-msg-system">Loading agent room…</div>';

  // Show agent-only UI elements (may have been hidden by team room)
  const overflowBtn = rs.panel?.querySelector('#room-overflow-btn');
  if (overflowBtn) overflowBtn.hidden = false;

  try {
    const data = await getProjectAgentRoomDetails(projectRoomId);
    rs.currentAgentRoomId = data.room?.id || null;

    // Persist room state so user can return after closing the browser
    persistAgentRoomState(projectRoomId, data.room?.name || 'AI Agent Room');

    const nameEl = rs.panel?.querySelector('#room-chat-name');
    const membersEl = rs.panel?.querySelector('#room-chat-members');
    const inputEl = rs.panel?.querySelector('#room-input');
    if (nameEl) nameEl.textContent = data.room?.name || 'AI Agent Room';
    if (membersEl) membersEl.textContent = `${data.agents?.length || 0} bot members`;
    if (inputEl) inputEl.placeholder = 'Message the room. Example: @planner make a build plan';
    if (roomKind) roomKind.textContent = 'AI Agent Room';
    if (threadCaption) threadCaption.textContent = 'Delegate work, monitor handoffs, and inspect generated artifacts.';
    if (composerHint) composerHint.textContent = 'Best practice: assign a clear goal, scope, and expected output to one agent at a time.';

    const shouldShowNewRoomTip = isNewAgentRoom(data.messages || []);
    if (roomNote) roomNote.hidden = !shouldShowNewRoomTip;
    if (roomNote && shouldShowNewRoomTip) {
      const agentNames = (data.agents || []).map((a) => `
        <button type="button" class="room-note-chip" data-agent-mention="${escapeHtml(a.name)}">@${escapeHtml(a.name)}</button>
      `);
      roomNote.innerHTML = agentNames.length > 0
        ? `
          <button type="button" class="room-note-close" data-room-tip-dismiss aria-label="Dismiss tip">×</button>
          <div class="room-note-eyebrow">Delegation Ready</div>
          <div class="room-note-title">Route work through the right agent.</div>
          <div class="room-note-body">Use mentions to assign a task, then review artifacts and logs in the right sidebar or full workspace page.</div>
          <div class="room-note-chip-row">${agentNames.join('')}</div>
        `
        : `
          <button type="button" class="room-note-close" data-room-tip-dismiss aria-label="Dismiss tip">×</button>
          <div class="room-note-eyebrow">No Agents Yet</div>
          <div class="room-note-title">Add bot members to start delegating work.</div>
          <div class="room-note-body">Create specialized agents for planning, implementation, review, or documentation.</div>
        `;
    } else if (roomNote) {
      roomNote.innerHTML = '';
    }
    renderAgentMembers(data.agents || []);

    const user = getCurrentUser();
    const deleteBtn = rs.panel?.querySelector('#room-delete-btn');
    if (deleteBtn) deleteBtn.hidden = !(user && data.room?.owner_id === user.id);

    rs.agentRoomLogs = data.logs || [];
    rs.agentRoomOrchestrationMode = data.room?.orchestration_mode || 'reactive';
    rs.agentRoomAutonomyLevel = data.room?.autonomy_level ?? 2;
    hydrateAgentRoomTasks(data.tasks || []);
    resetHandoffTimeline();
    clearAllTypingIndicators();

    showAgentSidebar(true);
    renderRoomMessages(data.messages || [], 'agent');
    renderAgentProgress();
    renderAgentLogs();
    renderAgentFiles();
    renderAgentRoomTasks();
    renderOrchestrationConfig();
    renderHandoffTimeline();

    // Extract handoffs from existing messages for the timeline
    for (const msg of (data.messages || [])) {
      if (msg.event_type === 'handoff' && msg.sender_type === 'agent') {
        extractHandoffsFromMessage(msg);
      }
    }

    // Show active background work status (agents still working after browser was closed)
    const activeWork = data.activeWork || [];
    if (activeWork.length > 0) {
      const workingAgents = activeWork.map((w) => `@${w.agentName}`).join(', ');
      showToast(`🔄 ${workingAgents} still working in background`, 'info', 5000);
      // Show the stop button since work is in progress
      const stopBtn = rs.panel?.querySelector('#room-stop-btn');
      if (stopBtn) stopBtn.hidden = false;
    }

    await refreshAgentFiles();

    // Load async data in parallel
    Promise.all([
      loadAgentMemories(),
      loadTokenUsage(),
    ]).catch(() => {});

    connectAgentRoomSocket();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

export function renderAgentMembers(agents) {
  const roomBots = rs.panel.querySelector('#room-ai-bots');
  if (!roomBots) return;

  rs.currentAgentMembers = agents;
  syncAgentTaskAssigneeOptions();

  if (!agents.length) {
    roomBots.hidden = true;
    roomBots.innerHTML = '';
    renderAgentRoomTasks();
    renderAgentMemories();
    return;
  }

  roomBots.hidden = false;
  roomBots.setAttribute('role', 'group');
  roomBots.setAttribute('aria-label', 'AI agents in this room');
  roomBots.innerHTML = agents.map((agent) => `
    <div class="room-chat-bot-pill status-${sanitizeClassToken(agent.status || 'idle')}" data-agent-edit="${agent.name}" title="Click to edit @${escapeHtml(agent.name)}" role="button" tabindex="0" aria-label="Agent ${escapeHtml(agent.name)}, role: ${escapeHtml(agent.role)}, status: ${escapeHtml(agent.status || 'idle')}">
      <div class="room-chat-bot-top">
        <span class="room-chat-bot-name">@${escapeHtml(agent.name)}</span>
        <span class="room-chat-bot-status">${escapeHtml(agent.status || 'idle')}</span>
      </div>
      <span class="room-chat-bot-role">${escapeHtml(agent.role)}</span>
      <span class="room-chat-bot-meta">Click to edit tools and model</span>
    </div>
  `).join('') + `
    <button class="room-chat-bot-pill room-chat-bot-add" id="add-bot-btn" title="Add a new AI bot to this room" aria-label="Add a new AI agent">
      <span class="room-chat-bot-name">+ Add Bot</span>
      <span class="room-chat-bot-role">Create a new specialized assistant for this room.</span>
    </button>
  `;

  roomBots.querySelectorAll('[data-agent-edit]').forEach((pill) => {
    pill.style.cursor = 'pointer';
    const openEdit = () => {
      const agent = agents.find((a) => a.name === pill.dataset.agentEdit);
      if (agent) openAgentConfigModal('edit', agent, renderAgentMembers);
    };
    pill.addEventListener('click', openEdit);
    pill.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEdit(); }
    });
  });

  const addBtn = roomBots.querySelector('#add-bot-btn');
  if (addBtn) {
    addBtn.addEventListener('click', () => openAgentConfigModal('add', null, renderAgentMembers));
  }
}

export function closeRoomChat() {
  rs.currentRoomId = null;
  rs.currentRoomMode = 'team';
  rs.currentAgentRoomId = null;
  rs.currentAgentMembers = [];
  resetAgentRoomTasks();
  if (rs.roomPollTimer) { clearInterval(rs.roomPollTimer); rs.roomPollTimer = null; }
  if (rs.agentRoomReconnectTimer) { clearTimeout(rs.agentRoomReconnectTimer); rs.agentRoomReconnectTimer = null; }
  closeAgentSocket();
  resetAgentRoomSidebar();
  showAgentSidebar(false);
  const roomsPage = rs.panel?.querySelector('.rooms-page');
  const roomChat = rs.panel?.querySelector('#room-chat');
  const roomNote = rs.panel?.querySelector('#room-chat-note');
  const roomBots = rs.panel?.querySelector('#room-ai-bots');
  const workspaceView = rs.panel?.querySelector('#room-workspace');
  const roomAiPage = rs.panel?.querySelector('#room-ai-page');
  const roomAiBtn = rs.panel?.querySelector('#room-ai-btn');
  if (roomsPage) roomsPage.hidden = false;
  if (roomChat) roomChat.hidden = true;
  if (workspaceView) workspaceView.hidden = true;
  if (roomAiPage) roomAiPage.hidden = true;
  if (roomAiBtn) roomAiBtn.hidden = true;
  if (roomNote) { roomNote.hidden = true; roomNote.textContent = ''; }
  if (roomBots) { roomBots.hidden = true; roomBots.classList.remove('mobile-expanded'); roomBots.innerHTML = ''; }
  hideMentionMenu();
  closeOverflowMenu();
  clearAgentRoomState();
  applyActiveRoomCard();
}

/**
 * Switch between Files and Preview tabs in the workspace (mobile only).
 * On desktop this is a no-op since both panels are always visible.
 */
export function switchWorkspaceTab(tabName) {
  if (!rs.panel) return;
  const tabs = rs.panel.querySelectorAll('.workspace-tab');
  const panels = rs.panel.querySelectorAll('[data-workspace-panel]');

  tabs.forEach((tab) => {
    const isActive = tab.dataset.workspaceTab === tabName;
    tab.classList.toggle('active', isActive);
    tab.setAttribute('aria-selected', String(isActive));
  });

  panels.forEach((panel) => {
    panel.classList.toggle('workspace-panel-hidden', panel.dataset.workspacePanel !== tabName);
  });
}

export function cleanupRooms() {
  if (rs.roomPollTimer) { clearInterval(rs.roomPollTimer); rs.roomPollTimer = null; }
  if (rs.agentRoomReconnectTimer) { clearTimeout(rs.agentRoomReconnectTimer); rs.agentRoomReconnectTimer = null; }
  closeAgentSocket();
  resetAgentRoomSidebar();
  showAgentSidebar(false);
  rs.currentRoomId = null;
  rs.currentRoomMode = 'team';
  rs.currentAgentRoomId = null;
  rs.currentAgentMembers = [];
  resetAgentRoomTasks();
  rs.selectedListRoomId = null;
  rs.seenMessageIds.clear();
  hideMentionMenu();
  clearAllTypingIndicators();

  // Reset DOM state so returning to Rooms tab shows the rooms list, not a stale chat
  const roomsPage = rs.panel?.querySelector('.rooms-page');
  const roomChat = rs.panel?.querySelector('#room-chat');
  const roomNote = rs.panel?.querySelector('#room-chat-note');
  const roomBots = rs.panel?.querySelector('#room-ai-bots');
  const workspaceView = rs.panel?.querySelector('#room-workspace');
  const roomAiPage = rs.panel?.querySelector('#room-ai-page');
  const roomAiBtn = rs.panel?.querySelector('#room-ai-btn');
  if (roomsPage) roomsPage.hidden = false;
  if (roomChat) roomChat.hidden = true;
  if (workspaceView) workspaceView.hidden = true;
  if (roomAiPage) roomAiPage.hidden = true;
  if (roomAiBtn) roomAiBtn.hidden = true;
  if (roomNote) { roomNote.hidden = true; roomNote.textContent = ''; }
  if (roomBots) { roomBots.hidden = true; roomBots.innerHTML = ''; }
}

function showRoomAiPage() {
  if (!rs.panel) return;
  const roomChat = rs.panel.querySelector('#room-chat');
  const roomAiPage = rs.panel.querySelector('#room-ai-page');
  const roomWorkspace = rs.panel.querySelector('#room-workspace');
  if (roomChat) roomChat.hidden = true;
  if (roomWorkspace) roomWorkspace.hidden = true;
  if (roomAiPage) roomAiPage.hidden = false;
}

function showRoomChatPage() {
  if (!rs.panel) return;
  const roomChat = rs.panel.querySelector('#room-chat');
  const roomAiPage = rs.panel.querySelector('#room-ai-page');
  const roomWorkspace = rs.panel.querySelector('#room-workspace');
  if (roomAiPage) roomAiPage.hidden = true;
  if (roomWorkspace) roomWorkspace.hidden = true;
  if (roomChat) roomChat.hidden = false;
}

function isNewAgentRoom(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return true;
  if (messages.length > 1) return false;

  const [firstMessage] = messages;
  if (!firstMessage) return true;

  return firstMessage.sender_type === 'system'
    && typeof firstMessage.content === 'string'
    && /created/i.test(firstMessage.content);
}

// Ensure the function is exportable
export { refreshRoomsList };
