import { describe, test, expect } from 'bun:test';
import {
  startXbTask,
  updateXbStep,
  recordXbToolCall,
  completeXbTask,
  failXbTask,
  getXbProgress,
  getXbProgressSummary,
  getActiveXbTasks,
  cleanupXbTasks,
} from './progressStore.js';

describe('progressStore', () => {
  const roomId = 'test-room-' + Date.now();
  const agentName = 'coder';

  test('startXbTask creates a working entry', () => {
    startXbTask(roomId, agentName, 'Analyzing request...');
    const p = getXbProgress(roomId, agentName);
    expect(p).not.toBeNull();
    expect(p.status).toBe('working');
    expect(p.step).toBe('Analyzing request...');
    expect(p.toolCalls).toEqual([]);
  });

  test('updateXbStep updates the step description', () => {
    updateXbStep(roomId, agentName, 'Reading files...');
    const p = getXbProgress(roomId, agentName);
    expect(p.step).toBe('Reading files...');
  });

  test('recordXbToolCall adds a tool call entry', () => {
    recordXbToolCall(roomId, agentName, 'read_file', 'success');
    recordXbToolCall(roomId, agentName, 'write_file', 'running');
    const p = getXbProgress(roomId, agentName);
    expect(p.toolCalls.length).toBe(2);
    expect(p.toolCalls[0].tool).toBe('read_file');
    expect(p.toolCalls[1].tool).toBe('write_file');
  });

  test('getActiveXbTasks returns working tasks', () => {
    const active = getActiveXbTasks(roomId);
    expect(active.length).toBe(1);
    expect(active[0].agentName).toBe(agentName);
  });

  test('getXbProgressSummary returns a human-readable string for working task', () => {
    const summary = getXbProgressSummary(roomId, agentName);
    expect(summary).toContain('Working for');
    expect(summary).toContain('Reading files...');
    expect(summary).toContain('2 tool calls');
  });

  test('completeXbTask marks the task as done', () => {
    completeXbTask(roomId, agentName, 'File created successfully');
    const p = getXbProgress(roomId, agentName);
    expect(p.status).toBe('done');
    expect(p.result).toBe('File created successfully');
  });

  test('getXbProgressSummary returns completion info for done task', () => {
    const summary = getXbProgressSummary(roomId, agentName);
    expect(summary).toContain('Task completed');
    expect(summary).toContain('2 tool calls');
  });

  test('getActiveXbTasks excludes completed tasks', () => {
    const active = getActiveXbTasks(roomId);
    expect(active.length).toBe(0);
  });

  test('failXbTask marks the task as error', () => {
    const room2 = 'test-room-fail-' + Date.now();
    startXbTask(room2, 'reviewer', 'Checking code...');
    failXbTask(room2, 'reviewer', 'Model timeout');
    const p = getXbProgress(room2, 'reviewer');
    expect(p.status).toBe('error');
    expect(p.error).toBe('Model timeout');
    const summary = getXbProgressSummary(room2, 'reviewer');
    expect(summary).toContain('Task failed');
    expect(summary).toContain('Model timeout');
  });

  test('getXbProgress returns null for unknown room/agent', () => {
    expect(getXbProgress('nonexistent', 'nobody')).toBeNull();
  });

  test('getXbProgressSummary returns "No active task." for unknown', () => {
    expect(getXbProgressSummary('nonexistent', 'nobody')).toBe('No active task.');
  });
});
