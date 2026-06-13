import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';
import { agentsDir } from './registry.ts';
import type { AgentConfig, Registry } from './types.ts';

export type AgentSettings = Record<string, unknown>;

/** On-disk dir for an agent's private settings + context: $DOPPELGANGER_HOME/agents/<agent>. */
export function agentDir(agent: string, baseDir: string = config.agentSettingsDir): string {
  return path.join(baseDir, agent);
}

/**
 * Load an agent's structured settings (settings.json). Missing → {}. Invalid
 * JSON throws on purpose: a half-written settings file should fail loud.
 */
export function loadAgentSettings(agent: string, baseDir: string = config.agentSettingsDir): AgentSettings {
  const file = path.join(agentDir(agent, baseDir), 'settings.json');
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, 'utf8')) as AgentSettings;
}

/**
 * Per-agent config for the dashboard: registry facts (model, tools, callers)
 * merged with the agent's on-disk settings.json. Read fresh per request so
 * edits to settings.json show up without a restart.
 */
export function loadAgentConfigs(
  registry: Registry,
  baseDir: string = config.agentSettingsDir,
): Record<string, AgentConfig> {
  const out: Record<string, AgentConfig> = {};
  for (const [name, agent] of Object.entries(registry.agents)) {
    out[name] = {
      model: agent.model ?? null,
      tools: agent.tools,
      callableBy: agent.can_be_called_by,
      settings: loadAgentSettings(name, baseDir),
    };
  }
  return out;
}

/** Per-agent private prose (context.md). Opt-in: missing → ''. */
export function loadAgentContext(agent: string, baseDir: string = config.agentSettingsDir): string {
  const file = path.join(agentDir(agent, baseDir), 'context.md');
  if (!existsSync(file)) return '';
  return readFileSync(file, 'utf8').trim();
}

/** Shared context for all agents (soul.md). Opt-in: missing → ''. */
export function loadSoul(soulPath: string = config.soulPath): string {
  if (!existsSync(soulPath)) return '';
  return readFileSync(soulPath, 'utf8').trim();
}

/**
 * First-run scaffolding: for each agent that ships a settings.example.json in
 * the repo but has no on-disk settings.json yet, copy the example out to
 * $DOPPELGANGER_HOME. Returns the agents that were freshly scaffolded so the
 * caller can tell the user to fill them in. soul.md / context.md are never
 * scaffolded — they are opt-in and authored by hand.
 */
export function scaffoldAgentSettings(
  agents: string[],
  baseDir: string = config.agentSettingsDir,
  exampleBase: string = agentsDir,
): string[] {
  const created: string[] = [];
  for (const agent of agents) {
    const file = path.join(agentDir(agent, baseDir), 'settings.json');
    const example = path.join(exampleBase, agent, 'settings.example.json');
    if (existsSync(file) || !existsSync(example)) continue;
    mkdirSync(agentDir(agent, baseDir), { recursive: true });
    copyFileSync(example, file);
    created.push(agent);
  }
  return created;
}
