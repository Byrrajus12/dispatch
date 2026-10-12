import { DEFAULT_MODELS } from '@dispatch-foo/core';
import { describe, expect, it } from 'bun:test';

import {
  backendModel,
  isClaudeModelId,
  pickAgentBackend,
} from '../../src/orchestrator/agentBackends.js';

describe('pickAgentBackend', () => {
  it("uses the default agent's backend when it has one", () => {
    expect(pickAgentBackend(['claude', 'codex'], 'codex')).toBe('codex');
    expect(pickAgentBackend(['claude', 'codex'], 'claude')).toBe('claude');
  });

  it('falls back to Claude, then Codex, for an execute-only default agent', () => {
    expect(pickAgentBackend(['claude', 'codex', 'fake'], 'gemini')).toBe(
      'claude'
    );
    expect(pickAgentBackend(['codex', 'fake'], 'gemini')).toBe('codex');
    expect(pickAgentBackend(['fake'], 'claude')).toBe('fake');
    expect(pickAgentBackend([], 'codex')).toBe('claude');
  });
});

describe('isClaudeModelId', () => {
  it('knows Claude ids and aliases', () => {
    for (const id of [
      'claude-opus-5-5',
      'claude-haiku-4-5-20251001',
      'opus',
      'sonnet',
      'haiku',
      'fable',
    ]) {
      expect(isClaudeModelId(id)).toBe(true);
    }
    for (const id of ['gpt-5.5', 'o4-mini', 'gpt-5.5-codex']) {
      expect(isClaudeModelId(id)).toBe(false);
    }
  });
});

describe('backendModel', () => {
  const config = {
    models: { ...DEFAULT_MODELS },
    executors: {
      codex: { models: { execute: 'gpt-5.5', plan: 'gpt-5.5-mini' } },
    },
  };

  it("keeps today's rule for Claude and every non-Codex backend", () => {
    expect(backendModel(config, 'claude', 'plan', 'claude-sonnet-5-5')).toBe(
      'claude-sonnet-5-5'
    );
    expect(
      backendModel(
        config,
        'claude',
        'plan',
        'claude-sonnet-5-5',
        'claude-fable-5-1'
      )
    ).toBe('claude-fable-5-1');
    expect(backendModel(config, 'fake', 'execute', 'claude-opus-5-5')).toBe(
      'claude-opus-5-5'
    );
  });

  it('gives Codex its own role model, a non-Claude pick, or nothing — never a Claude id', () => {
    expect(backendModel(config, 'codex', 'plan', 'claude-sonnet-5-5')).toBe(
      'gpt-5.5-mini'
    );
    expect(
      backendModel(
        config,
        'codex',
        'execute',
        'claude-opus-5-5',
        'claude-opus-5-5'
      )
    ).toBe('gpt-5.5');
    expect(
      backendModel(config, 'codex', 'execute', 'claude-opus-5-5', 'gpt-5.5-pro')
    ).toBe('gpt-5.5-pro');
    expect(
      backendModel(
        { models: { ...DEFAULT_MODELS }, executors: {} },
        'codex',
        'plan',
        'claude-sonnet-5-5'
      )
    ).toBeUndefined();
  });
});
