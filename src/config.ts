import { create } from 'zustand';
import { api } from './api.ts';

const FALLBACK = {
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
export const useConfig = create(() => FALLBACK);
api.config().then((c) => useConfig.setState({ ...FALLBACK, ...c, loaded: true }), () => useConfig.setState({ loaded: true }));

// a ritual asks for its `fields`, else for the {login} {pr} {paths} {text} placeholders of its prompt
export const ritualFields = (r) => r.fields || [...new Set([...(r.prompt || '').matchAll(/\{(login|pr|paths|text)\}/g)].map((m) => m[1]))];

export const prUrl = (github, n, anchor) => (github ? `https://github.com/${github}/pull/${n}/files${anchor ? `#diff-${anchor}` : ''}` : null);
