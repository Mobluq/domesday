// Fixture: module alpha using module beta through its public index.ts, which is allowed.
import { betaPublic } from '../beta/index';

export const alpha = betaPublic;
