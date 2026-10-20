import { randomBytes } from 'node:crypto';
import { appendFile, chmod } from 'node:fs/promises';
import { loadEnvFile } from 'node:process';

try {
  loadEnvFile('.env');
  let token = process.env.RELAY_TOKEN;
  if (!token || token === 'generated_by_npm_run_setup') {
    token = randomBytes(32).toString('hex');
    // Keep existing credentials and settings; the last assignment takes precedence.
    await appendFile('.env', `\nRELAY_TOKEN=${token}\n`, {mode: 0o600});
  }
  if (token.length < 32) throw new Error('Set RELAY_TOKEN in .env to a key of at least 32 characters.');
  await chmod('.env', 0o600);
  console.log('Relay key (paste into the extension):');
  console.log(token);
} catch (error) {
  console.error(error.code === 'ENOENT'
    ? 'Create .env with your notification settings first (see .env.example), then run npm run setup.'
    : `Setup failed: ${error.code || error.message}`);
  process.exitCode = 1;
}
