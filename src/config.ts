import { create } from 'zustand';
import { api } from './api.ts';
import type { Config, Ritual } from './types.ts';

type ConfigState = Config & { loaded: boolean };

const FALLBACK: ConfigState = {
  owner: { name: '', login: '' },
  repo: { github: '', defaultBranch: '' },
  baseUrl: '',
  models: { default: '', fast: '' },
  kitKinds: ['body', 'diagram', 'video'],
  rituals: [],
  featureFlags: false,
  loaded: false,
};

// fetched once per page load; components render with FALLBACK until it lands
export const useConfig = create<ConfigState>(() => FALLBACK);
api.config().then((c) => useConfig.setState({ ...FALLBACK, ...c, loaded: true }), () => useConfig.setState({ loaded: true }));

// a ritual asks for its `fields`, else for the {login} {pr} {paths} {text} placeholders of its prompt
export const ritualFields = (r: Ritual) => r.fields || [...new Set([...(r.prompt || '').matchAll(/\{(login|pr|paths|text)\}/g)].map((m) => m[1]))];

export const prUrl = (github: string, n: number | string, anchor?: string) => (github ? `https://github.com/${github}/pull/${n}/files${anchor ? `#diff-${anchor}` : ''}` : null);
