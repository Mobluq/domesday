// Fixture: module alpha reaching into module beta's internals. dependency-cruiser must refuse this.
import { betaSecret } from '../beta/internal';

export const alpha = betaSecret;
