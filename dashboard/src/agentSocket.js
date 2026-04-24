import { decode as msgpackDecode } from '@msgpack/msgpack';
import { getAccessToken, isAuthenticated, submitReworkDecision } from './authClient.js';
import { rs, sanitizeClassToken } from './roomsUtils.js';
import { showToast } from './utils.js';
import { renderAgentMembers } from './roomsUI.js';
import { appendAgentRoomMessage, appendSkillEvent } from './roomChat.js';
import {
  refreshAgentFiles, openAgentFile, renderConnectionState, renderAgentProgress, renderAgentLogs,
   
} from './agentWorkspace.js';
import { setAgentTypingStatus, setAgentActivity, clearAllTypingIndicators } from './agentTypingIndicator.js';
import { extractHandoffsFromMessage } from './agentHandoffViz.js';
import { addRealtimeTokenUsage } from './agentTokenUsage.js';
import { handleXbProgress, clearXbProgress } from './xbProgressBar.js';

export function closeAgentSocket() {
  if (rs.agentRoomReconnectTimer) {
    clearTimeout(rs.agentRoomReconnectTimer);
    rs.agentRoomReconnectTimer = null;
  }
  if (rs.agentSocket) {
    rs.agentSocket.close();
    rs.agentSocket = null;
  }
  rs.agentRoomConnectionState = rs.currentAgentRoomId ? 'offline' : 'idle';
}

const RECONNECT_BASE_MS = 1500;
const RECONNECT_MAX_MS = 30000;
let reconnectAttempt = 0;

export function scheduleAgentReconnect() {
  if (rs.agentRoomReconnectTimer || !rs.currentAgentRoomId || !isAuthenticated()) return;
  rs.agentRoomConnectionState = 'reconnecting';
  renderConnectionState();
  // Exponential backoff: 1.5s → 3s → 6s → 12s → 24s → 30s (cap)
  const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt), RECONNECT_MAX_MS);
  reconnectAttempt++;
  rs.agentRoomReconnectTimer = setTimeout(() => {
    rs.agentRoomReconnectTimer = null;
    connectAgentRoomSocket();
  }, delay);
}

export function connectAgentRoomSocket() {
  closeAgentSocket();
  const token = getAccessToken();
  if (!rs.currentAgentRoomId || !token) return;

  rs.agentRoomConnectionState = 'connecting';
  renderConnectionState();

  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${proto}//${window.location.host}/manager/ws/agent-room?room_id=${encodeURIComponent(rs.currentAgentRoomId)}&token=${encodeURIComponent(token)}`;
  // Request msgpack subprotocol for ~40% smaller payloads and faster decode
  const socket = new WebSocket(wsUrl, ['msgpack']);
  socket.binaryType = 'arraybuffer';
  rs.agentSocket = socket;

  socket.addEventListener('open', () => {
    rs.agentRoomConnectionState = 'connected';
    reconnectAttempt = 0; // Reset backoff on successful connection
    renderConnectionState();
  });

  socket.addEventListener('message', async (event) => {
    let payload;
    try {
      if (event.data instanceof ArrayBuffer) {
        // MessagePack binary frame
        payload = msgpackDecode(new Uint8Array(event.data));
      } else {
        // JSON text frame (fallback)
        payload = JSON.parse(event.data);
      }
    } catch { return; }

    if (payload.type === 'agent_room:message') {
      if (rs.currentRoomMode === 'agent' && payload.message) {
        appendAgentRoomMessage(payload.message);
        extractHandoffsFromMessage(payload.message);
      }
      return;
    }

    if (payload.type === 'agent_room:log' && payload.log) {
      rs.agentRoomLogs = [...rs.agentRoomLogs, payload.log].slice(-200);
      renderAgentLogs();
      return;
    }

    if (payload.type === 'agent_room:agent_status' && rs.currentRoomMode === 'agent') {
      if (payload.agent_name && payload.status) {
        rs.currentAgentMembers = rs.currentAgentMembers.map((a) =>
          a.name === payload.agent_name ? { ...a, status: payload.status } : a
        );
        setAgentTypingStatus(payload.agent_name, payload.status);
        const pill = rs.panel?.querySelector(`[data-agent-edit="${CSS.escape(payload.agent_name)}"]`);
        if (pill) {
          pill.className = pill.className.replace(/\bstatus-\S+/g, '');
          pill.classList.add(`status-${sanitizeClassToken(payload.status)}`);
        } else {
          renderAgentMembers(rs.currentAgentMembers);
        }
      }
      return;
    }

    if (payload.type === 'agent_room:file_changed') {
      rs.agentRoomFileAuthors.set(payload.path, {
        agent_name: payload.agent_name,
        tool: payload.tool,
        timestamp: Date.now(),
      });
      await refreshAgentFiles();
      if (rs.agentRoomSelectedFile === payload.path) {
        await openAgentFile(payload.path);
      }
      return;
    }

    if (payload.type === 'agent_room:skill_used') {
      appendSkillEvent(payload);
      return;
    }

    if (payload.type === 'agent_room:progress') {
      rs.agentRoomProgressTimeline = [...rs.agentRoomProgressTimeline, {
        agent_name: payload.agent_name,
        tools: payload.tools || [],
        artifacts: payload.artifacts || [],
        timestamp: payload.timestamp || Math.floor(Date.now() / 1000),
      }].slice(-50);
      for (const artifact of (payload.artifacts || [])) {
        rs.agentRoomFileAuthors.set(artifact.path, {
          agent_name: artifact.agent_name || payload.agent_name,
          tool: artifact.tool,
          timestamp: Date.now(),
        });
      }
      // Update typing indicator with latest tool activity
      const latestTool = (payload.tools || []).filter((t) => t.status === 'success').pop();
      if (latestTool && payload.agent_name) {
        setAgentActivity(payload.agent_name, latestTool.tool);
      }
      renderAgentProgress();
      return;
    }

    if (payload.type === 'agent_room:xb_progress') {
      handleXbProgress(payload);
      return;
    }

    if (payload.type === 'agent_room:token_usage') {
      if (payload.agent_name && payload.usage) {
        addRealtimeTokenUsage(payload.agent_name, payload.usage);
      }
      return;
    }

    if (payload.type === 'agent_room:confidence') {
      if (payload.agent_name && typeof payload.confidence === 'number') {
        // Update agent confidence in member list
        rs.currentAgentMembers = rs.currentAgentMembers.map((a) =>
          a.name === payload.agent_name ? { ...a, confidence: payload.confidence } : a
        );
        // Update confidence badge on agent pill
        const pill = rs.panel?.querySelector(`[data-agent-edit="${CSS.escape(payload.agent_name)}"]`);
        if (pill) {
          let badge = pill.querySelector('.agent-confidence-badge');
          if (!badge) {
            badge = document.createElement('span');
            badge.className = 'agent-confidence-badge';
            pill.appendChild(badge);
          }
          const pct = Math.round(payload.confidence * 100);
          badge.textContent = `${pct}%`;
          badge.className = `agent-confidence-badge ${pct >= 70 ? 'confidence-high' : pct >= 40 ? 'confidence-mid' : 'confidence-low'}`;
        }
      }
      return;
    }

    if (payload.type === 'agent_room:quality_gate') {
      const emoji = payload.verdict === 'approved' ? '✅' : '🔄';
      const msg = payload.verdict === 'approved'
        ? `${emoji} @${payload.reviewer} approved the implementation`
        : `${emoji} @${payload.reviewer} requested rework (cycle ${payload.cycle})`;
      appendAgentRoomMessage({
        sender_type: 'system',
        sender_name: 'quality-gate',
        content: msg,
        event_type: 'system',
        created_at: payload.timestamp || Math.floor(Date.now() / 1000),
      });
      return;
    }

    if (payload.type === 'agent_room:rework_decision_needed') {
      appendAgentRoomMessage({
        sender_type: 'system',
        sender_name: 'quality-gate',
        content: `⚠️ @${payload.reviewer} requested rework (cycle ${payload.cycle}). What would you like to do?`,
        event_type: 'system',
        created_at: payload.timestamp || Math.floor(Date.now() / 1000),
      });
      showReworkDecisionUI(payload);
      return;
    }

    if (payload.type === 'agent_room:agent_spawned') {
      appendAgentRoomMessage({
        sender_type: 'system',
        sender_name: 'orchestrator',
        content: `🤖 @${payload.spawned_by} spawned new agent @${payload.agent_name} (${payload.role})`,
        event_type: 'system',
        created_at: payload.timestamp || Math.floor(Date.now() / 1000),
      });
      // Add to current members list so the UI updates
      if (rs.currentAgentMembers && !rs.currentAgentMembers.some((m) => m.name === payload.agent_name)) {
        rs.currentAgentMembers.push({
          name: payload.agent_name,
          role: payload.role,
          model_tier: payload.model_tier,
          status: 'idle',
        });
        renderAgentMembers();
      }
      return;
    }

    if (payload.type === 'agent_room:error') {
      showToast(payload.message || 'Agent room error', 'error');
    }
  });

  socket.addEventListener('close', () => {
    if (rs.agentSocket === socket) {
      rs.agentSocket = null;
      rs.agentRoomConnectionState = 'offline';
      clearAllTypingIndicators();
      clearXbProgress();
      renderConnectionState();
      scheduleAgentReconnect();
    }
  });

  socket.addEventListener('error', () => {
    rs.agentRoomConnectionState = 'offline';
    renderConnectionState();
  });
}

/**
 * Show an inline decision UI in the chat when the orchestrator asks the user
 * whether to continue rework, accept as-is, or stop.
 */
function showReworkDecisionUI(payload) {
  const chatContainer = rs.panel?.querySelector('#agent-room-chat');
  if (!chatContainer) return;

  const roomId = rs.currentAgentRoomId;
  if (!roomId) return;

  const wrapper = document.createElement('div');
  wrapper.className = 'rework-decision-bar';
  wrapper.innerHTML = `
    <p class="rework-decision-label">
      @${payload.reviewer || 'reviewer'} requested changes (cycle ${payload.cycle}).
      <br><em>${(payload.review_summary || '').slice(0, 200)}</em>
    </p>
    <div class="rework-decision-actions">
      <button class="rework-btn rework-btn-continue" data-decision="continue">🔄 Continue Rework</button>
      <button class="rework-btn rework-btn-accept" data-decision="accept">✅ Accept As-Is</button>
      <button class="rework-btn rework-btn-stop" data-decision="stop">⏹️ Stop</button>
    </div>
  `;

  for (const btn of wrapper.querySelectorAll('.rework-btn')) {
    btn.addEventListener('click', async () => {
      const decision = btn.dataset.decision;
      wrapper.querySelectorAll('.rework-btn').forEach((b) => { b.disabled = true; });
      btn.classList.add('rework-btn-selected');

      try {
        await submitReworkDecision(roomId, decision);
      } catch (err) {
        showToast('Failed to submit decision', 'error');
      }

      // Fade out the decision bar after a short delay
      setTimeout(() => { wrapper.classList.add('rework-decision-done'); }, 800);
    });
  }

  chatContainer.appendChild(wrapper);
  chatContainer.scrollTop = chatContainer.scrollHeight;
}
