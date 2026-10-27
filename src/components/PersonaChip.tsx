import './parts.css';

type Props = { login: string; label?: string; onRemove?: () => void; href?: string | null };

// href null renders a span: use it inside another link (dashboard card).
export function PersonaChip({ login, label, onRemove, href = `#/persona/${login}` }: Props) {
  const Tag = href ? 'a' : 'span';
  return (
    <Tag className="dp-pchip" href={href || undefined} title={login}>
      <img className="dp-pchip-av" src={`/api/avatar/${login}`} alt="" loading="lazy" />
      <span className="dp-ell">{label || login}</span>
      {onRemove && <span className="dp-pchip-x" role="button" aria-label={`Remove ${login}`} onClick={(e) => { e.preventDefault(); onRemove(); }}>×</span>}
    </Tag>
  );
}
