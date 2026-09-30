import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readClaudeProjectModels } from '@/modules/providers/list/claude/claude-project-models.js';
import { createProviderModelsService } from '@/modules/providers/services/provider-models.service.js';
import type { ProviderModelsDefinition } from '@/shared/types.js';

const withProject = async (
  files: { shared?: unknown; local?: unknown | string },
  fn: (projectPath: string) => Promise<void>,
) => {
  const projectPath = await mkdtemp(path.join(os.tmpdir(), 'claude-project-models-'));
  try {
    await mkdir(path.join(projectPath, '.claude'));
    if (files.shared !== undefined) {
      await writeFile(path.join(projectPath, '.claude', 'settings.json'), JSON.stringify(files.shared));
    }
    if (files.local !== undefined) {
      const content = typeof files.local === 'string' ? files.local : JSON.stringify(files.local);
      await writeFile(path.join(projectPath, '.claude', 'settings.local.json'), content);
    }
    await fn(projectPath);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
};

test('project models are listed exactly as written, with sonnet as default', async () => {
  await withProject({
    local: {
      env: {
        ANTHROPIC_API_KEY: 'secret-key',
        ANTHROPIC_BASE_URL: 'https://gateway.example.test',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'gw/glm-5',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'gw/kimi-k2',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'gw/qwen-small',
      },
    },
  }, async (projectPath) => {
    const models = await readClaudeProjectModels(projectPath);
    assert.deepEqual(models?.OPTIONS.map((option) => option.value), ['gw/glm-5', 'gw/kimi-k2', 'gw/qwen-small']);
    assert.equal(models?.DEFAULT, 'gw/kimi-k2');
    assert.equal(models?.projectScoped, true);
    // Only model names may leave the server.
    assert.ok(!JSON.stringify(models).includes('secret-key'));
    assert.ok(!JSON.stringify(models).includes('gateway.example.test'));
  });
});

test('only the keys that are set appear, and default falls back opus then haiku', async () => {
  await withProject({ local: { env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'gw/tiny', ANTHROPIC_DEFAULT_OPUS_MODEL: 'gw/big' } } }, async (projectPath) => {
    const models = await readClaudeProjectModels(projectPath);
    assert.deepEqual(models?.OPTIONS.map((option) => option.value), ['gw/big', 'gw/tiny']);
    assert.equal(models?.DEFAULT, 'gw/big');
  });
  await withProject({ local: { env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'gw/tiny' } } }, async (projectPath) => {
    assert.equal((await readClaudeProjectModels(projectPath))?.DEFAULT, 'gw/tiny');
  });
});

test('settings.local.json overrides settings.json per key', async () => {
  await withProject({
    shared: { env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'shared/opus', ANTHROPIC_DEFAULT_SONNET_MODEL: 'shared/sonnet' } },
    local: { env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'local/sonnet' } },
  }, async (projectPath) => {
    const models = await readClaudeProjectModels(projectPath);
    assert.deepEqual(models?.OPTIONS.map((option) => option.value), ['shared/opus', 'local/sonnet']);
  });
});

test('duplicate model names are listed once', async () => {
  await withProject({ local: { env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'gw/same', ANTHROPIC_DEFAULT_SONNET_MODEL: 'gw/same' } } }, async (projectPath) => {
    assert.deepEqual((await readClaudeProjectModels(projectPath))?.OPTIONS.map((option) => option.value), ['gw/same']);
  });
});

test('missing, empty, or malformed settings mean no project models', async () => {
  await withProject({}, async (projectPath) => {
    assert.equal(await readClaudeProjectModels(projectPath), null);
  });
  await withProject({ local: { env: { ANTHROPIC_DEFAULT_OPUS_MODEL: '   ' } } }, async (projectPath) => {
    assert.equal(await readClaudeProjectModels(projectPath), null);
  });
  await withProject({ local: '{ not json' }, async (projectPath) => {
    assert.equal(await readClaudeProjectModels(projectPath), null);
  });
});

test('edits to the settings file show up on the next read without a restart', async () => {
  await withProject({ local: { env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'gw/old' } } }, async (projectPath) => {
    assert.equal((await readClaudeProjectModels(projectPath))?.DEFAULT, 'gw/old');
    await writeFile(
      path.join(projectPath, '.claude', 'settings.local.json'),
      JSON.stringify({ env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'gw/new' } }),
    );
    assert.equal((await readClaudeProjectModels(projectPath))?.DEFAULT, 'gw/new');
  });
});

const globalCatalog: ProviderModelsDefinition = { OPTIONS: [{ value: 'opus', label: 'Opus' }], DEFAULT: 'opus' };
const projectCatalog: ProviderModelsDefinition = {
  OPTIONS: [{ value: 'gw/glm-5', label: 'gw/glm-5' }],
  DEFAULT: 'gw/glm-5',
  projectScoped: true,
};

const createService = (registered: string[]) => createProviderModelsService({
  resolveProvider: () => ({
    models: {
      getSupportedModels: async () => globalCatalog,
      getCurrentActiveModel: async () => ({ model: 'opus' }),
    },
  }) as never,
  catalog: { listCustomProviderModels: () => [] } as never,
  sessions: { getSessionById: () => null, setSessionModel: () => {}, setSessionEffort: () => {} },
  isRegisteredProject: (projectPath) => registered.includes(projectPath),
  readProjectModels: async () => projectCatalog,
});

test('a registered project replaces the Claude catalog with its own models', async () => {
  const models = await createService(['/work/app']).getProviderModels('claude', '/work/app');
  assert.deepEqual(models, projectCatalog);
});

test('an unregistered path is ignored and the global catalog is returned', async () => {
  const models = await createService(['/work/app']).getProviderModels('claude', '/etc');
  assert.equal(models.projectScoped, undefined);
  assert.deepEqual(models.OPTIONS.map((option) => option.value), ['opus']);
});

test('other providers never read project settings', async () => {
  const models = await createService(['/work/app']).getProviderModels('codex', '/work/app');
  assert.equal(models.projectScoped, undefined);
});
