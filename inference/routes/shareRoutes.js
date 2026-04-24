/**
 * Share Routes — /api/share/*
 * Create, view, and manage shared chat links.
 */

import {
  createSharedChat, getSharedChat, deleteSharedChat,
  getConversation, getConversationShares,
} from '../db/database.js';
import { sendJson, readBody } from './apiRouter.js';

/**
 * @param {string} path
 * @param {URL} url
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @returns {Promise<boolean>}
 */
export async function handleShareRoute(path, url, req, res) {

  // GET /api/share/:token — public: view a shared chat (no auth required)
  const viewMatch = path.match(/^\/api\/share\/([a-zA-Z0-9]+)$/);
  if (viewMatch && req.method === 'GET') {
    const shared = getSharedChat(viewMatch[1]);
    if (!shared) {
      sendJson(res, 404, { error: 'Shared chat not found or expired' });
      return true;
    }

    // Check expiry
    if (shared.expires_at && shared.expires_at < Math.floor(Date.now() / 1000)) {
      sendJson(res, 410, { error: 'This shared link has expired' });
      return true;
    }

    sendJson(res, 200, {
      title: shared.title,
      messages: shared.messages,
      shared_by: shared.shared_by_username,
      access_level: shared.access_level,
      created_at: shared.created_at,
    });
    return true;
  }

  // ── Protected routes below (req.user must exist) ─────────────
  if (!req.user) {
    sendJson(res, 401, { error: 'Authentication required' });
    return true;
  }

  const userId = req.user.id;

  // POST /api/share — create a share link for a conversation
  if (path === '/api/share' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { conversation_id, access_level, expires_in_hours } = body;

      if (!conversation_id) {
        sendJson(res, 400, { error: 'conversation_id is required' });
        return true;
      }

      // Verify ownership
      const conv = getConversation(conversation_id);
      if (!conv) {
        sendJson(res, 404, { error: 'Conversation not found' });
        return true;
      }
      if (conv.user_id !== userId) {
        sendJson(res, 403, { error: 'Not your conversation' });
        return true;
      }

      const expiresAt = expires_in_hours
        ? Math.floor(Date.now() / 1000) + (expires_in_hours * 3600)
        : null;

      const result = createSharedChat(
        conversation_id,
        userId,
        access_level || 'read',
        expiresAt,
      );

      sendJson(res, 201, {
        share_token: result.shareToken,
        share_url: `/shared/${result.shareToken}`,
        access_level: access_level || 'read',
        expires_at: expiresAt,
      });
    } catch (err) {
      sendJson(res, 400, { error: err.message || 'Failed to create share' });
    }
    return true;
  }

  // GET /api/share/conversation/:id — list shares for a conversation
  const listMatch = path.match(/^\/api\/share\/conversation\/([^/]+)$/);
  if (listMatch && req.method === 'GET') {
    const conv = getConversation(listMatch[1]);
    if (!conv || conv.user_id !== userId) {
      sendJson(res, 403, { error: 'Not your conversation' });
      return true;
    }
    const shares = getConversationShares(listMatch[1]);
    sendJson(res, 200, { shares });
    return true;
  }

  // DELETE /api/share/:id — revoke a share
  const deleteMatch = path.match(/^\/api\/share\/([^/]+)$/);
  if (deleteMatch && req.method === 'DELETE') {
    const result = deleteSharedChat(deleteMatch[1], userId);
    if (result.changes === 0) {
      sendJson(res, 404, { error: 'Share not found or not yours' });
      return true;
    }
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}
