import {randomBytes} from 'node:crypto';
import {readFile, writeFile, rename, chmod} from 'node:fs/promises';
import {loadEnvFile} from 'node:process';
import {createInterface} from 'node:readline/promises';
import {Writable} from 'node:stream';
import {pathToFileURL} from 'node:url';
import {discordConfig, verifyDiscordWebhook} from './discord.mjs';

export async function saveDiscordConfig({config, token, envFile = '.env'}) {
  const checked = discordConfig({DISCORD_WEBHOOK_URL: config.webhook});
  if (!token || token.length < 32 || /[\s"'\\]/.test(token)) throw new Error('Keep a relay key of at least 32 characters without whitespace or quotes.');
  let existing = '';
  try {existing = await readFile(envFile, 'utf8');} catch (error) {if (error.code !== 'ENOENT') throw error;}
  const settings = {NOTIFICATION_PROVIDER: 'discord', DISCORD_WEBHOOK_URL: checked.webhook, RELAY_TOKEN: token};
  const replacedKeys = [...Object.keys(settings), 'DISCORD_ARCHIVE_WEBHOOK_URL', 'DISCORD_ARCHIVE_STATUS_CODES'];
  const keep = existing.split(/\r?\n/).filter(line => !replacedKeys.some(key => new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`).test(line))).join('\n').trimEnd();
  await writeFile(`${envFile}.tmp`, `${keep}\n\n${Object.entries(settings).map(([key, value]) => `${key}=${value}`).join('\n')}\n`, {mode: 0o600});
  await chmod(`${envFile}.tmp`, 0o600);
  await rename(`${envFile}.tmp`, envFile);
}

async function main() {
  try {loadEnvFile('.env');} catch (error) {if (error.code !== 'ENOENT') throw error;}
  if (!process.stdin.isTTY) throw new Error('Run npm run setup:discord in your Terminal. You can also edit the Discord settings in .env using .env.example.');
  console.log('Create one Discord text channel for your alerts.\nOpen Edit Channel → Integrations → Webhooks → New Webhook → Copy Webhook URL.\nThe pasted URL is hidden. This check will not post messages.');
  let hidden = false;
  const output = new Writable({write(chunk, encoding, callback) {if (!hidden) process.stdout.write(chunk, encoding); callback();}});
  const prompt = createInterface({input: process.stdin, output, terminal: true});
  async function secret(label) {
    process.stdout.write(label);
    hidden = true;
    try {return (await prompt.question('')).trim();}
    finally {hidden = false; process.stdout.write('\n');}
  }
  let config;
  try {
    config = discordConfig({DISCORD_WEBHOOK_URL: await secret('Discord alerts webhook URL: ')});
  } finally {prompt.close();}
  await verifyDiscordWebhook(config);
  const savedToken = process.env.RELAY_TOKEN;
  const token = savedToken && savedToken !== 'generated_by_npm_run_setup' ? savedToken : randomBytes(32).toString('hex');
  await saveDiscordConfig({config, token});
  console.log('Discord setup saved privately in .env. Existing Gmail settings and the relay key are preserved.\nRestart the relay with npm start, then reload the extension.\nOn your phone: enable notifications for your alerts channel. All alerts use this channel; the relay does not archive or silence errors.\nUse Send test notification in the extension to verify mobile delivery.\nIf you need the relay key, run npm run setup.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {console.error(`Discord setup failed: ${error.code || error.message}`); process.exitCode = 1;});
}
