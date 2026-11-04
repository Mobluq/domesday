import { ok, type ModuleDefinition } from './operation';

/** Liveness only: it answers without touching the database, so a slow database never makes the process look dead. */
export function createHealthModule(version: string): ModuleDefinition {
  return {
    name: 'platform',
    publicHandlers: {
      getHealth: async ({ now }) => ok({ status: 'ok', service: 'domesday-api', version, time: now.toISOString() }),
    },
  };
}
