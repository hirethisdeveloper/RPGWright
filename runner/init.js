'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CONFIG_TEMPLATE = `'use strict';

const path = require('node:path');

module.exports = {
  command: process.execPath,
  args: [path.join(__dirname, 'example-app.js')],
};
`;

const EXAMPLE_APP_TEMPLATE = `'use strict';

// A minimal raw-mode TTY app -- enough to demonstrate RPGWright driving a
// real process through a real pseudo-terminal. Replace this with your own
// application's entry point once you're ready (update the "command"/"args"
// in rpgwright.config.js to match).
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write('Press ENTER to continue\\n');

process.stdin.on('data', (data) => {
  if (data.toString() === '\\r') {
    process.stdout.write('Hello from RPGWright!\\n');
  }
});

process.on('SIGTERM', () => process.exit(0));
`;

const EXAMPLE_TEST_TEMPLATE = `'use strict';

const { test, expect } = require('rpgwright/test');

test('says hello after pressing enter', async ({ game }) => {
  await game.expectText('Press ENTER to continue');
  await game.press('ENTER');
  await expect(game).toHaveText('Hello from RPGWright!');
});
`;

function writeIfAbsent(filePath, content, force) {
  if (fs.existsSync(filePath) && !force) {
    return { path: filePath, action: 'skipped' };
  }
  fs.writeFileSync(filePath, content, 'utf8');
  return { path: filePath, action: 'created' };
}

/**
 * Scaffolds a self-contained example: a config, a tiny dependency-free
 * raw-mode script to launch, and a test file — genuinely runnable via
 * `rpgwright test` immediately, with no editing required, unlike a scaffold
 * that points at a placeholder command the consumer has to fill in first.
 */
function scaffold({ targetDir = process.cwd(), force = false } = {}) {
  const results = [
    writeIfAbsent(path.join(targetDir, 'rpgwright.config.js'), CONFIG_TEMPLATE, force),
    writeIfAbsent(path.join(targetDir, 'example-app.js'), EXAMPLE_APP_TEMPLATE, force),
    writeIfAbsent(path.join(targetDir, 'example.rpg.test.js'), EXAMPLE_TEST_TEMPLATE, force),
  ];

  const pkgPath = path.join(targetDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    pkg.scripts = pkg.scripts || {};
    if (!pkg.scripts['test:e2e'] || force) {
      pkg.scripts['test:e2e'] = 'rpgwright test';
      fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
      results.push({ path: pkgPath, action: 'updated' });
    } else {
      results.push({ path: pkgPath, action: 'skipped' });
    }
  } else {
    results.push({ path: pkgPath, action: 'missing' });
  }

  return results;
}

async function runInit(args) {
  const force = args.includes('--force');
  const targetDir = process.cwd();
  const results = scaffold({ targetDir, force });

  const messages = {
    created: (rel) => `created ${rel}`,
    updated: (rel) => `updated ${rel} (added "test:e2e" script)`,
    skipped: (rel) => `skipped ${rel} (already exists; pass --force to overwrite)`,
    missing: (rel) => `skipped ${rel} (not found — run "npm init" first if you want the "test:e2e" script added)`,
  };

  for (const result of results) {
    const relative = path.relative(targetDir, result.path);
    console.log(messages[result.action](relative));
  }

  console.log('\nNext: npx rpgwright test');
}

module.exports = { scaffold, runInit };
