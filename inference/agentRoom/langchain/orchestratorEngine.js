import { EventEmitter } from 'events';

import {
  createAgentRoomAgent,
  getAgentRoom,
  getAgentRoomAgent,
  getAgentRoomMemory,
  listAgentRoomAgents,
  listAgentRoomMessages,
  listRoomSkills,
  saveAgentRoomLog,
  saveAgentRoomMemory,
  saveAgentRoomMessage,
  saveAgentRoomTokenUsage,
  touchAgentRoom,
  updateAgentRoomAgentStatus,
} from '../../db/database.js';
import { listFiles } from '../fileTools.js';
import { broadcastAgentRoomEvent } from '../wsBridge.js';
import { runReactiveAgentTurn, runSimpleAgentTurn, runProgressCheckTurn, shouldAgentRespond, isSimpleQuery, classifyWithRouter } from './reactiveAgent.js';
import { startXbTask, updateXbStep, recordXbToolCall, completeXbTask, failXbTask, cleanupXbTasks } from '../progressStore.js';

const DEFAULT_AUTONOMY_LEVEL = 2;
const MAX_VISIBLE_HISTORY = 40;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function buildToolLogMeta(toolResult) {
  const meta = {
    tool: toolResult.tool,
  };

  if (toolResult.params?.path) {
    meta.path = toolResult.params.path;
  }
  if (toolResult.tool === 'list_files') {
    meta.path = toolResult.params?.path || '.';
  }
  if (typeof toolResult.result === 'string') {
    meta.result_bytes = Buffer.byteLength(toolResult.result);
  }
  if (Array.isArray(toolResult.result)) {
    meta.result_count = toolResult.result.length;
  }
  if (typeof toolResult.params?.content === 'string') {
    meta.input_bytes = Buffer.byteLength(toolResult.params.content);
  }
  if (typeof toolResult.params?.new_str === 'string') {
    meta.input_bytes = Buffer.byteLength(toolResult.params.new_str);
  }

  // Skill tool metadata
  if (toolResult.tool === 'search_skills') {
    meta.query = toolResult.params?.query || '';
    try {
      const parsed = typeof toolResult.result === 'string' ? JSON.parse(toolResult.result) : toolResult.result;
      meta.result_count = parsed?.results?.length || 0;
      meta.total = parsed?.total || 0;
      meta.top_skills = (parsed?.results || []).slice(0, 3).map((r) => r.id);
    } catch { /* ignore */ }
  }
  if (toolResult.tool === 'read_skill') {
    meta.skill_id = toolResult.params?.skill_id || '';
    meta.file_path = toolResult.params?.file_path || 'SKILL.md';
    try {
      const parsed = typeof toolResult.result === 'string' ? JSON.parse(toolResult.result) : toolResult.result;
      meta.skill_name = parsed?.name || meta.skill_id;
      meta.truncated = parsed?.truncated || false;
    } catch { /* ignore */ }
  }
  if (toolResult.tool === 'list_skill_files') {
    meta.skill_id = toolResult.params?.skill_id || '';
    meta.skill_path = toolResult.params?.path || '.';
    try {
      const parsed = typeof toolResult.result === 'string' ? JSON.parse(toolResult.result) : toolResult.result;
      meta.result_count = parsed?.entries?.length || 0;
    } catch { /* ignore */ }
  }

  return meta;
}

const SKILL_TOOL_NAMES = new Set(['search_skills', 'read_skill', 'list_skill_files']);

export function getRoomOrchestrationConfig(room) {
  const mode = room?.orchestration_mode === 'legacy' ? 'legacy' : 'reactive';
  const autonomyLevel = clamp(Number(room?.autonomy_level ?? DEFAULT_AUTONOMY_LEVEL), 0, 3);

  return {
    mode,
    autonomyLevel,
    maxCycles: mode === 'legacy' ? 4 : 8 + (autonomyLevel * 4),
    maxAgentsPerCycle: mode === 'legacy' ? 1 : clamp(autonomyLevel + 1, 1, 4),
    maxTurnsPerAgent: mode === 'legacy' ? 1 : clamp(autonomyLevel + 1, 2, 5),
  };
}

function getMentionedAgentNames(agents, content) {
  const validNames = new Set(agents.map((agent) => agent.name.toLowerCase()));
  const matches = [...String(content || '').toLowerCase().matchAll(/@([a-z][a-z0-9_-]{1,31})/g)];
  const seen = new Set();
  const mentioned = [];

  for (const match of matches) {
    const name = match[1];
    if (!validNames.has(name) || seen.has(name)) {
      continue;
    }
    seen.add(name);
    mentioned.push(name);
  }

  return mentioned;
}

export function getMissingHandoffMessages({ senderName, postedMessages, handoffs, agents }) {
  const existingHandoffTargets = new Set(
    postedMessages
      .filter((message) => message.event_type === 'handoff')
      .flatMap((message) => getMentionedAgentNames(agents, message.content)),
  );
  const existingHandoffContents = new Set(
    postedMessages
      .filter((message) => message.event_type === 'handoff')
      .map((message) => String(message.content || '').trim())
      .filter(Boolean),
  );

  const missingMessages = [];
  const queuedContents = new Set();
  const queuedAgentNames = new Set();

  for (const handoff of handoffs || []) {
    const agentName = String(handoff?.agentName || '').toLowerCase();
    const content = String(handoff?.message || '').trim();
    if (!agentName || !content) {
      continue;
    }

    // Deduplicate by target agent name AND by content
    if (existingHandoffTargets.has(agentName) || existingHandoffContents.has(content) || queuedContents.has(content) || queuedAgentNames.has(agentName)) {
      continue;
    }

    missingMessages.push({
      sender_type: 'agent',
      sender_name: senderName,
      content: `@${agentName} Continue the delegated room task from @${senderName}. Use the latest user request, room context, and workspace files relevant to your role.`,
      event_type: 'handoff',
      created_at: nowUnix(),
    });
    queuedContents.add(content);
    queuedAgentNames.add(agentName);
  }

  return missingMessages;
}

function allowsReactiveFollowUp(triggerMessage) {
  if (triggerMessage.sender_type === 'user') {
    return true;
  }

  return ['handoff', 'proposal_response'].includes(triggerMessage.event_type);
}

// ── Quality Gate ──────────────────────────────────────────────
// Detect whether a reviewer message approves or requests rework.
// First rework is auto-approved; subsequent ones ask the user.
const AUTO_REWORK_LIMIT = 1;

function detectReviewVerdict(message) {
  if (message.sender_type !== 'agent') return null;
  const content = String(message.content || '').toLowerCase();
  const senderName = String(message.sender_name || '').toLowerCase();

  // Only reviewer-like agents produce verdicts
  if (!senderName.includes('review')) return null;

  const approvalPatterns = [
    /\bapproved?\b/, /\blgtm\b/, /\blooks good\b/, /\bno issues\b/,
    /\ball good\b/, /\bship it\b/, /\bready to merge\b/, /\bwell done\b/,
    /\bno changes needed\b/, /\bapproval\b/,
  ];
  const rejectionPatterns = [
    /\bneeds? (fix|change|update|rework)\b/, /\bplease fix\b/, /\bcritical\b.*\bissue\b/,
    /\b@coder\b.*\bfix\b/, /\brework\b/, /\brejected?\b/, /\bnot approved\b/,
    /\bchanges? (required|needed|requested)\b/,
  ];

  const isApproval = approvalPatterns.some((p) => p.test(content));
  const isRejection = rejectionPatterns.some((p) => p.test(content));

  if (isRejection && !isApproval) return 'rework';
  if (isApproval && !isRejection) return 'approved';
  // Ambiguous — if mentions @coder, treat as rework request
  if (content.includes('@coder')) return 'rework';
  return null;
}

export function selectReactingAgents({ agents, triggerMessage, roomConfig, responseCounts = new Map() }) {
  const mentionedAgentNames = getMentionedAgentNames(agents, triggerMessage.content);
  const targetAgentNames = triggerMessage.event_type === 'handoff'
    ? mentionedAgentNames.slice(0, 1)
    : mentionedAgentNames;
  const triggerSender = String(triggerMessage.sender_name || '').toLowerCase();

  if (!allowsReactiveFollowUp(triggerMessage)) {
    return [];
  }

  let candidates = agents
    .filter((agent) => agent.name.toLowerCase() !== triggerSender)
    .map((agent) => ({
      agent,
      decision: shouldAgentRespond(agent, triggerMessage, { agents }),
    }))
    .filter(({ agent, decision }) => {
      if (!decision.respond) return false;
      return (responseCounts.get(agent.name.toLowerCase()) || 0) < roomConfig.maxTurnsPerAgent;
    });

  if (roomConfig.mode === 'legacy') {
    if (targetAgentNames.length > 0) {
      candidates = candidates.filter(({ agent }) => targetAgentNames.includes(agent.name.toLowerCase()));
    } else if (triggerMessage.sender_type === 'user') {
      candidates = candidates.filter(({ agent }) => agent.name.toLowerCase() === 'planner');
    } else {
      candidates = [];
    }
  } else if (targetAgentNames.length > 0) {
    candidates = candidates.filter(({ agent }) => targetAgentNames.includes(agent.name.toLowerCase()));
  }

  if (triggerMessage.sender_type === 'user' && candidates.length === 0) {
    const planner = agents.find((agent) => agent.name.toLowerCase() === 'planner');
    if (planner && (responseCounts.get('planner') || 0) < roomConfig.maxTurnsPerAgent) {
      candidates = [{
        agent: planner,
        decision: { respond: true, reason: 'planner_fallback', priority: 0.5 },
      }];
    }
  }

  return candidates
    .sort((left, right) => right.decision.priority - left.decision.priority)
    .slice(0, roomConfig.maxAgentsPerCycle);
}

function buildAgentInput(triggerMessage) {
  const senderLabel = triggerMessage.sender_type === 'user'
    ? `user ${triggerMessage.sender_name}`
    : `@${triggerMessage.sender_name}`;
  const eventLabel = triggerMessage.event_type && triggerMessage.event_type !== 'message'
    ? ` (${triggerMessage.event_type})`
    : '';

  return [
    `New room message from ${senderLabel}${eventLabel}:`,
    triggerMessage.content,
    '',
    'Respond only if your role should contribute. If you delegate, mention the target agent explicitly.',
  ].join('\n');
}

export class LangChainAgentRoomOrchestrator extends EventEmitter {
  constructor() {
    super();
    this.roomQueues = new Map();
    /** @type {Map<string, {resolve: Function, reject: Function}>} roomId → pending decision */
    this.pendingReworkDecisions = new Map();

    // Periodic cleanup of old xb progress entries (every 5 minutes)
    this._cleanupInterval = setInterval(() => cleanupXbTasks(), 5 * 60 * 1000);
    if (this._cleanupInterval.unref) this._cleanupInterval.unref();
  }

  /**
   * Called by the API route when the user responds to a rework decision prompt.
   * @param {string} roomId
   * @param {'continue'|'accept'|'stop'} decision
   */
  resolveReworkDecision(roomId, decision) {
    const pending = this.pendingReworkDecisions.get(roomId);
    if (pending) {
      this.pendingReworkDecisions.delete(roomId);
      pending.resolve(decision);
    }
  }

  /**
   * Wait for user to decide on a rework request. Emits a WebSocket event
   * and returns a Promise that resolves when the user responds.
   * Times out after 5 minutes with 'accept' (don't block forever).
   */
  async waitForReworkDecision(roomId, reviewerName, cycle, reviewContent) {
    this.emitRoomEvent(roomId, 'agent_room:rework_decision_needed', {
      reviewer: reviewerName,
      cycle,
      review_summary: String(reviewContent || '').slice(0, 500),
      timestamp: nowUnix(),
    });

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingReworkDecisions.delete(roomId);
        resolve('accept'); // Default: accept as-is after timeout
      }, 5 * 60 * 1000);

      this.pendingReworkDecisions.set(roomId, {
        resolve: (decision) => {
          clearTimeout(timeout);
          resolve(decision);
        },
      });
    });
  }

  enqueueRoomTask(roomId, task) {
    const previous = this.roomQueues.get(roomId) || Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(task)
      .finally(() => {
        if (this.roomQueues.get(roomId) === next) {
          this.roomQueues.delete(roomId);
        }
      });
    this.roomQueues.set(roomId, next);
    return next;
  }

  emitRoomEvent(roomId, type, payload = {}) {
    this.emit(type, { roomId, ...payload });
    broadcastAgentRoomEvent(roomId, type, payload);
  }

  postAgentMessage(roomId, senderName, content, eventType = 'message', { artifacts = [] } = {}) {
    const text = String(content || '').trim();
    if (!text) return null;

    const message = {
      sender_type: 'agent',
      sender_name: senderName,
      content: text,
      event_type: eventType,
      created_at: nowUnix(),
      artifacts: artifacts.length > 0 ? artifacts : undefined,
    };

    saveAgentRoomMessage(roomId, 'agent', senderName, text, eventType, artifacts.length > 0 ? artifacts : null);
    this.emitRoomEvent(roomId, 'agent_room:message', { message });
    return message;
  }

  async handleUserMessage(roomId, user, content) {
    const room = getAgentRoom(roomId);
    if (!room) {
      throw new Error('Agent room not found');
    }

    const triggerMessage = {
      sender_type: 'user',
      sender_name: user.username,
      content,
      event_type: 'message',
      created_at: nowUnix(),
    };

    saveAgentRoomMessage(roomId, 'user', user.username, content, 'message');
    this.emitRoomEvent(roomId, 'agent_room:message', { message: triggerMessage });

    return this.enqueueRoomTask(roomId, async () => {
      await this.processTriggerQueue(roomId, triggerMessage);
      touchAgentRoom(roomId);
    });
  }

  async processTriggerQueue(roomId, initialTrigger) {
    const room = getAgentRoom(roomId);
    if (!room) {
      throw new Error('Agent room not found');
    }

    const roomConfig = getRoomOrchestrationConfig(room);
    const triggerQueue = [initialTrigger];
    const responseCounts = new Map();
    let cycles = 0;
    let reworkCycles = 0;

    while (triggerQueue.length > 0 && cycles < roomConfig.maxCycles) {
      // ── Parallel Wave: batch independent triggers targeting different agents ──
      const wave = [];
      const waveAgentNames = new Set();

      // Always take the first trigger
      const firstTrigger = triggerQueue.shift();
      const agents = listAgentRoomAgents(roomId, { includeSecrets: true });
      const firstCandidates = selectReactingAgents({
        agents,
        triggerMessage: firstTrigger,
        roomConfig,
        responseCounts,
      });
      for (const c of firstCandidates) {
        const name = c.agent.name.toLowerCase();
        if (!waveAgentNames.has(name)) {
          waveAgentNames.add(name);
          wave.push({ agent: c.agent, input: buildAgentInput(firstTrigger), triggerContent: firstTrigger.content });
        }
      }

      // Greedily pull more triggers from the queue if they target different agents
      let i = 0;
      while (i < triggerQueue.length && wave.length < roomConfig.maxAgentsPerCycle) {
        const nextCandidates = selectReactingAgents({
          agents,
          triggerMessage: triggerQueue[i],
          roomConfig,
          responseCounts,
        });
        const independent = nextCandidates.filter((c) => !waveAgentNames.has(c.agent.name.toLowerCase()));
        if (independent.length > 0) {
          const nextInput = buildAgentInput(triggerQueue[i]);
          const nextTriggerContent = triggerQueue[i].content;
          for (const c of independent) {
            if (wave.length >= roomConfig.maxAgentsPerCycle) break;
            waveAgentNames.add(c.agent.name.toLowerCase());
            wave.push({ agent: c.agent, input: nextInput, triggerContent: nextTriggerContent });
          }
          triggerQueue.splice(i, 1);
        } else {
          i += 1;
        }
      }

      if (wave.length === 0) {
        cycles += 1;
        continue;
      }

      const results = await Promise.allSettled(
        wave.map(({ agent, input, triggerContent }) => this.runAgentTurn(roomId, agent.name, input, triggerContent)),
      );

      for (const result of results) {
        if (result.status !== 'fulfilled') continue;

        const count = responseCounts.get(result.value.agentName) || 0;
        responseCounts.set(result.value.agentName, count + 1);

        let triggeredRework = false;
        for (const message of result.value.postedMessages) {
          // ── Quality Gate: detect reviewer verdict ──
          const verdict = detectReviewVerdict(message);
          if (verdict === 'approved') {
            this.emitRoomEvent(roomId, 'agent_room:quality_gate', {
              verdict: 'approved',
              reviewer: message.sender_name,
              cycle: reworkCycles,
              timestamp: nowUnix(),
            });
          } else if (verdict === 'rework') {
            reworkCycles += 1;

            this.emitRoomEvent(roomId, 'agent_room:quality_gate', {
              verdict: 'rework',
              reviewer: message.sender_name,
              cycle: reworkCycles,
              timestamp: nowUnix(),
            });

            // Auto-approve first N rework cycles; ask user for subsequent ones
            let shouldRework = reworkCycles <= AUTO_REWORK_LIMIT;
            if (!shouldRework) {
              const decision = await this.waitForReworkDecision(
                roomId, message.sender_name, reworkCycles, message.content,
              );
              if (decision === 'continue') {
                shouldRework = true;
              } else if (decision === 'stop') {
                // User wants to stop entirely — clear the trigger queue
                triggerQueue.length = 0;
                break;
              }
              // 'accept' — skip rework, continue processing remaining messages
            }

            if (shouldRework) {
              triggeredRework = true;
              // Inject a rework handoff to coder if not already present
              const hasCoderfHandoff = message.content.toLowerCase().includes('@coder');
              if (!hasCoderfHandoff) {
                const reworkMessage = {
                  sender_type: 'agent',
                  sender_name: message.sender_name,
                  content: `@coder Please address the review feedback above and fix the issues found. This is rework cycle ${reworkCycles}.`,
                  event_type: 'handoff',
                  created_at: nowUnix(),
                };
                saveAgentRoomMessage(roomId, 'agent', message.sender_name, reworkMessage.content, 'handoff');
                this.emitRoomEvent(roomId, 'agent_room:message', { message: reworkMessage });
                triggerQueue.push(reworkMessage);
              }
            }
          }

          triggerQueue.push(message);
        }

        // Don't count rework-triggered turns against the agent's budget.
        // Rework is a quality mechanism, not a voluntary response.
        if (triggeredRework) {
          const reworkTarget = 'coder';
          const currentCount = responseCounts.get(reworkTarget) || 0;
          if (currentCount > 0) {
            responseCounts.set(reworkTarget, currentCount - 1);
          }
        }
      }

      cycles += 1;
    }
  }

  async runAgentTurn(roomId, agentName, input, triggerContent = '') {
    const room = getAgentRoom(roomId);
    if (!room) {
      throw new Error('Agent room not found');
    }

    const agent = getAgentRoomAgent(roomId, agentName, { includeSecrets: true });
    if (!agent) {
      saveAgentRoomLog(roomId, 'system', 'warning', `Unknown agent mentioned: ${agentName}`);
      this.emitRoomEvent(roomId, 'agent_room:log', {
        log: {
          agent_name: 'system',
          level: 'warning',
          message: `Unknown agent mentioned: ${agentName}`,
          created_at: nowUnix(),
          meta: {},
        },
      });
      return { agentName, handoffs: [], postedMessages: [] };
    }

    updateAgentRoomAgentStatus(roomId, agent.name, 'running');
    this.emitRoomEvent(roomId, 'agent_room:agent_status', {
      agent_name: agent.name,
      status: 'running',
    });

    const postedMessages = [];

    try {
      const workspaceEntries = await listFiles(room.workspace_path, '.', 3).catch(() => []);
      const workspaceListing = workspaceEntries
        .slice(0, 80)
        .map((entry) => `${entry.type === 'directory' ? '[dir]' : '[file]'} ${entry.path}`)
        .join('\n');
      const messages = listAgentRoomMessages(roomId, MAX_VISIBLE_HISTORY);
      const privateMemory = getAgentRoomMemory(roomId, agent.name)?.memory_text || '';
      const agents = listAgentRoomAgents(roomId, { includeSecrets: true });

      // Load room-assigned skills (used as filter for skill tools)
      const roomSkills = listRoomSkills(roomId);
      const allowedSkillIds = roomSkills.map((s) => s.skill_id);

      // ── xa Router Classification ──────────────────────────────
      // Use the xa (router) model to classify: CHAT → fast-path, PROGRESS → report, DELEGATE → full ReAct.
      // Falls back to JS heuristic if no router_config is set.
      const classification = await classifyWithRouter(agent, triggerContent, roomId);
      const useSimplePath = classification === 'chat';
      const useProgressPath = classification === 'progress';

      // Log the classification path
      const pathLabel = useProgressPath ? 'Progress check' : useSimplePath ? 'Simple query fast-path' : 'Started work on a room task';
      saveAgentRoomLog(roomId, agent.name, 'info', pathLabel, {
        source: 'room_message',
        classification,
        fast_path: useSimplePath || useProgressPath,
      });
      this.emitRoomEvent(roomId, 'agent_room:log', {
        log: {
          agent_name: agent.name,
          level: 'info',
          message: pathLabel,
          created_at: nowUnix(),
          meta: { source: 'room_message', classification, fast_path: useSimplePath || useProgressPath },
        },
      });

      let result;
      if (useProgressPath) {
        // xa reports xb's progress — no xb invocation needed
        result = await runProgressCheckTurn({
          agent,
          roomContext: { roomId, roomName: room.name, agents },
          input,
          conversationHistory: messages,
        });
      } else if (useSimplePath) {
        // xa handles directly — no xb invocation needed
        result = await runSimpleAgentTurn({
          agent,
          roomContext: { roomId, roomName: room.name, agents },
          input,
          conversationHistory: messages,
        });
      } else {
        // ── Fire-and-forget xb with progress tracking ────────
        const hasRouterModel = agent.router_config && Object.keys(agent.router_config).length > 0;

        // 1. xa sends immediate acknowledgment
        if (hasRouterModel) {
          try {
            const ackResult = await runSimpleAgentTurn({
              agent,
              roomContext: { roomId, roomName: room.name, agents },
              input: `The user asked: "${triggerContent}"\nYou are delegating this to the deep-work model which will handle it. Send a brief, honest acknowledgment (1 sentence max). Be clear you're about to work on it, NOT that you've already done it. Examples: "Let me look into that.", "On it, give me a moment.", "I'll work on that now." Do NOT describe what you'll do in detail. Do NOT pretend you've already completed the task.\nIMPORTANT: Reply in the same language the user used. If they wrote in Indonesian, reply in Indonesian (e.g. "Aku kerjain sekarang ya.", "Siap, bentar ya.").`,
              conversationHistory: messages.slice(-2),
            });
            const ackMessage = this.postAgentMessage(roomId, agent.name, ackResult.message || '⏳ On it, give me a moment...', 'message');
            if (ackMessage) postedMessages.push(ackMessage);
          } catch (_ackErr) {
            const ackMessage = this.postAgentMessage(roomId, agent.name, '⏳ On it, give me a moment...', 'message');
            if (ackMessage) postedMessages.push(ackMessage);
          }
        } else {
          // No router model configured — send static fallback ack
          const ackMessage = this.postAgentMessage(roomId, agent.name, '⏳ On it, give me a moment...', 'message');
          if (ackMessage) postedMessages.push(ackMessage);
        }

        // 2. Start progress tracking
        startXbTask(roomId, agent.name, 'Analyzing request...');

        // 3. Fire xb asynchronously — don't await, let it run in background
        const xbRoomContext = {
          roomId,
          roomName: room.name,
          roomDescription: room.description,
          workspacePath: room.workspace_path,
          workspaceListing,
          privateMemory,
          agents,
          allowedSkillIds: allowedSkillIds.length > 0 ? allowedSkillIds : null,
          spawnAgent: async ({ name, role, system_prompt, model_tier, tools }) => {
            const templateAgent = agents.find((a) => a.model_tier === model_tier) || agents[0];
            const providerConfig = templateAgent?.provider_config || {};
            const routerConfig = templateAgent?.router_config || {};
            createAgentRoomAgent(roomId, name, role, model_tier, system_prompt, tools, providerConfig, routerConfig);
            this.emitRoomEvent(roomId, 'agent_room:agent_spawned', {
              agent_name: name,
              role,
              model_tier,
              tools,
              spawned_by: agent.name,
              timestamp: nowUnix(),
            });
          },
        };

        // Fire-and-forget: xb runs in background, posts its own results
        this._runXbBackground(roomId, agent, xbRoomContext, input, messages).catch((err) => {
          console.error(`[${agent.name}] xb background failed:`, err.message);
        });

        // Return immediately — xa already sent ack, xb will post when done
        return {
          agentName: agent.name.toLowerCase(),
          handoffs: [],
          postedMessages,
        };
      }

      const actionErrors = [];
      const fileArtifacts = [];
      const toolProgress = [];

      for (const toolResult of result.toolResults) {
        const progressEntry = {
          tool: toolResult.tool,
          path: toolResult.params?.path || null,
          status: toolResult.error ? 'error' : 'success',
          timestamp: nowUnix(),
        };
        toolProgress.push(progressEntry);

        if (toolResult.error) {
          const sanitizedError = 'Tool execution failed';
          actionErrors.push({
            tool: toolResult.tool,
            message: sanitizedError,
            path: toolResult.params?.path || null,
          });
          saveAgentRoomLog(roomId, agent.name, 'error', `Failed ${toolResult.tool}`, {
            tool: toolResult.tool,
            path: toolResult.params?.path || null,
            error: sanitizedError,
          });
          this.emitRoomEvent(roomId, 'agent_room:log', {
            log: {
              agent_name: agent.name,
              level: 'error',
              message: `Failed ${toolResult.tool}`,
              created_at: nowUnix(),
              meta: {
                tool: toolResult.tool,
                path: toolResult.params?.path || null,
                error: sanitizedError,
              },
            },
          });
          continue;
        }

        const logMeta = buildToolLogMeta(toolResult);
        saveAgentRoomLog(roomId, agent.name, 'info', `Executed ${toolResult.tool}`, logMeta);
        this.emitRoomEvent(roomId, 'agent_room:log', {
          log: {
            agent_name: agent.name,
            level: 'info',
            message: `Executed ${toolResult.tool}`,
            created_at: nowUnix(),
            meta: logMeta,
          },
        });

        // Emit skill usage events to room chat
        if (SKILL_TOOL_NAMES.has(toolResult.tool)) {
          this.emitRoomEvent(roomId, 'agent_room:skill_used', {
            agent_name: agent.name,
            tool: toolResult.tool,
            meta: logMeta,
            timestamp: nowUnix(),
          });
        }

        if ((toolResult.tool === 'write_file' || toolResult.tool === 'update_file') && toolResult.params?.path) {
          fileArtifacts.push({
            path: toolResult.params.path,
            tool: toolResult.tool,
            agent_name: agent.name,
            size: logMeta.input_bytes || 0,
          });
          this.emitRoomEvent(roomId, 'agent_room:file_changed', {
            agent_name: agent.name,
            path: toolResult.params.path,
            tool: toolResult.tool,
          });
        }
      }

      // Emit progress summary for this agent turn
      if (toolProgress.length > 0) {
        this.emitRoomEvent(roomId, 'agent_room:progress', {
          agent_name: agent.name,
          tools: toolProgress,
          artifacts: fileArtifacts,
          timestamp: nowUnix(),
        });
      }

      // Track token usage
      if (result.usage && result.usage.total_tokens > 0) {
        saveAgentRoomTokenUsage(roomId, agent.name, result.usage, result.usage.model || '', result.usage.provider || '');
        this.emitRoomEvent(roomId, 'agent_room:token_usage', {
          agent_name: agent.name,
          usage: result.usage,
          timestamp: nowUnix(),
        });
      }

      const finalMessage = this.postAgentMessage(roomId, agent.name, result.message, 'message', { artifacts: fileArtifacts });
      if (finalMessage) postedMessages.push(finalMessage);

      const missingHandoffMessages = getMissingHandoffMessages({
        senderName: agent.name,
        postedMessages,
        handoffs: result.handoffs,
        agents,
      });
      for (const handoffMessage of missingHandoffMessages) {
        const postedHandoff = this.postAgentMessage(roomId, handoffMessage.sender_name, handoffMessage.content, 'handoff');
        if (postedHandoff) {
          postedMessages.push(postedHandoff);
        }
      }

      saveAgentRoomMemory(roomId, agent.name, result.privateMemory);

      updateAgentRoomAgentStatus(roomId, agent.name, 'idle');
      this.emitRoomEvent(roomId, 'agent_room:agent_status', {
        agent_name: agent.name,
        status: 'idle',
      });
      // Emit confidence score
      if (typeof result.confidence === 'number') {
        this.emitRoomEvent(roomId, 'agent_room:confidence', {
          agent_name: agent.name,
          confidence: result.confidence,
          timestamp: nowUnix(),
        });
      }

      this.emitRoomEvent(roomId, 'agent_room:agent_done', {
        agent_name: agent.name,
        handoffs: result.handoffs,
        action_errors: actionErrors,
        confidence: result.confidence,
      });

      return {
        agentName: agent.name.toLowerCase(),
        handoffs: result.handoffs,
        postedMessages,
      };
    } catch (error) {
      saveAgentRoomLog(roomId, agent.name, 'error', 'Agent execution failed');

      const errorMessage = this.postAgentMessage(
        roomId,
        agent.name,
        'I hit an error and could not finish the task.',
        'error',
      );
      if (errorMessage) postedMessages.push(errorMessage);

      updateAgentRoomAgentStatus(roomId, agent.name, 'error');
      this.emitRoomEvent(roomId, 'agent_room:agent_status', {
        agent_name: agent.name,
        status: 'error',
      });
      this.emitRoomEvent(roomId, 'agent_room:error', {
        agent_name: agent.name,
        message: 'Agent execution failed',
      });

      return {
        agentName: agent.name.toLowerCase(),
        handoffs: [],
        postedMessages,
      };
    }
  }

  /**
   * Run xb (deep-work model) in the background. Posts results directly to the room
   * when complete, including tool results, handoffs, and token usage.
   * Called fire-and-forget from runAgentTurn when classification is DELEGATE.
   */
  async _runXbBackground(roomId, agent, roomContext, input, conversationHistory) {
    const bgPostedMessages = [];

    try {
      this.emitRoomEvent(roomId, 'agent_room:xb_progress', {
        agent_name: agent.name,
        step: 'Analyzing request...',
        status: 'started',
        timestamp: nowUnix(),
      });

      const result = await runReactiveAgentTurn({
        agent,
        roomContext,
        input,
        conversationHistory,
        postMessage: async (senderName, content, eventType = 'message') => {
          const message = this.postAgentMessage(roomId, senderName, content, eventType);
          if (message) bgPostedMessages.push(message);
          return message;
        },
        onToolUse: (agentName, toolName, _toolCall) => {
          updateXbStep(roomId, agentName, `Executing ${toolName}...`);
          recordXbToolCall(roomId, agentName, toolName, 'running');
          // Emit real-time progress event to dashboard
          this.emitRoomEvent(roomId, 'agent_room:xb_progress', {
            agent_name: agentName,
            step: `Executing ${toolName}...`,
            tool: toolName,
            timestamp: nowUnix(),
          });
        },
      });

      // ── Process tool results ──────────────────────────────
      const fileArtifacts = [];
      for (const toolResult of result.toolResults) {
        if (toolResult.error) {
          saveAgentRoomLog(roomId, agent.name, 'error', `Failed ${toolResult.tool}`, {
            tool: toolResult.tool,
            path: toolResult.params?.path || null,
          });
          continue;
        }

        const logMeta = buildToolLogMeta(toolResult);
        saveAgentRoomLog(roomId, agent.name, 'info', `Executed ${toolResult.tool}`, logMeta);

        if (SKILL_TOOL_NAMES.has(toolResult.tool)) {
          this.emitRoomEvent(roomId, 'agent_room:skill_used', {
            agent_name: agent.name,
            tool: toolResult.tool,
            meta: logMeta,
            timestamp: nowUnix(),
          });
        }

        if ((toolResult.tool === 'write_file' || toolResult.tool === 'update_file') && toolResult.params?.path) {
          fileArtifacts.push({
            path: toolResult.params.path,
            tool: toolResult.tool,
            agent_name: agent.name,
            size: logMeta.input_bytes || 0,
          });
          this.emitRoomEvent(roomId, 'agent_room:file_changed', {
            agent_name: agent.name,
            path: toolResult.params.path,
            tool: toolResult.tool,
          });
        }
      }

      // ── Token usage ───────────────────────────────────────
      if (result.usage && result.usage.total_tokens > 0) {
        saveAgentRoomTokenUsage(roomId, agent.name, result.usage, result.usage.model || '', result.usage.provider || '');
        this.emitRoomEvent(roomId, 'agent_room:token_usage', {
          agent_name: agent.name,
          usage: result.usage,
          timestamp: nowUnix(),
        });
      }

      // ── Post final message ────────────────────────────────
      const finalMessage = this.postAgentMessage(roomId, agent.name, result.message, 'message', { artifacts: fileArtifacts });
      if (finalMessage) bgPostedMessages.push(finalMessage);

      // ── Handle handoffs ───────────────────────────────────
      const agents = roomContext.agents;
      const missingHandoffMessages = getMissingHandoffMessages({
        senderName: agent.name,
        postedMessages: bgPostedMessages,
        handoffs: result.handoffs,
        agents,
      });
      for (const handoffMessage of missingHandoffMessages) {
        const postedHandoff = this.postAgentMessage(roomId, handoffMessage.sender_name, handoffMessage.content, 'handoff');
        if (postedHandoff) bgPostedMessages.push(postedHandoff);
      }

      // ── Save memory and update status ─────────────────────
      saveAgentRoomMemory(roomId, agent.name, result.privateMemory);
      completeXbTask(roomId, agent.name, result.message?.slice(0, 100) || 'Done');

      this.emitRoomEvent(roomId, 'agent_room:xb_progress', {
        agent_name: agent.name,
        step: 'Done',
        status: 'completed',
        tool_count: result.toolResults.length,
        timestamp: nowUnix(),
      });

      updateAgentRoomAgentStatus(roomId, agent.name, 'idle');
      this.emitRoomEvent(roomId, 'agent_room:agent_status', {
        agent_name: agent.name,
        status: 'idle',
      });
      this.emitRoomEvent(roomId, 'agent_room:agent_done', {
        agent_name: agent.name,
        handoffs: result.handoffs,
        action_errors: [],
        confidence: result.confidence,
      });

      // ── Re-inject handoffs into the room queue ────────────
      // If xb produced handoffs, they need to trigger the next wave.
      // We re-enter processTriggerQueue with the handoff messages as the initial trigger.
      const handoffMessages = bgPostedMessages.filter((m) => m.event_type === 'handoff');
      if (handoffMessages.length > 0) {
        console.log(`[${agent.name}] xb produced ${handoffMessages.length} handoffs, re-injecting...`);
        this.processTriggerQueue(roomId, handoffMessages[0]).catch((err) => {
          console.error(`[${agent.name}] xb handoff re-injection failed:`, err.message);
        });
      }
    } catch (error) {
      failXbTask(roomId, agent.name, error.message);
      saveAgentRoomLog(roomId, agent.name, 'error', 'xb background execution failed');

      const errorMessage = this.postAgentMessage(
        roomId,
        agent.name,
        'I hit an error while working on the task. Please try again.',
        'error',
      );

      updateAgentRoomAgentStatus(roomId, agent.name, 'error');
      this.emitRoomEvent(roomId, 'agent_room:agent_status', {
        agent_name: agent.name,
        status: 'error',
      });
      this.emitRoomEvent(roomId, 'agent_room:error', {
        agent_name: agent.name,
        message: 'xb background execution failed',
      });
    }
  }
}