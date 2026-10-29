// who last changed each line of a file: its commits (inPr: made on the PR, between its merge base and head) and each line's commit sha
export type BlameCommit = { author: string; email: string; time: number; summary: string; inPr: boolean };
// github: the repo's owner/name, for links to its commits
export type Blame = { commits: Record<string, BlameCommit>; lines: string[]; github?: string | null };

// `git blame --porcelain` output: a header per line group, the commit's fields the first time it shows, then the line itself after a tab
export function parseBlame(porcelain: string, prCommits: Set<string>): Blame {
  const commits: Record<string, BlameCommit> = {};
  const lines: string[] = [];
  let sha = '';
  for (const l of porcelain.split('\n')) {
    if (l.startsWith('\t')) {
      lines.push(sha);
      continue;
    }
    const head = /^([0-9a-f]{40}) \d+ \d+/.exec(l);
    if (head) {
      sha = head[1];
      commits[sha] ??= { author: '', email: '', time: 0, summary: '', inPr: prCommits.has(sha) };
      continue;
    }
    const c = commits[sha];
    const sp = l.indexOf(' ');
    if (!c || sp < 0) continue;
    const [k, v] = [l.slice(0, sp), l.slice(sp + 1)];
    if (k === 'author') c.author = v;
    else if (k === 'author-mail') c.email = v.replace(/^<|>$/g, '');
    else if (k === 'author-time') c.time = Number(v);
    else if (k === 'summary') c.summary = v;
  }
  return { commits, lines };
}
