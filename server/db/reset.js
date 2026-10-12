import { reset, flush } from './store.js';
import { seedIfEmpty } from './seed.js';
import { ensureTokens } from '../lib/auth.js';
import { ensureSecrets } from '../lib/secrets.js';

reset();
seedIfEmpty();
ensureTokens();
ensureSecrets();
flush();
console.log('Database cleared and reseeded.');
