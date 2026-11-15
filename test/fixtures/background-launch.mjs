// Exits after starting a detached fixture worker; no model or network calls.
import { readFile } from 'node:fs/promises';
import { startBackground } from '../../src/background.mjs';
const options = JSON.parse(await readFile(process.argv[2], 'utf8'));
console.log(JSON.stringify(await startBackground(options)));
