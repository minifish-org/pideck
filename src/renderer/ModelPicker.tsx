import { useDeferredValue, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ModelOption, ModelRef, Thinking } from '../shared/api';
import { Icon } from './Icons';
import { readableError } from './conversation';

export function modelKey(model: ModelRef) {
  return `${model.provider}/${model.id}`;
}

export function providerLabel(provider: string) {
  return ({ openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google', openrouter: 'OpenRouter',
    github: 'GitHub', xai: 'xAI', deepseek: 'DeepSeek', mistral: 'Mistral' } as Record<string, string>)[provider]
    ?? provider.split('-').map((word) => word[0]?.toUpperCase() + word.slice(1)).join(' ');
}

function contextLabel(tokens: number) {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: tokens < 1_000_000 ? 0 : 2 })
    .format(tokens).replace('K', 'k');
}

export function ModelPicker({ models, selected, label, description, thinking, onThinkingChange, onChoose, onLoadSavedModels }: {
  models: ModelOption[];
  selected: ModelOption | undefined;
  label: ReactNode;
  description: string;
  thinking: { level: Thinking; labels: Record<Thinking, string> } | undefined;
  onThinkingChange: (level: Thinking) => void;
  onChoose: (option: ModelOption) => void;
  onLoadSavedModels?: () => Promise<ModelOption[]>;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [savedModels, setSavedModels] = useState<{ loading: boolean; error?: string }>({ loading: false });
  const terms = query.trim();
  const deferredQuery = useDeferredValue(terms);
  const currentKey = selected && modelKey(selected);
  const available = useMemo(() => models.filter(({ configured }) => configured), [models]);
  const results = useMemo(() => {
    const words = deferredQuery.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return available.toSorted((left, right) =>
      Number(modelKey(right) === currentKey) - Number(modelKey(left) === currentKey));
    return available.filter((model) => {
      const label = `${model.name} ${providerLabel(model.provider)} ${model.id}`.toLocaleLowerCase();
      return words.every((word) => label.includes(word));
    });
  }, [available, currentKey, deferredQuery]);
  const groups = useMemo(() => {
    const providers = new Map<string, ModelOption[]>();
    for (const option of results) {
      const group = providers.get(option.provider);
      if (group) group.push(option);
      else providers.set(option.provider, [option]);
    }
    return [...providers];
  }, [results]);

  useLayoutEffect(() => {
    if (open) search.current?.focus({ preventScroll: true });
  }, [open]);

  function close() {
    panel.current?.hidePopover();
    trigger.current?.focus();
  }

  function choose(option: ModelOption) {
    onChoose(option);
    if (option.thinking.length <= 1) close();
  }

  async function loadSavedModels() {
    if (!onLoadSavedModels || savedModels.loading) return;
    setSavedModels({ loading: true });
    try {
      await onLoadSavedModels();
      setSavedModels({ loading: false });
    } catch (error) {
      setSavedModels({ loading: false, error: readableError(error) });
    }
  }

  return <>
    <button className="model-trigger" type="button" ref={trigger} aria-label="Model" aria-description={description}
      title={description} popoverTarget={id}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowDown' || panel.current?.matches(':popover-open')) return;
        event.preventDefault();
        event.currentTarget.click();
      }}>
      {label}<Icon name="down" width={12} height={12} />
    </button>
    <div className="chat-popover model-popover" id={id} popover="auto" role="region" aria-label="Choose a model" ref={panel}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.currentTarget.querySelector('select:open')) return;
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
      onBlur={(event) => {
        if (event.relatedTarget instanceof Node && event.relatedTarget !== trigger.current
          && !event.currentTarget.contains(event.relatedTarget) && event.currentTarget.matches(':popover-open')) {
          event.currentTarget.hidePopover();
        }
      }}
      onToggle={(event) => {
        const visible = event.newState === 'open';
        setOpen(visible);
        if (visible) void loadSavedModels();
        else setQuery('');
      }}>
      {open && <>
        <div className="model-search">
          <Icon name="search" width={15} height={15} />
          <input type="search" ref={search} aria-label="Search models" placeholder="Search models or providers…" value={query}
            onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === 'Enter') {
                event.preventDefault();
                if (terms && terms === deferredQuery && results[0]) {
                  panel.current?.querySelector<HTMLButtonElement>('.model-option')?.focus();
                  choose(results[0]);
                }
              } else if (event.key === 'ArrowDown') {
                event.preventDefault();
                panel.current?.querySelector<HTMLButtonElement>('.model-option')?.focus();
              }
            }} />
        </div>
        {onLoadSavedModels && (savedModels.loading
          ? <div className="model-load-status" role="status">Loading saved models…</div>
          : savedModels.error && <div className="model-load-status" role="alert">
            <span>{savedModels.error}</span>
            <button className="inline-action" type="button" onClick={() => {
              search.current?.focus({ preventScroll: true });
              void loadSavedModels();
            }}>Retry</button>
          </div>)}
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
          {groups.length > 0 ? groups.map(([provider, options]) => <div className="model-group" key={provider}
            role="group" aria-label={`${providerLabel(provider)} models`}>
            <div className="model-group-label" aria-hidden="true">{providerLabel(provider)}</div>
            <ul>{options.map((option) => {
              const current = currentKey === modelKey(option);
              const description = [option.name, providerLabel(provider),
                option.contextWindow && `${option.contextWindow.toLocaleString()} token context`,
                option.supportsImages && 'Supports images'].filter(Boolean).join(' · ');
              return <li key={modelKey(option)}>
                <button className="model-option" type="button" tabIndex={option === results[0] ? 0 : -1}
                  aria-label={description} title={description}
                  aria-current={current ? 'true' : undefined} onClick={() => choose(option)}>
                  <span className="model-option-label"><strong>{option.name}</strong>
                    <small className="model-option-meta" aria-hidden="true">
                      {option.contextWindow ? <span title={`${option.contextWindow.toLocaleString()} token context`}>{contextLabel(option.contextWindow)}</span> : null}
                      <span className="model-capability" title={option.supportsImages ? 'Supports images' : undefined}>
                        {option.supportsImages && <Icon name="picture" width={13} height={13} />}
                      </span>
                    </small>
                  </span>
                  <Icon className="model-option-mark" name="check" />
                </button>
              </li>;
            })}</ul>
          </div>) : !onLoadSavedModels && <p className="model-empty">{available.length ? 'No models match your search.' : 'No models are available.'}</p>}
        </div>
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
