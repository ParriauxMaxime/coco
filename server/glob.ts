// Persona surface globs (src/billing/**) matched against repo-relative paths.
export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\0').replace(/\*\*/g, '\u0001').replace(/\*/g, '[^/]*');
  return new RegExp('^' + escaped.replace(/\0/g, '(?:.*/)?').replace(/\u0001/g, '.*') + '$');
}

// the path globs listed under a persona's ```yaml surfaces: block
export function surfaceGlobs(md: string): string[] {
  const m = md.match(/```yaml\nsurfaces:\n([\s\S]*?)```/);
  return m ? [...m[1].matchAll(/^\s+- (?!name:)([^\n]+)$/gm)].map((x) => x[1].trim()) : [];
}
