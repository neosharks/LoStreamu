// Deploy-time secret generation. Run before first start:
//   node gen-secrets.js            # create secrets.json if missing (keeps existing)
//   node gen-secrets.js --rotate   # force fresh keys (logs everyone out)
import { ensureSecrets, SECRETS_PATH } from './secrets.js';

const rotate = process.argv.includes('--rotate');
ensureSecrets({ rotate });
console.log(`${rotate ? 'Rotated' : 'Ensured'} secrets → ${SECRETS_PATH}`);
