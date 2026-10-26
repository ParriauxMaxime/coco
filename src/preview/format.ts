export const ago = (ts?: string) => {
  const t = ts ? Date.parse(ts) : NaN;
  if (!Number.isFinite(t)) return '';
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (m < 1) return 'now';
  if (m < 60) return `${m} min`;
  if (m < 1440) return `${Math.round(m / 60)} h`;
  if (m < 43200) return `${Math.round(m / 1440)} d`;
  return new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short' });
};

export const SEVERITIES = ['blocking', 'major', 'minor', 'nit'];
export const sevClass = (severity?: string) => (severity === 'blocking' ? 'dp-crit' : severity === 'major' ? 'dp-major' : severity === 'minor' ? 'dp-minor' : 'dp-nit');
export const sevTone = (severity?: string) => (severity === 'blocking' ? 'dp-bad' : severity === 'major' ? 'dp-warn' : severity === 'minor' ? 'dp-info' : '');

export const stamp =(ts?: string) => {
  const t = ts ? Date.parse(ts) : NaN;
  return Number.isFinite(t) ? new Date(t).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
};
