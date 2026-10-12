import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { writeFile, chmod } from 'node:fs/promises';

if (!process.stdin.isTTY) throw new Error('Run setup in your own interactive terminal.');
let hidden = false;
const output = new Writable({write(chunk, encoding, callback) {
  if (!hidden) process.stdout.write(chunk, encoding);
  callback();
}});
const input = createInterface({input: process.stdin, output, terminal: true});
try {
  const user = (await input.question('Gmail address [piyushsahu9846@gmail.com]: ')).trim() || 'piyushsahu9846@gmail.com';
  const recipient = (await input.question(`Alert recipient [${user}]: `)).trim() || user;
  if (![user, recipient].every(value => /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(value))) throw new Error('Enter valid email addresses.');
  process.stdout.write('Gmail app password (hidden; spaces are removed): ');
  hidden = true;
  const pass = (await input.question('')).replace(/\s/g, '');
  hidden = false;
  process.stdout.write('\n');
  if (!/^[a-zA-Z0-9]{16}$/.test(pass)) throw new Error('Expected a 16-character Gmail app password.');
  const token = randomBytes(32).toString('hex');
  await writeFile('.env', `SMTP_USER=${user}\nSMTP_PASS=${pass}\nALERT_TO=${recipient}\nRELAY_TOKEN=${token}\n`, {mode: 0o600});
  await chmod('.env', 0o600);
  console.log('\nConfiguration saved locally. Paste this relay key into the extension:');
  console.log(token);
  console.log('\nThen run npm start. The Gmail app password stays in .env; do not paste it into the extension or this chat.');
} finally { input.close(); }
