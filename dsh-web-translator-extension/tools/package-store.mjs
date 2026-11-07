#!/usr/bin/env node
/**
 * Build the Chrome Web Store / Edge Add-ons upload ZIP.
 *
 * Only runtime files are shipped: manifest, content/background scripts,
 * options page and icons. Dev tools, README, docs and dist/ are excluded.
 * The ZIP root contains manifest.json (required by both stores).
 *
 * Usage: node tools/package-store.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const version = String(manifest.version || '0.0.0');
const outDir = join(root, 'dist');
const outFile = join(outDir, `dsh-translator-${version}.zip`);
const files = ['manifest.json', 'background.js', 'content.js', 'options.html', 'options.js', 'icons'];
const staging = mkdtempSync(join(tmpdir(), 'dsh-store-'));

try {
  for (const entry of files) {
    const source = join(root, entry);
    if (!existsSync(source)) throw new Error(`missing runtime file: ${entry}`);
    cpSync(source, join(staging, entry), { recursive: true });
  }
  if (!existsSync(join(staging, 'icons', 'icon128.png'))) {
    throw new Error('icons/icon128.png is required by both stores');
  }
  mkdirSync(outDir, { recursive: true });
  rmSync(outFile, { force: true });
  if (process.platform === 'win32') {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -Path '${join(staging, '*')}' -DestinationPath '${outFile}' -Force`], { stdio: 'inherit' });
  } else {
    execFileSync('zip', ['-X', '-r', outFile, ...files], { cwd: staging, stdio: 'inherit' });
  }
  const size = (await import('node:fs/promises')).stat(outFile).then((s) => `${(s.size / 1024 / 1024).toFixed(2)} MB`);
  console.log(`[package-store] wrote ${outFile} (${await size})`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
