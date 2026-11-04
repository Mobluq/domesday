// Public interface of the processing module. Owns: jobs, stage_runs, frames,
// tracks, proposals (Part 5 pipeline; Part 6 video pipeline mechanics).
import { GPU_STAGES, type PipelineStage } from '@domesday/domain';
import type { Queryable } from '../../platform/db';
import type { ModuleDefinition } from '../../platform/operation';

export interface ProcessingApi {
  /**
   * Queue the first stage after a clip is verified (stage 2, privacy pass). Jobs are
   * keyed by clip, stage and model version, so queuing twice is harmless (DMS-042).
   */
  enqueueAfterVerification(tx: Queryable, input: { tenantId: string; walkId: string; clipId: string }): Promise<{ queuedJobIds: string[] }>;
}

export interface ProcessingConfig {
  /** The pinned model version for each GPU stage. Changing one runs the full benchmark first (Part 5). */
  readonly modelVersions: Readonly<Record<string, string>>;
}

export const DEFAULT_MODEL_VERSIONS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(GPU_STAGES.map((stage) => [stage, `${stage}@fake-0.0.0`])),
);

const FIRST_STAGE: PipelineStage = 'privacy_pass';

export function createProcessingModule(config: ProcessingConfig = { modelVersions: DEFAULT_MODEL_VERSIONS }): {
  definition: ModuleDefinition;
  api: ProcessingApi;
} {
  const api: ProcessingApi = {
    async enqueueAfterVerification(tx, { tenantId, walkId, clipId }) {
      const modelVersion = config.modelVersions[FIRST_STAGE];
      if (!modelVersion) throw new Error(`no model version pinned for ${FIRST_STAGE}`);
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO jobs (tenant_id, walk_id, clip_id, stage, model_version)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT ON CONSTRAINT job_key DO NOTHING
         RETURNING id`,
        [tenantId, walkId, clipId, FIRST_STAGE, modelVersion],
      );
      return { queuedJobIds: rows.map((r) => r.id) };
    },
  };
  return { api, definition: { name: 'processing' } };
}
