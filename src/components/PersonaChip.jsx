// href null renders a span: use it inside another link (dashboard card).
export function PersonaChip({ login, label, onRemove, href = `#/persona/${login}` }) {
  const Tag = href ? 'a' : 'span';
  return (
    <Tag className="persona-chip" href={href || undefined} title={login}>
      <img className="ava" src={`/api/avatar/${login}`} alt="" loading="lazy" />
      <span>{label || login}</span>
      {onRemove && <span className="remove" onClick={(e) => { e.preventDefault(); onRemove(); }}>×</span>}
    </Tag>
  );
}
