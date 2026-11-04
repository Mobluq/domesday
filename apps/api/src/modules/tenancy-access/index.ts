// Public interface of the tenancy-access module. Owns: tenants, users, role_grants,
// role_grant_sites, partner_grants, partner_grant_sites.
import type { AccessPolicy } from '../../platform/authz';
import type { Queryable } from '../../platform/db';
import { ok, sqlResolver, type ModuleDefinition } from '../../platform/operation';
import { createAccessPolicy, permissionsOf } from './policy';

export { StaticTokenAuthenticator, parseDevTokens } from './authenticator';

export interface TenantSettings {
  readonly originalsRetentionMonths: number;
  readonly capturerSeparationRule: boolean;
  readonly capitalisationThresholdKobo: number | null;
  readonly trainingConsent: boolean;
}

export interface TenancyApi {
  getTenantSettings(tx: Queryable, tenantId: string): Promise<TenantSettings>;
}

const tenancyApi: TenancyApi = {
  async getTenantSettings(tx, tenantId) {
    const { rows } = await tx.query<{
      originals_retention_months: number;
      capturer_separation_rule: boolean;
      capitalisation_threshold_kobo: string | null;
      training_consent: boolean;
    }>(
      `SELECT originals_retention_months, capturer_separation_rule, capitalisation_threshold_kobo::text, training_consent
       FROM tenants WHERE tenant_id = $1`,
      [tenantId],
    );
    const row = rows[0];
    if (!row) throw new Error('tenant not visible in this transaction');
    return {
      originalsRetentionMonths: row.originals_retention_months,
      capturerSeparationRule: row.capturer_separation_rule,
      capitalisationThresholdKobo: row.capitalisation_threshold_kobo === null ? null : Number(row.capitalisation_threshold_kobo),
      trainingConsent: row.training_consent,
    };
  },
};

export function createTenancyAccessModule(): { definition: ModuleDefinition; api: TenancyApi; policy: AccessPolicy } {
  return {
    api: tenancyApi,
    policy: createAccessPolicy(),
    definition: {
      name: 'tenancy-access',
      handlers: {
        getCurrentPrincipal: async ({ principal }) =>
          ok({
            userId: principal.userId,
            tenantId: principal.tenantId,
            displayName: principal.displayName,
            kind: principal.kind,
            mfaVerified: principal.mfaVerified,
            grants: principal.grants.map((g) => ({ role: g.role, sites: g.sites === 'all' ? 'all' : [...g.sites] })),
            permissions: permissionsOf(principal),
          }),
      },
      resolvers: [
        sqlResolver('partner_grant', 'SELECT NULL::uuid AS site_id FROM partner_grants WHERE id = $1 AND tenant_id = app_current_tenant_id()'),
      ],
    },
  };
}
