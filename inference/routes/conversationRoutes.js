/**
 * Conversation Routes — /api/conversations/*
 * Server-side conversation CRUD for authenticated users.
 */

import {
  saveConversation, getConversation, getUserConversations, deleteConversation,
} from '../db/database.js';
import { sendJson, readBody } from './apiRouter.js';

/**
 * @param {string} path
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @returns {Promise<boolean>}
 */
export async function handleConversationRoute(path, req, res) {
  const userId = req.user.id;

  // GET /api/conversations — list user's conversations
  if (path === '/api/conversations' && req.method === 'GET') {
    const conversations = getUserConversations(userId);
    sendJson(res, 200, { conversations });
    return true;
  }

  // POST /api/conversations — create or update a conversation
  if (path === '/api/conversations' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { id, title, messages, folder_id } = body;

      if (!id) {
        sendJson(res, 400, { error: 'id is required' });
        return true;
      }

      // Check ownership if conversation exists
      const existing = getConversation(id);
      if (existing && existing.user_id !== userId) {
        sendJson(res, 403, { error: 'Not your conversation' });
        return true;
      }

      saveConversation(id, userId, title || 'New Chat', messages || [], folder_id);
      const saved = getConversation(id);
      sendJson(res, existing ? 200 : 201, { conversation: saved });
    } catch (err) {
      sendJson(res, 400, { error: err.message || 'Save failed' });
    }
    return true;
  }

  // GET /api/conversations/:id — get single conversation
  const getMatch = path.match(/^\/api\/conversations\/([^/]+)$/);
  if (getMatch && req.method === 'GET') {
    const conv = getConversation(getMatch[1]);
    if (!conv) {
      sendJson(res, 404, { error: 'Conversation not found' });
      return true;
    }
    if (conv.user_id !== userId) {
      sendJson(res, 403, { error: 'Not your conversation' });
      return true;
    }
    sendJson(res, 200, { conversation: conv });
    return true;
  }

  // DELETE /api/conversations/:id — delete conversation
  const delMatch = path.match(/^\/api\/conversations\/([^/]+)$/);
  if (delMatch && req.method === 'DELETE') {
    const result = deleteConversation(delMatch[1], userId);
    if (result.changes === 0) {
      sendJson(res, 404, { error: 'Conversation not found or not yours' });
      return true;
    }
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}
