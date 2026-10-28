// The packaged app runs from /Applications: it remembers the coco checkout it was built from.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
fs.writeFileSync(path.join(desktop, 'app-dir.json'), JSON.stringify({ app: path.resolve(desktop, '..') }, null, 1) + '\n');
