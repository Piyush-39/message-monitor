import {randomBytes} from 'node:crypto';
import {readFile, writeFile, rename, chmod} from 'node:fs/promises';
import {loadEnvFile} from 'node:process';
import {createInterface} from 'node:readline/promises';
import {Writable} from 'node:stream';
import {pathToFileURL} from 'node:url';
import {teamsConfig} from './teams.mjs';

export async function saveTeamsConfig({config, token, envFile = '.env'}) {
  const checked = teamsConfig({TEAMS_WEBHOOK_URL: config.webhook});
  if (!token || token.length < 32 || /[\s"'\\]/.test(token)) throw new Error('Keep a relay key of at least 32 characters without whitespace or quotes.');
  let existing = '';
  try {existing = await readFile(envFile, 'utf8');} catch (error) {if (error.code !== 'ENOENT') throw error;}
  const settings = {NOTIFICATION_PROVIDER: 'teams', TEAMS_WEBHOOK_URL: checked.webhook, RELAY_TOKEN: token};
  const keep = existing.split(/\r?\n/).filter(line => !Object.keys(settings).some(key => new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`).test(line))).join('\n').trimEnd();
  await writeFile(`${envFile}.tmp`, `${keep}\n\n${Object.entries(settings).map(([key, value]) => `${key}=${value}`).join('\n')}\n`, {mode: 0o600});
  await chmod(`${envFile}.tmp`, 0o600);
  await rename(`${envFile}.tmp`, envFile);
}

async function main() {
  try {loadEnvFile('.env');} catch (error) {if (error.code !== 'ENOENT') throw error;}
  if (!process.stdin.isTTY) throw new Error('Run npm run setup:teams in your Terminal. You can also edit the Teams settings in .env using .env.example.');
  console.log('In Teams, open your channel → Workflows → Send webhook alerts to a channel.\nUse the Anyone authentication option, save, and copy the webhook URL.\nThe pasted URL is hidden. Setup validates its format without posting a message.');
  let hidden = false;
  const output = new Writable({write(chunk, encoding, callback) {if (!hidden) process.stdout.write(chunk, encoding); callback();}});
  const prompt = createInterface({input: process.stdin, output, terminal: true});
  let config;
  try {
    process.stdout.write('Teams workflow webhook URL: ');
    hidden = true;
    config = teamsConfig({TEAMS_WEBHOOK_URL: (await prompt.question('')).trim()});
  } finally {hidden = false; process.stdout.write('\n'); prompt.close();}
  const savedToken = process.env.RELAY_TOKEN;
  const token = savedToken && savedToken !== 'generated_by_npm_run_setup' ? savedToken : randomBytes(32).toString('hex');
  await saveTeamsConfig({config, token});
  console.log('Teams setup saved privately in .env. Existing Gmail/Discord settings and the relay key are preserved.\nRestart the relay with npm start, then reload the extension and use Send test.\nA successful webhook response confirms workflow acceptance; check the channel or workflow run history to confirm the post.\nIf you need the relay key, run npm run setup.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {console.error(`Teams setup failed: ${error.code || error.message}`); process.exitCode = 1;});
}
