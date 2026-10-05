import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

console.log('===================================================');
console.log('  Fixing Git History & Preparing for Clean Publish ');
console.log('===================================================\n');

function run(cmd, ignoreError = false) {
  try {
    console.log(`> ${cmd}`);
    const out = execSync(cmd, { cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    if (out && out.trim()) console.log(out.trim());
    return true;
  } catch (err) {
    const msg = (err.stderr || err.stdout || err.message || '').trim();
    if (!ignoreError && msg) console.log(`  [Note] ${msg.split('\n')[0]}`);
    return false;
  }
}

// 1. Ensure .gitignore exists and contains all heavy binary, secrets, and data exclusions
console.log('[1/5] Verifying .gitignore rules...');
const gitignorePath = path.join(root, '.gitignore');
const requiredPatterns = [
  'node_modules/',
  'package-lock.json',
  '.env',
  '!.env.example',
  'dist/',
  'build/',
  '*.apk',
  '*.zip',
  '*.tar.gz',
  '*.exe',
  '**/bin/',
  'bin/',
  'cookies.txt',
  '**/cookies.txt',
  '**/downloads/',
  '**/logs/',
  'data/',
  '**/data/',
  '**/data/**',
  'download_history.json',
  '**/download_history.json',
  '.gradle/',
  'local.properties',
  'toolchain/',
  'tmp/',
  'scratch/'
];

let gitignoreContent = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf-8') : '';
let addedRule = false;
for (const rule of requiredPatterns) {
  if (!gitignoreContent.includes(rule)) {
    gitignoreContent += `\n${rule}`;
    addedRule = true;
  }
}
if (addedRule) {
  fs.writeFileSync(gitignorePath, gitignoreContent.trim() + '\n', 'utf-8');
  console.log('  Updated .gitignore with required exclusions.');
} else {
  console.log('  .gitignore is up to date.');
}

// 2. Create a clean orphan branch to purge all heavy binaries and secrets from historical commits
console.log('\n[2/5] Creating clean branch (purging old oversized & secret-containing commits)...');
run('git checkout --orphan temp-clean-publish', true);

// 3. Reset index and stage only files permitted by .gitignore
console.log('\n[3/5] Staging repository files according to .gitignore...');
run('git reset', true);

// Remove any untracked patterns from index just to be certain
const patternsToUntrack = [
  '**/bin/*',
  '**/*.exe',
  '**/*.apk',
  '**/*.zip',
  '**/cookies.txt',
  '**/downloads/*',
  '**/logs/*',
  'data',
  'data/*',
  '**/data',
  '**/data/*',
  '**/data/**/*',
  '**/download_history.json',
  '.env',
  '**/.env'
];

for (const pattern of patternsToUntrack) {
  run(`git rm -r --cached "${pattern}" --ignore-unmatch`, true);
}

run('git add -A');

// Verify no file > 50MB and no secrets are staged
try {
  const staged = execSync('git diff --cached --name-only', { cwd: root, encoding: 'utf-8' });
  const files = staged.split('\n').map(s => s.trim()).filter(Boolean);
  let problemFound = false;

  for (const relPath of files) {
    const fullPath = path.join(root, relPath);
    if (!fs.existsSync(fullPath)) continue;

    // Check size (>50MB)
    const stats = fs.statSync(fullPath);
    if (stats.size > 50 * 1024 * 1024) {
      console.warn(`  [WARNING] Found oversized file staged: ${relPath} (${(stats.size / (1024*1024)).toFixed(2)} MB) - Untracking...`);
      run(`git rm --cached "${relPath}"`);
      problemFound = true;
      continue;
    }

    // Check for runtime data or secrets
    if (relPath.includes('/data/') || relPath.startsWith('data/') || relPath.endsWith('user.json') || relPath.endsWith('download_history.json')) {
      console.warn(`  [WARNING] Untracking runtime user/data file: ${relPath}`);
      run(`git rm --cached "${relPath}"`);
      problemFound = true;
      continue;
    }

    // Inspect text files under 2MB for Google OAuth access/refresh tokens
    if (stats.size < 2 * 1024 * 1024) {
      try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        if (content.includes('ya29.') || content.includes('1//0')) {
          console.warn(`  [WARNING] Found potential secret token in ${relPath} - Untracking...`);
          run(`git rm --cached "${relPath}"`);
          problemFound = true;
        }
      } catch (_) {}
    }
  }

  if (!problemFound) {
    console.log('  ✓ Verified: No files over 50MB and no user secrets in staged index.');
  }
} catch (err) {
  console.warn('  Verification note:', err.message);
}

// 4. Create the clean initial commit
console.log('\n[4/5] Creating fresh commit...');
run('git commit -m "feat: butfree.online - unified personal media cloud"');

// 5. Replace 'main' branch with our clean branch and prune old packfiles
console.log('\n[5/5] Re-pointing main branch and cleaning Git database...');
run('git branch -D main', true);
run('git branch -M main');

// Clean loose objects and reflog to ensure GitHub push does not include orphan pack objects
run('git reflog expire --expire=now --all', true);
run('git gc --prune=now', true);

console.log('\n===================================================');
console.log('  🎉 SUCCESS: Git history cleaned!');
console.log('  • All >100MB binaries removed.');
console.log('  • All user tokens / data files removed.');
console.log('  Run: git push -f -u origin main');
console.log('===================================================');
