// Public interface of the capture module. Owns: walks, walk_rooms, clips,
// upload_sessions, label_shots (DMS-010 to DMS-023).
import { DEFAULT_CHUNK_SIZE } from './config';
import type { ObjectStore } from '../../platform/object-store';
import { sqlResolver, type ModuleDefinition } from '../../platform/operation';
import type { EvidenceApi } from '../evidence/index';
import type { ProcessingApi } from '../processing/index';
import type { TenancyApi } from '../tenancy-access/index';
import { createConfirmUploadHandler } from './confirm-upload';
import { createUploadSessionHandler } from './upload-session';

export interface CaptureDeps {
  readonly objectStore: ObjectStore;
  readonly evidence: EvidenceApi;
  readonly tenancy: TenancyApi;
  readonly processing: ProcessingApi;
  readonly partSizeBytes?: number;
  readonly partUrlTtlSeconds?: number;
}

export function createCaptureModule(deps: CaptureDeps): { definition: ModuleDefinition } {
  const uploads = {
    objectStore: deps.objectStore,
    partSizeBytes: deps.partSizeBytes ?? DEFAULT_CHUNK_SIZE,
    partUrlTtlSeconds: deps.partUrlTtlSeconds ?? 15 * 60,
  };
  return {
    definition: {
      name: 'capture',
      handlers: {
        createClipUploadSession: createUploadSessionHandler(uploads),
        confirmClipUpload: createConfirmUploadHandler(deps),
      },
      resolvers: [
        sqlResolver('walk', 'SELECT site_id FROM walks WHERE id = $1'),
        sqlResolver('clip', 'SELECT site_id FROM clips WHERE id = $1'),
        sqlResolver(
          'label_shot',
          'SELECT c.site_id FROM label_shots l JOIN clips c ON c.tenant_id = l.tenant_id AND c.id = l.clip_id WHERE l.id = $1',
        ),
      ],
    },
  };
}
