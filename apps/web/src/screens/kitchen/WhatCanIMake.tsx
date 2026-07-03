// "What can I make with…" (P3, docs/42 §3 + docs/38 Loop C) — type or tap a few
// on-hand ingredients → a DETERMINISTIC coverage ranking of the library ("7 of 9 on
// hand"; pantry staples always count). When Intelligence + the cooking-suggestions
// toggle are on, a "More ideas" action asks Claude for free-form ideas and fails SOFT
// back to the deterministic list. Shared by the Cooking screen (desktop + mobile) and
// the kiosk kitchen tab — never tablet-only (standing rule).

import { useState, type CSSProperties } from 'react';
import { Badge, Button, Icon } from '../../components/ui';
import { api } from '../../lib/api';
import type { Recipe, WhatCanIMakeResult } from '../../lib/types';
import { RecipePhoto } from './shared';

export function WhatCanIMake({
  recipes,
  aiOn,
  wide,
  kiosk = false,
  onOpenRecipe,
}: {
  recipes: Recipe[];
  /** Intelligence master + cooking-suggestions feature both on. */
  aiOn: boolean;
  wide: boolean;
  kiosk?: boolean;
  onOpenRecipe: (r: Recipe) => void;
}) {
  const [chips, setChips] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [results, setResults] = useState<WhatCanIMakeResult[] | null>(null);
  const [ideas, setIdeas] = useState<Array<{ title: string; note: string }> | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<'rank' | 'ideas' | null>(null);

  const byId = new Map(recipes.map((r) => [r.id, r]));

  const addChip = () => {
    const v = draft.trim().toLowerCase();
    if (v && !chips.includes(v)) setChips([...chips, v]);
    setDraft('');
  };

  const search = async (terms: string[]) => {
    if (!terms.length) return;
    setBusy('rank');
    setNote(null);
    setIdeas(null);
    try {
      const r = await api.kitchen.whatCanIMake(terms);
      setResults(r.results);
      if (!r.results.length) setNote('No library matches — try “More ideas” or fewer ingredients.');
    } catch {
      setNote('Search failed — try again');
    } finally {
      setBusy(null);
    }
  };

  const moreIdeas = async () => {
    if (!chips.length) return;
    setBusy('ideas');
    setNote(null);
    try {
      const r = await api.kitchen.whatCanIMakeIdeas(chips);
      if (r.ok && r.ideas.length) setIdeas(r.ideas);
      else setNote(r.reason === 'intelligence-off' ? 'Intelligence is off — showing the library ranking only.' : 'No extra ideas this time.');
    } catch {
      setNote('Ideas unavailable — the library ranking above still stands.'); // fail soft
    } finally {
      setBusy(null);
    }
  };

  const chipStyle: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    minHeight: kiosk ? 40 : 30,
    padding: '4px 12px',
    borderRadius: 999,
    border: '1px solid var(--border-2)',
    background: 'var(--surface-2)',
    color: 'var(--text-1)',
    fontSize: kiosk ? 13.5 : 12,
    cursor: 'pointer',
  };

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icon name="refrigerator" size={16} color="var(--battery)" />
        <h2 style={{ margin: 0, fontSize: 12, fontWeight: 700, color: 'var(--text-3)', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
          What can I make with…
        </h2>
      </div>

      {/* On-hand input: chips + free text. */}
      <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', alignItems: 'center' }}>
        {chips.map((c) => (
          <button key={c} type="button" style={chipStyle} onClick={() => setChips(chips.filter((x) => x !== c))}>
            {c} <Icon name="x" size={12} />
          </button>
        ))}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addChip();
            }
          }}
          onBlur={addChip}
          placeholder={chips.length ? '＋ add' : 'chicken thighs, courgette, rice…'}
          style={{
            background: 'var(--surface-2)',
            border: '1px solid var(--border-1)',
            borderRadius: 999,
            padding: kiosk ? '9px 14px' : '5px 12px',
            fontSize: kiosk ? 13.5 : 12,
            color: 'var(--text-1)',
            width: chips.length ? 110 : 220,
            outline: 'none',
            minHeight: kiosk ? 40 : undefined,
          }}
        />
        <Button
          size={kiosk ? 'md' : 'sm'}
          variant="secondary"
          loading={busy === 'rank'}
          disabled={!chips.length && !draft.trim()}
          iconLeft={<Icon name="search" size={13} />}
          onClick={() => {
            const pending = draft.trim().toLowerCase();
            const terms = pending && !chips.includes(pending) ? [...chips, pending] : chips;
            if (pending) {
              setChips(terms);
              setDraft('');
            }
            void search(terms);
          }}
        >
          Find recipes
        </Button>
        {aiOn && results && (
          <Button size={kiosk ? 'md' : 'sm'} variant="ghost" loading={busy === 'ideas'} iconLeft={<Icon name="sparkles" size={13} />} onClick={() => void moreIdeas()}>
            More ideas
          </Button>
        )}
      </div>

      {note && <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{note}</div>}

      {/* Deterministic coverage ranking. */}
      {results && results.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {results.map((res) => {
            const r = byId.get(res.recipeId);
            if (!r) return null;
            return (
              <button
                key={res.recipeId}
                type="button"
                onClick={() => onOpenRecipe(r)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 11,
                  padding: 8,
                  minHeight: kiosk ? 64 : 56,
                  border: '1px solid var(--border-1)',
                  borderRadius: 'var(--radius-lg)',
                  background: 'var(--surface-1)',
                  color: 'var(--text-1)',
                  textAlign: 'left',
                  cursor: 'pointer',
                }}
              >
                <RecipePhoto recipe={r} height={kiosk ? 48 : 42} radius="var(--radius-md)" style={{ width: kiosk ? 48 : 42 }} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: kiosk ? 14.5 : 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.title}
                  </span>
                  <span style={{ display: 'block', fontSize: kiosk ? 12 : 11, color: 'var(--text-3)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.prepMin + r.cookMin} min
                    {res.missing.length > 0 ? ` · missing: ${res.missing.slice(0, 3).join(', ')}${res.missing.length > 3 ? '…' : ''}` : ' · everything on hand'}
                  </span>
                </span>
                <Badge tone={res.have === res.total ? 'solar' : 'neutral'}>
                  {res.have} of {res.total} on hand
                </Badge>
              </button>
            );
          })}
        </div>
      )}

      {/* Claude free-form ideas (Intelligence-gated, fail-soft). */}
      {ideas && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, borderLeft: '2px solid var(--solar-dim, var(--solar))', paddingLeft: 12 }}>
          <span style={{ fontSize: 10.5, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--solar)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Icon name="sparkles" size={12} /> More ideas
          </span>
          {ideas.map((idea, i) => (
            <div key={i} style={{ fontSize: wide ? 13 : 12.5 }}>
              <b style={{ fontWeight: 600 }}>{idea.title}</b>
              {idea.note && <span style={{ color: 'var(--text-2)' }}> — {idea.note}</span>}
            </div>
          ))}
          <span style={{ fontSize: 10.5, color: 'var(--text-3)' }}>Off-library ideas — cook freestyle, or import a recipe URL to keep one.</span>
        </div>
      )}
    </section>
  );
}
