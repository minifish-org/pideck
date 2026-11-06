import { useDeferredValue, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ModelOption, ModelRef, Thinking } from '../shared/api';
import { Icon } from './Icons';

export function modelKey(model: ModelRef) {
  return `${model.provider}/${model.id}`;
}

export function providerLabel(provider: string) {
  return ({ openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google', openrouter: 'OpenRouter',
    github: 'GitHub', xai: 'xAI', deepseek: 'DeepSeek', mistral: 'Mistral' } as Record<string, string>)[provider]
    ?? provider.split('-').map((word) => word[0]?.toUpperCase() + word.slice(1)).join(' ');
}

export function ModelPicker({ models, selected, label, description, thinking, onThinkingChange, onChoose }: {
  models: ModelOption[];
  selected: ModelOption | undefined;
  label: string;
  description: string;
  thinking: { level: Thinking; labels: Record<Thinking, string> } | undefined;
  onThinkingChange: (level: Thinking) => void;
  onChoose: (option: ModelOption) => void;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const terms = query.trim();
  const deferredQuery = useDeferredValue(terms);
  const currentKey = selected && modelKey(selected);
  const hasUnconfigured = models.some((model) => !model.configured);
  const results = useMemo(() => {
    const words = deferredQuery.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return models.filter((model) => {
      if (!model.configured && !showAll && !words.length) return false;
      const label = `${model.name} ${providerLabel(model.provider)} ${model.id}`.toLocaleLowerCase();
      return words.every((word) => label.includes(word));
    }).sort((left, right) => Number(right.configured) - Number(left.configured)
      || (words.length ? 0 : Number(modelKey(right) === currentKey) - Number(modelKey(left) === currentKey)));
  }, [currentKey, deferredQuery, models, showAll]);
  const sections = [
    { label: 'Available', options: results.filter(({ configured }) => configured) },
    { label: 'Requires connection', options: results.filter(({ configured }) => !configured) },
  ];
  const showSections = sections.every(({ options }) => options.length > 0);

  useLayoutEffect(() => {
    if (open) search.current?.focus({ preventScroll: true });
  }, [open]);

  function choose(model: ModelOption) {
    panel.current?.hidePopover();
    onChoose(model);
  }

  return <>
    <button className="model-trigger" type="button" ref={trigger} aria-label="Model" aria-description={description}
      title={description} popoverTarget={id}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowDown' || panel.current?.matches(':popover-open')) return;
        event.preventDefault();
        event.currentTarget.click();
      }}>
      <span>{label}</span><Icon name="down" width={12} height={12} />
    </button>
    <div className="chat-popover model-popover" id={id} popover="auto" role="region" aria-label="Choose a model" ref={panel}
      onBlur={(event) => {
        if (event.relatedTarget instanceof Node && event.relatedTarget !== trigger.current
          && !event.currentTarget.contains(event.relatedTarget) && event.currentTarget.matches(':popover-open')) {
          event.currentTarget.hidePopover();
        }
      }}
      onToggle={(event) => {
        const visible = event.newState === 'open';
        setOpen(visible);
        if (!visible) {
          setQuery('');
          setShowAll(false);
        }
      }}>
      {open && <>
        <div className="model-search">
          <Icon name="search" width={15} height={15} />
          <input type="search" ref={search} aria-label="Search models" placeholder="Search models or providers…" value={query}
            onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === 'Enter') {
                event.preventDefault();
                if (terms && terms === deferredQuery && results[0]) choose(results[0]);
              } else if (event.key === 'ArrowDown') {
                event.preventDefault();
                panel.current?.querySelector<HTMLButtonElement>('.model-option')?.focus();
              }
            }} />
        </div>
        <div className="model-results" onKeyDown={(event) => {
          if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
          const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.model-option')];
          const index = options.findIndex((option) => option === document.activeElement);
          if (index < 0) return;
          event.preventDefault();
          const next = options[{ ArrowUp: index - 1, ArrowDown: index + 1, Home: 0, End: options.length - 1 }[event.key]!];
          if (next) next.focus();
          else if (event.key === 'ArrowUp') search.current?.focus();
        }}>
          {sections.map(({ label, options }) => options.length > 0 && <section key={label} className="model-section" aria-label={label}>
            {showSections && <h3>{label}</h3>}
            <ul>
              {options.map((option) => {
                const current = currentKey === modelKey(option);
                const context = option.contextWindow ? ` · ${Math.round(option.contextWindow / 1000).toLocaleString()}k context` : '';
                return <li key={modelKey(option)}>
                  <button className="model-option" type="button" tabIndex={option === results[0] ? 0 : -1}
                    aria-current={current ? 'true' : undefined} onClick={() => choose(option)}>
                    <span className="model-option-label"><strong>{option.name}</strong>
                      <small>{providerLabel(option.provider)}{context}{option.supportsImages ? ' · Images' : ''}</small>
                    </span>
                    {current && option.configured ? <Icon className="model-option-mark" name="check" />
                      : !option.configured && <span className="model-option-connect">Connect <Icon name="chevron" width={12} height={12} /></span>}
                  </button>
                </li>;
              })}
            </ul>
          </section>)}
          {!results.length && <p className="model-empty">{models.length ? 'No models match your search.' : 'No models are available.'}</p>}
        </div>
        {hasUnconfigured && !terms && <button className="model-more inline-action" type="button" aria-expanded={showAll}
          onClick={() => setShowAll(!showAll)}>{showAll ? 'Show connected models' : 'Browse all models'}</button>}
        {thinking && selected && <label className="model-effort">
          Thinking level
          <select value={thinking.level} onChange={(event) => onThinkingChange(event.target.value as Thinking)}>
            {selected.thinking.map((level) => <option key={level} value={level}>{thinking.labels[level]}</option>)}
          </select>
        </label>}
      </>}
    </div>
  </>;
}
