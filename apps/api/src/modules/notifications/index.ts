// Public interface of the notifications module. Owns: walk_schedules,
// notification_messages (DMS-110 to DMS-113).
import { buildWhatsAppSummary, type WhatsAppSummaryInput, type WhatsAppTextMessage } from '@domesday/domain';
import type { ModuleDefinition } from '../../platform/operation';

export interface NotificationsApi {
  /**
   * DMS-111: the only way to compose a WhatsApp message. The domain rule allows
   * counts, the site name and a sign-in link, and nothing else.
   */
  composeWhatsAppSummary(input: WhatsAppSummaryInput): WhatsAppTextMessage;
}

export function createNotificationsModule(): { definition: ModuleDefinition; api: NotificationsApi } {
  return {
    api: { composeWhatsAppSummary: buildWhatsAppSummary },
    definition: { name: 'notifications' },
  };
}
