#!/usr/bin/env node
// PreToolUse hook coco writes in an agent worktree's .claude/settings.local.json: refuses a package install while a dependency folder
// given as argument (relative to the worktree) is a link to the main checkout, since the install would change the main checkout's packages.
import fs from 'node:fs';
import path from 'node:path';

const INSTALL = /(^|[\s;&|(])(npm|pnpm|yarn)((\s+-{1,2}[\w-]+(=\S+)?)|(\s+--prefix\s+\S+))*\s+(install|i|ci|add|uninstall|un|remove|rm|r|update|up|upgrade|link|ln|prune|dedupe)(\s|$)/;

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
let input;
try {
  input = JSON.parse(raw);
} catch {
  process.exit(0);
}
const command = String(input?.tool_input?.command || '');
if (input?.tool_name !== 'Bash' || !INSTALL.test(command)) process.exit(0);
const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
const linked = process.argv.slice(2).filter((rel) => {
  try {
    return fs.lstatSync(path.join(root, rel)).isSymbolicLink();
  } catch {
    return false;
  }
});
if (!linked.length) process.exit(0);
const reason = `${linked.join(', ')} ${linked.length > 1 ? 'are links' : 'is a link'} to the main checkout: installing here would change the main checkout's packages. Call the cocopilot own_deps tool first: it gives this worktree its own copy and a message tells you when it is ready; then install.`;
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
