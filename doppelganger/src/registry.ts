import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import type { Agent, Duty, Registry } from './types.ts';

export const rootDir = path.join(import.meta.dirname, '..');
export const agentsDir = path.join(rootDir, 'agents');

export function loadRegistry(filePath = path.join(rootDir, 'registry.yaml')): Registry {
  const raw = parse(readFileSync(filePath, 'utf8')) as {
    agents?: Record<string, { can_be_called_by?: string[]; tools?: string; model?: string; max_concurrency?: number; kind?: string }>;
    duties?: Record<string, { summary?: string; agents?: string[] }>;
  };
  const agents: Record<string, Agent> = {};
  for (const [name, def] of Object.entries(raw.agents ?? {})) {
    agents[name] = {
      name,
      can_be_called_by: def.can_be_called_by ?? [],
      tools: def.tools ?? '',
      model: def.model,
      max_concurrency: def.max_concurrency,
      kind: def.kind === 'orchestrator' ? 'orchestrator' : 'judgment',
    };
  }

  const duties: Record<string, Duty> = {};
  for (const [name, def] of Object.entries(raw.duties ?? {})) {
    const members = def.agents ?? [];
    // A duty owning an agent that doesn't exist is a config bug — fail loud, don't ship a ghost role.
    for (const a of members) {
      if (!agents[a]) throw new Error(`registry: duty '${name}' lists unknown agent '${a}'`);
    }
    duties[name] = { name, summary: def.summary ?? '', agents: members };
  }

  return { agents, duties };
}

/** The duty that owns `agent`, or null when the agent is harness-general (comms / ingress). */
export function dutyOf(registry: Registry, agent: string): string | null {
  return Object.values(registry.duties).find((d) => d.agents.includes(agent))?.name ?? null;
}

/** Agents that `caller` may place orders on (the security boundary, from the registry). */
export function callableBy(registry: Registry, caller: string): Agent[] {
  return Object.values(registry.agents).filter((a) => a.can_be_called_by.includes(caller));
}
