import React from 'react';
import type { AIConnection, AIProvider } from '../../shared/types';
import { AI_PROVIDERS } from '../../shared/constants';
import { t } from '../../shared/i18n';

interface Props {
  providers: AIProvider[];
  connections: Partial<Record<AIProvider, Pick<AIConnection, 'status'>>>;
  order: AIProvider[];
  onOrderChange: (order: AIProvider[]) => void;
  turns: number;
  onTurnsChange: (turns: number) => void;
  disabled?: boolean;
}

// 自由模式 settings: which AIs take part, in which order (click order), and how many AI turns.
export default function RelayConfig({ providers, connections, order, onOrderChange, turns, onTurnsChange, disabled = false }: Props) {
  const toggle = (provider: AIProvider) => {
    if (disabled) return;
    onOrderChange(order.includes(provider) ? order.filter((candidate) => candidate !== provider) : [...order, provider]);
  };
  const move = (index: number, delta: number) => {
    if (disabled) return;
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    const next = [...order];
    [next[index], next[target]] = [next[target], next[index]];
    onOrderChange(next);
  };

  return (
    <div className="rounded-lg border border-sky-100 bg-sky-50/70 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-semibold text-sky-900">🔁 {t('mode.relay')}</div>
        <label className="flex items-center gap-1.5 text-[11px] text-slate-600">
          {t('relay.turns')}
          <input type="number" min={1} max={50} value={turns} disabled={disabled}
            onChange={(event) => onTurnsChange(Number(event.target.value))}
            className="w-14 rounded-md border border-slate-300 bg-white px-1.5 py-0.5 text-xs text-slate-900 disabled:opacity-50" />
        </label>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-slate-600">{t('mode.relay.desc')}</p>
      <div role="group" aria-label={t('relay.participants')} className="mt-2 flex flex-wrap gap-1.5">
        {providers.map((provider) => {
          const position = order.indexOf(provider);
          const selected = position >= 0;
          const ready = connections[provider]?.status === 'connected';
          return (
            <button key={provider} type="button" aria-pressed={selected} disabled={disabled} onClick={() => toggle(provider)}
              className={`rounded-full border px-2.5 py-1 text-[11px] font-medium disabled:cursor-not-allowed disabled:opacity-60 ${selected ? 'border-sky-300 bg-white text-sky-800' : 'border-slate-200 bg-white text-slate-400'}`}>
              <span className={`mr-1 inline-block h-1.5 w-1.5 rounded-full ${ready ? 'bg-emerald-500' : 'bg-slate-300'}`} />
              {selected && <span className="mr-1 font-bold">{position + 1}.</span>}
              {AI_PROVIDERS[provider].name}
            </button>
          );
        })}
      </div>
      {order.length > 1 && (
        <ol aria-label={t('relay.order')} className="mt-2 flex flex-wrap items-center gap-1 text-[11px] text-slate-700">
          {order.map((provider, index) => (
            <li key={provider} className="flex items-center gap-0.5 rounded-md bg-white px-1.5 py-0.5 ring-1 ring-slate-200">
              <button type="button" disabled={disabled || index === 0} onClick={() => move(index, -1)} aria-label={t('relay.move_up', { provider: AI_PROVIDERS[provider].name })} className="px-0.5 text-slate-400 hover:text-slate-800 disabled:opacity-30">◀</button>
              <span style={{ color: AI_PROVIDERS[provider].color }} className="font-semibold">{AI_PROVIDERS[provider].name}</span>
              <button type="button" disabled={disabled || index === order.length - 1} onClick={() => move(index, 1)} aria-label={t('relay.move_down', { provider: AI_PROVIDERS[provider].name })} className="px-0.5 text-slate-400 hover:text-slate-800 disabled:opacity-30">▶</button>
              {index < order.length - 1 && <span aria-hidden="true" className="ml-1 text-slate-400">→</span>}
            </li>
          ))}
          <li aria-hidden="true" className="text-slate-400">↺</li>
        </ol>
      )}
    </div>
  );
}
