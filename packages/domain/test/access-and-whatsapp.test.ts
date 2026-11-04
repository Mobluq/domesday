import { describe, expect, it } from 'vitest';
import {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  Role,
  UNBLURRED_VIEWER_ROLES,
  WhatsAppSummaryError,
  buildWhatsAppSummary,
  canAccessSite,
  hasPermission,
  requiresMfa,
  sitesInScope,
  type RoleGrant,
  type WhatsAppSummaryInput,
} from '../src';

describe('DMS-131 and DMS-132: roles scoped by site', () => {
  it('Given a site manager, when they try to open another site\'s walks, then access is refused', () => {
    const grants: RoleGrant[] = [{ role: 'site_manager', sites: ['site-a'] }];
    expect(canAccessSite(grants, 'walks:read', 'site-a')).toBe(true);
    expect(canAccessSite(grants, 'walks:read', 'site-b')).toBe(false);
  });

  it('Given a facilities manager scoped to 4 sites, when they search assets, then only those 4 sites are in scope', () => {
    const grants: RoleGrant[] = [{ role: 'facilities_manager', sites: ['s1', 's2', 's3', 's4'] }];
    const scope = sitesInScope(grants, 'assets:read');
    expect(scope).not.toBe('all');
    expect([...(scope as ReadonlySet<string>)].sort()).toEqual(['s1', 's2', 's3', 's4']);
  });

  it('Objects that belong to the whole tenant need a grant that covers every site', () => {
    expect(canAccessSite([{ role: 'financial_controller', sites: ['s1'] }], 'register:read', null)).toBe(false);
    expect(canAccessSite([{ role: 'financial_controller', sites: 'all' }], 'register:read', null)).toBe(true);
  });

  it('A permission the role does not have is refused on every site', () => {
    expect(hasPermission([{ role: 'site_manager', sites: 'all' }], 'review:decide')).toBe(false);
    expect(canAccessSite([{ role: 'read_only', sites: 'all' }], 'walks:capture', 'site-a')).toBe(false);
  });

  it('Every role can read its own session, and every permission named in the matrix exists', () => {
    for (const role of Role.values) {
      expect(ROLE_PERMISSIONS[role]).toContain('session:read');
      for (const p of ROLE_PERMISSIONS[role]) expect(PERMISSIONS).toContain(p);
    }
  });
});

describe('DMS-130 and DMS-102: MFA and unblurred originals', () => {
  it('Administrators and reviewers must set up MFA; a site manager need not', () => {
    expect(requiresMfa([{ role: 'tenant_administrator', sites: 'all' }])).toBe(true);
    expect(requiresMfa([{ role: 'reviewer', sites: ['s1'] }])).toBe(true);
    expect(requiresMfa([{ role: 'site_manager', sites: ['s1'] }])).toBe(false);
  });

  it('Unblurred originals are viewable by exactly two named roles', () => {
    const holders = Role.values.filter((r) => ROLE_PERMISSIONS[r].includes('evidence:read_unblurred'));
    expect(holders.sort()).toEqual([...UNBLURRED_VIEWER_ROLES].sort());
    expect(holders).toHaveLength(2);
  });
});

describe('DMS-111: WhatsApp summaries carry counts, the site name and a link only', () => {
  const now = new Date('2026-11-03T12:00:00Z');
  const link = 'https://app.example.com/walks/7f8e/comparison';
  const comparison: WhatsAppSummaryInput = {
    event: 'comparison_ready',
    siteName: 'Ikeja branch',
    assetsChecked: 412,
    changeCount: 5,
    previousWalkDate: new Date('2026-10-03T09:00:00Z'),
    link,
    now,
  };

  it('Matches the PRD example: "Ikeja branch: 412 assets checked. 5 changes since 3 October. Review: [link]"', () => {
    expect(buildWhatsAppSummary(comparison)).toEqual({
      kind: 'text',
      body: `Ikeja branch: 412 assets checked. 5 changes since 3 October. Review: ${link}`,
    });
  });

  it('Given any notification, then it contains no image, no naira value and no name other than the site name', () => {
    const smuggled = {
      ...comparison,
      reviewerName: 'Jane Reviewer',
      capturedBy: 'John Capturer',
      valueAtRiskKobo: 320_000_000,
      imageUrl: 'https://cdn.example.com/frame.jpg',
      media: [{ type: 'image', url: 'https://cdn.example.com/frame.jpg' }],
    } as unknown as WhatsAppSummaryInput;
    const message = buildWhatsAppSummary(smuggled);
    expect(Object.keys(message).sort()).toEqual(['body', 'kind']);
    expect(message.kind).toBe('text');
    expect(message.body).not.toMatch(/Jane|John|frame\.jpg|cdn\.example|₦|NGN|3,?200,?000/);
    expect(message.body).toMatch(
      /^Ikeja branch: \d+ assets? checked\. \d+ changes? since \d{1,2} [A-Z][a-z]+( \d{4})?\. Review: https:\/\/\S+$/,
    );
  });

  it('Refuses a site name that carries a money value, an address or a phone number', () => {
    for (const siteName of ['Ikeja ₦4m store', 'NGN 2,000 room', 'Ikeja www.example.com', 'Ikeja ops@example.com', 'Call 0803 123 4567']) {
      expect(() => buildWhatsAppSummary({ ...comparison, siteName }), siteName).toThrow(WhatsAppSummaryError);
    }
  });

  it('Refuses a link that does not need sign-in: plain http, credentials, a query string or a fragment', () => {
    for (const bad of [
      'http://app.example.com/walks/1',
      'https://user:pass@app.example.com/walks/1',
      'https://app.example.com/walks/1?token=abc',
      'https://bucket.example.com/clip.mp4?X-Amz-Signature=abc',
      'https://app.example.com/walks/1#frame',
      'not a link',
    ]) {
      expect(() => buildWhatsAppSummary({ ...comparison, link: bad }), bad).toThrow(WhatsAppSummaryError);
    }
  });

  it('Refuses counts that are not whole numbers of zero or more', () => {
    expect(() => buildWhatsAppSummary({ ...comparison, changeCount: -1 })).toThrow(WhatsAppSummaryError);
    expect(() => buildWhatsAppSummary({ ...comparison, assetsChecked: 2.5 })).toThrow(WhatsAppSummaryError);
  });

  it('Collapses line breaks so a site name cannot add lines to the message', () => {
    const body = buildWhatsAppSummary({ ...comparison, siteName: 'Ikeja\nbranch' }).body;
    expect(body.startsWith('Ikeja branch: ')).toBe(true);
    expect(body).not.toContain('\n');
  });

  it('Builds the processed and approved summaries from counts only, with singular forms', () => {
    expect(buildWhatsAppSummary({ event: 'walk_processed', siteName: 'Ikeja branch', linesToReview: 1, link }).body).toBe(
      `Ikeja branch: walk processed. 1 line ready for review. Review: ${link}`,
    );
    expect(buildWhatsAppSummary({ event: 'walk_approved', siteName: 'Ikeja branch', assetsChecked: 412, link }).body).toBe(
      `Ikeja branch: walk approved. 412 assets checked. View: ${link}`,
    );
  });
});
