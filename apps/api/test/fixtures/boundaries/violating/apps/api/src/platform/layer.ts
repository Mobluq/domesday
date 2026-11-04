// Fixture: the platform layer importing a module. dependency-cruiser must refuse this.
import { betaPublic } from '../modules/beta/index';

export const layer = betaPublic;
