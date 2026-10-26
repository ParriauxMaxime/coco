import React, { useState } from 'react';
import type { ReactNode } from 'react';
import { Inline } from '../../components/Blocks.tsx';
import Markdown from '../../components/Markdown.tsx';
import Icon from '../Icon.tsx';
import type { CardOption } from '../../types.ts';

export function Sure({ value, title = 'How sure the agent is of this option' }: { value?: number; title?: string }) {
  if (value == null) return null;
  const n = Math.round(value <= 1 ? value * 100 : value);
  return <span className={`dp-chip ${n >= 75 ? 'dp-ok' : n >= 50 ? 'dp-warn' : 'dp-bad'}`} title={title}>{n}% sure</span>;
}
export const Rec = () => <span className="dp-chip dp-acc">recommended</span>;

export function Details({ text, markdown }: { text: string; markdown?: boolean }) {
  return markdown ? <div className="dp-cd-det dp-cd-md"><Markdown text={text} /></div> : <Inline as="div" className="dp-cd-det" text={text} />;
}

export function MoreButton({ open, onToggle, children = 'details' }: { open: boolean; onToggle: () => void; children?: ReactNode }) {
  return (
    <button type="button" className={`dp-btn dp-ghost dp-sm dp-cd-more${open ? ' dp-open' : ''}`} aria-expanded={open} onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggle(); }}>
      <Icon name="chevron-right" size={12} />{children}
    </button>
  );
}

type OptionProps = { o: CardOption; on: boolean; multi?: boolean; name: string; ro: boolean; onPick: () => void; open?: boolean; markdown?: boolean };

function Option({ o, on, multi, name, ro, onPick, open: initial = false, markdown }: OptionProps) {
  const [open, setOpen] = useState(initial);
  return (
    <div className="dp-cd-opt">
      <label className={`dp-opt${on ? ' dp-on' : ''}${ro ? ' dp-cd-ro' : ''}`}>
        <input className="dp-vh" type={multi ? 'checkbox' : 'radio'} name={name} checked={on} disabled={ro} onChange={onPick} />
        <span className={multi ? 'dp-check' : 'dp-radio'} />
        <span className="dp-ol"><Inline text={o.label} /></span>
        {o.recommended && <Rec />}
        <Sure value={o.confidence} />
        {o.effect && <span className="dp-chip dp-info dp-cd-eff" title="Picking it acts in coco at once, without a new turn of the agent">{o.effect.type === 'take_decision' ? 'takes the decision' : 'dismisses the finding'}</span>}
        {o.details && <MoreButton open={open} onToggle={() => setOpen(!open)} />}
      </label>
      {o.details && open && <Details text={o.details} markdown={markdown} />}
    </div>
  );
}

type Props = {
  name: string;
  label?: string;
  options: CardOption[];
  picked: string[];
  multi?: boolean;
  ro: boolean;
  onPick: (key: string) => void;
  openRecommended?: boolean;
  markdown?: boolean;
  done?: boolean;
  children?: ReactNode;
};

// one list of options to pick from, radio or checkbox, with recommended and "NN% sure" chips and folded details
export default function OptionPicker({ name, label, options, picked, multi, ro, onPick, openRecommended, markdown, done, children }: Props) {
  return (
    <div className={`dp-cd-opts${done ? ' dp-cd-done' : ''}`} role={multi ? 'group' : 'radiogroup'} aria-label={label}>
      {options.map((o) => <Option key={o.key} o={o} on={picked.includes(o.key)} multi={multi} name={name} ro={ro} onPick={() => onPick(o.key)} open={openRecommended && o.recommended} markdown={markdown} />)}
      {children}
    </div>
  );
}
