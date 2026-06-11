import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import type { Agent, Registry } from './types.ts';

export const rootDir = path.join(import.meta.dirname, '..');
export const agentsDir = path.join(rootDir, 'agents');

export function loadRegistry(filePath = path.join(rootDir, 'registry.yaml')): Registry {
  const raw = parse(readFileSync(filePath, 'utf8')) as {
    agents?: Record<string, { can_be_called_by?: string[]; tools?: string; model?: string }>;
  };
  const agents: Record<string, Agent> = {};
  for (const [name, def] of Object.entries(raw.agents ?? {})) {
    agents[name] = {
      name,
      can_be_called_by: def.can_be_called_by ?? [],
      tools: def.tools ?? '',
      model: def.model,
    };
  }
  return { agents };
}

/** Agents that `caller` may place orders on (the security boundary, from the registry). */
export function callableBy(registry: Registry, caller: string): Agent[] {
  return Object.values(registry.agents).filter((a) => a.can_be_called_by.includes(caller));
}
