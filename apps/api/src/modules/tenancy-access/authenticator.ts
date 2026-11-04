import { Role, type RoleGrant } from '@domesday/domain';
import type { Authenticator, Principal, RequestHeaders } from '../../platform/authz';

/**
 * Maps fixed bearer tokens to principals. For local development and tests only.
 *
 * Sign-in is bought, not built (DMS-130). Which provider (Auth0, Clerk or WorkOS)
 * is still open in ADR-DMS-05; its adapter will implement the same Authenticator
 * interface. The server refuses to start in production with this authenticator.
 */
export class StaticTokenAuthenticator implements Authenticator {
  private readonly tokens: ReadonlyMap<string, Principal>;

  constructor(tokens: Readonly<Record<string, Principal>>) {
    this.tokens = new Map(Object.entries(tokens));
  }

  async authenticate(headers: RequestHeaders): Promise<Principal | null> {
    const header = headers.authorization;
    if (typeof header !== 'string') return null;
    const match = /^Bearer ([A-Za-z0-9._~+/-]{8,})$/.exec(header);
    if (!match?.[1]) return null;
    return this.tokens.get(match[1]) ?? null;
  }
}

function isGrant(value: unknown): value is RoleGrant {
  if (typeof value !== 'object' || value === null) return false;
  const g = value as { role?: unknown; sites?: unknown };
  return Role.is(g.role) && (g.sites === 'all' || (Array.isArray(g.sites) && g.sites.every((s) => typeof s === 'string')));
}

/** Reads DOMESDAY_DEV_TOKENS: a JSON object of token to principal. Throws on anything malformed. */
export function parseDevTokens(json: string): Record<string, Principal> {
  const raw = JSON.parse(json) as Record<string, Partial<Principal>>;
  const out: Record<string, Principal> = {};
  for (const [token, p] of Object.entries(raw)) {
    if (typeof p.userId !== 'string' || typeof p.tenantId !== 'string' || !Array.isArray(p.grants) || !p.grants.every(isGrant)) {
      throw new Error(`DOMESDAY_DEV_TOKENS: token ${token.slice(0, 4)}... is not a valid principal`);
    }
    out[token] = {
      userId: p.userId,
      tenantId: p.tenantId,
      displayName: p.displayName ?? 'Developer',
      kind: p.kind === 'partner' ? 'partner' : 'user',
      grants: p.grants,
      mfaVerified: p.mfaVerified === true,
    };
  }
  return out;
}
