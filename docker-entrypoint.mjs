import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const optionsPath = '/data/options.json';
let options = {};
if (existsSync(optionsPath)) {
  try {
    const parsed = JSON.parse(readFileSync(optionsPath, 'utf8'));
    if (parsed && typeof parsed === 'object') options = parsed;
  } catch (error) {
    console.warn(`Ignoring invalid ${optionsPath}: ${error instanceof Error ? error.message : error}`);
  }
}

const optionEnvironment = {
  nominatim_url: 'NOMINATIM_URL',
  overpass_url: 'OVERPASS_URL',
  plotbox_user_agent: 'PLOTBOX_USER_AGENT',
};
for (const [option, environment] of Object.entries(optionEnvironment)) {
  const value = options[option];
  if (typeof value === 'string' && value.trim()) process.env[environment] = value.trim();
}

// The server resolves the built Vite output relative to its own workspace.
const server = spawn('node', ['dist/index.js'], {
  cwd: '/app/apps/server',
  stdio: 'inherit',
  env: process.env,
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill(signal));
server.on('exit', (code, signal) => process.exitCode = code ?? (signal ? 1 : 0));
