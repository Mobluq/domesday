import { formatWalkDate } from './compare-walks';

/**
 * DMS-110, DMS-111: WhatsApp summaries carry counts, the site name and a link that
 * needs sign-in. Never an image, a naira value or any other name.
 *
 * The builder enforces this by construction: it reads only the named fields below
 * (anything else passed in is ignored), returns a text message type with no field
 * for media, and refuses input that could smuggle a value or a credential in.
 */
export type WhatsAppSummaryInput =
  | {
      readonly event: 'walk_processed';
      readonly siteName: string;
      readonly linesToReview: number;
      readonly link: string;
    }
  | {
      readonly event: 'walk_approved';
      readonly siteName: string;
      readonly assetsChecked: number;
      readonly link: string;
    }
  | {
      readonly event: 'comparison_ready';
      readonly siteName: string;
      readonly assetsChecked: number;
      readonly changeCount: number;
      /** The previous approved walk, shown as in the PRD's example ("5 changes since 3 October"). */
      readonly previousWalkDate: Date;
      readonly link: string;
      readonly now?: Date;
    };

/** A plain text message. There is deliberately no field for images or attachments. */
export interface WhatsAppTextMessage {
  readonly kind: 'text';
  readonly body: string;
}

export class WhatsAppSummaryError extends Error {
  override readonly name = 'WhatsAppSummaryError';
}

const MAX_SITE_NAME_LENGTH = 80;

function count(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new WhatsAppSummaryError(`${field} must be a whole number of zero or more`);
  }
  return value;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Clean the site name and refuse anything that looks like a value, an address or a phone number. */
export function cleanSiteName(raw: unknown): string {
  if (typeof raw !== 'string') throw new WhatsAppSummaryError('siteName must be text');
  const name = raw
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (name.length === 0) throw new WhatsAppSummaryError('siteName is empty');
  if (name.length > MAX_SITE_NAME_LENGTH) throw new WhatsAppSummaryError('siteName is too long');
  if (/[₦$£€]|\bNGN\b|\bnaira\b|\bkobo\b/i.test(name)) {
    throw new WhatsAppSummaryError('siteName must not contain a money value');
  }
  if (/https?:|www\.|@|:\/\//i.test(name)) throw new WhatsAppSummaryError('siteName must not contain an address');
  if (/\d[\d\s-]{6,}\d/.test(name)) throw new WhatsAppSummaryError('siteName must not contain a phone number');
  return name;
}

/**
 * https, a host name, an optional port and a path. No credentials (no "@"), no
 * query string and no fragment. Written as a pattern rather than with URL so the
 * rule runs the same in Node, browsers and React Native.
 */
const SIGN_IN_LINK = /^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?::\d{1,5})?(?:\/[A-Za-z0-9._~%!$&'()*+,;=:-]*)*$/i;

/** The link must be plain https with no credentials, query string or fragment, so no token can ride along. */
export function cleanSummaryLink(raw: unknown): string {
  if (typeof raw !== 'string') throw new WhatsAppSummaryError('link must be text');
  const link = raw.trim();
  if (!link.toLowerCase().startsWith('https://')) throw new WhatsAppSummaryError('link must use https');
  if (/[?#]/.test(link)) {
    throw new WhatsAppSummaryError('link must not carry a query string or fragment; it must need sign-in');
  }
  if (/^https:\/\/[^/]*@/i.test(link)) throw new WhatsAppSummaryError('link must not carry credentials');
  if (!SIGN_IN_LINK.test(link)) throw new WhatsAppSummaryError('link is not a valid https address');
  return link;
}

/** DMS-111: build the WhatsApp text for a processed walk, an approved walk or a ready comparison. */
export function buildWhatsAppSummary(input: WhatsAppSummaryInput): WhatsAppTextMessage {
  const site = cleanSiteName(input.siteName);
  const link = cleanSummaryLink(input.link);
  let body: string;
  switch (input.event) {
    case 'walk_processed':
      body = `${site}: walk processed. ${plural(count(input.linesToReview, 'linesToReview'), 'line', 'lines')} ready for review. Review: ${link}`;
      break;
    case 'walk_approved':
      body = `${site}: walk approved. ${plural(count(input.assetsChecked, 'assetsChecked'), 'asset', 'assets')} checked. View: ${link}`;
      break;
    case 'comparison_ready': {
      if (!(input.previousWalkDate instanceof Date) || Number.isNaN(input.previousWalkDate.getTime())) {
        throw new WhatsAppSummaryError('previousWalkDate must be a valid date');
      }
      const assets = plural(count(input.assetsChecked, 'assetsChecked'), 'asset', 'assets');
      const changes = plural(count(input.changeCount, 'changeCount'), 'change', 'changes');
      body = `${site}: ${assets} checked. ${changes} since ${formatWalkDate(input.previousWalkDate, input.now)}. Review: ${link}`;
      break;
    }
    default:
      throw new WhatsAppSummaryError('unknown summary event');
  }
  return Object.freeze({ kind: 'text' as const, body });
}
