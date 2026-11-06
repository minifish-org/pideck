import { useDeferredValue, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ModelOption, ModelRef } from '../shared/api';
import { Icon } from './Icons';

export function modelKey(model: ModelRef) {
  return `${model.provider}/${model.id}`;
}

export function providerLabel(provider: string) {
  return ({ openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google', openrouter: 'OpenRouter',
    github: 'GitHub', xai: 'xAI', deepseek: 'DeepSeek', mistral: 'Mistral' } as Record<string, string>)[provider]
    ?? provider.split('-').map((word) => word[0]?.toUpperCase() + word.slice(1)).join(' ');
}

export function ModelPicker({ models, selected, onChoose, onClose }: {
  models: ModelOption[];
  selected: ModelOption | undefined;
  onChoose: (option: ModelOption) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const results = useMemo(() => {
    const terms = deferredQuery.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return models.filter((model) => {
      const label = `${model.name} ${providerLabel(model.provider)} ${model.id}`.toLocaleLowerCase();
      return terms.every((term) => label.includes(term));
    }).sort((left, right) => Number(right.configured) - Number(left.configured));
  }, [deferredQuery, models]);
  const sections = [
    { label: 'Available', options: results.filter(({ configured }) => configured) },
    { label: 'Provider setup required', options: results.filter(({ configured }) => !configured) },
  ];

  useLayoutEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal();
    dialog.current?.querySelector('input')?.focus();
  }, []);

  function choose(model: ModelOption) {
    dialog.current?.close();
    onChoose(model);
  }

  function close() {
    dialog.current?.close();
    onClose();
  }

  return <dialog className="settings-dialog model-dialog" ref={dialog} aria-labelledby="model-title"
    onCancel={(event) => { event.preventDefault(); close(); }}>
    <div className="dialog-heading">
      <h2 id="model-title">Choose a model</h2>
      <button className="icon-button" type="button" aria-label="Close model picker" onClick={close}><Icon name="close" /></button>
    </div>
    <div className="model-search">
      <Icon name="search" width={15} height={15} />
      <input type="search" aria-label="Search models" placeholder="Search models or providers…" value={query}
        onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
          if (query !== deferredQuery || !results[0]) return;
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            choose(results[0]);
          } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            dialog.current?.querySelector<HTMLButtonElement>('.model-option')?.focus();
          }
        }} />
    </div>
    <div className="model-results" onKeyDown={(event) => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      const options = [...event.currentTarget.querySelectorAll('button')];
      const index = options.findIndex((option) => option === document.activeElement);
      if (index < 0) return;
      event.preventDefault();
      const next = event.key === 'ArrowDown' ? options[index + 1] : options[index - 1];
      if (next) next.focus();
      else if (event.key === 'ArrowUp') dialog.current?.querySelector('input')?.focus();
    }}>
      {sections.map(({ label, options }) => options.length > 0 && <section key={label} className="model-section" aria-label={label}>
        <h3>{label}</h3>
        <ul>
          {options.map((option) => {
            const current = selected && modelKey(selected) === modelKey(option);
            const context = option.contextWindow ? ` · ${Math.round(option.contextWindow / 1000).toLocaleString()}k context` : '';
            return <li key={modelKey(option)}>
              <button className="model-option" type="button" aria-current={current ? 'true' : undefined} onClick={() => choose(option)}>
                <span className="model-option-label"><strong>{option.name}</strong>
                  <small>{providerLabel(option.provider)}{context}{option.supportsImages ? ' · Images' : ''}</small>
                </span>
                {current && <Icon className="model-option-mark" name="check" />}
              </button>
            </li>;
          })}
        </ul>
      </section>)}
      {!results.length && <p className="model-empty">{models.length ? 'No models match your search.' : 'No models are available.'}</p>}
    </div>
  </dialog>;
}
