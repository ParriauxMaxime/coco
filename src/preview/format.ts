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

const short = (n: number) => (n < 10 ? n.toFixed(1).replace(/\.0$/, '') : String(Math.round(n)));
const kTok = (n: number) => `${n < 1e6 ? `${short(n / 1000)}k` : `${short(n / 1e6)}M`} tok`;
// "prompt 0.4k tok · in 61k tok · $0.42": the first prompt's estimated size, what Paseo counted as input, the cost
export const usageLine = ({ promptTokens, inputTokens, costUsd }: { promptTokens?: number | null; inputTokens?: number | null; costUsd?: number | null }) =>
  [promptTokens != null && `prompt ${kTok(promptTokens)}`, inputTokens != null && `in ${kTok(inputTokens)}`, costUsd != null && `$${costUsd.toFixed(2)}`].filter(Boolean).join(' · ');
export const usageTitle = ({ promptTokens, systemTokens, inputTokens }: { promptTokens?: number | null; systemTokens?: number | null; inputTokens?: number | null }) =>
  [promptTokens != null && `First prompt ≈ ${promptTokens} tokens`, systemTokens != null && `system prompt ≈ ${systemTokens} tokens`, inputTokens != null && `${inputTokens} input tokens in all (cached reads included)`].filter(Boolean).join(', ');

export const SEVERITIES =['blocking', 'major', 'minor', 'nit'];
export const sevClass = (severity?: string) => (severity === 'blocking' ? 'dp-crit' : severity === 'major' ? 'dp-major' : severity === 'minor' ? 'dp-minor' : 'dp-nit');
export const sevTone = (severity?: string) => (severity === 'blocking' ? 'dp-bad' : severity === 'major' ? 'dp-warn' : severity === 'minor' ? 'dp-info' : '');

export const stamp =(ts?: string) => {
  const t = ts ? Date.parse(ts) : NaN;
  return Number.isFinite(t) ? new Date(t).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
};
