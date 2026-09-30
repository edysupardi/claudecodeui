import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { ProviderModelOption, ProviderModelsDefinition } from '@/shared/types.js';
import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

// Claude Code maps its opus/sonnet/haiku aliases to these env vars, so a project
// that sets them (e.g. to route through a gateway) has exactly these models.
const PROJECT_MODEL_ENV_KEYS = [
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
] as const;

type ProjectModelEnvKey = (typeof PROJECT_MODEL_ENV_KEYS)[number];

/**
 * Reads the `env` block of one Claude settings file.
 *
 * @param filePath - absolute path to a settings.json / settings.local.json
 * @returns the env record, or an empty object when the file is missing or unreadable
 */
async function readSettingsEnv(filePath: string): Promise<Record<string, unknown>> {
  try {
    const settings = readObjectRecord(JSON.parse(await readFile(filePath, 'utf8')));
    return readObjectRecord(settings?.env) ?? {};
  } catch {
    return {};
  }
}

/**
 * Builds the Claude model catalog a project defines in its own settings files.
 *
 * Only model names are read; API keys, base URLs and every other setting are
 * never returned. Files are read on every call on purpose: the models depend on
 * what the user's gateway offers, and edits must show up without a restart.
 *
 * @param projectPath - absolute project root
 * @returns the project-scoped catalog, or null when the project sets none of the model env vars
 */
export async function readClaudeProjectModels(projectPath: string): Promise<ProviderModelsDefinition | null> {
  const claudeDir = path.join(projectPath, '.claude');
  const [sharedEnv, localEnv] = await Promise.all([
    readSettingsEnv(path.join(claudeDir, 'settings.json')),
    readSettingsEnv(path.join(claudeDir, 'settings.local.json')),
  ]);

  // settings.local.json overrides settings.json, matching Claude Code's precedence.
  const models: Partial<Record<ProjectModelEnvKey, string>> = {};
  for (const key of PROJECT_MODEL_ENV_KEYS) {
    const value = readOptionalString(localEnv[key]) ?? readOptionalString(sharedEnv[key]);
    if (value) {
      models[key] = value;
    }
  }

  const options: ProviderModelOption[] = [];
  for (const key of PROJECT_MODEL_ENV_KEYS) {
    const value = models[key];
    if (value && !options.some((option) => option.value === value)) {
      options.push({ value, label: value, isCustom: false });
    }
  }

  if (options.length === 0) {
    return null;
  }

  return {
    OPTIONS: options,
    DEFAULT: models.ANTHROPIC_DEFAULT_SONNET_MODEL
      ?? models.ANTHROPIC_DEFAULT_OPUS_MODEL
      ?? models.ANTHROPIC_DEFAULT_HAIKU_MODEL
      ?? options[0].value,
    projectScoped: true,
  };
}
