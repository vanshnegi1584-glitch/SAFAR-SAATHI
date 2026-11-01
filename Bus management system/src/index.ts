export * from './client.js';
export * from './types/database.types.js';
export * from './repositories/index.js';

import { SafarSaathiRepository } from './repositories/index.js';

// Default instance export
export const safarsaathi = new SafarSaathiRepository();
export default safarsaathi;
