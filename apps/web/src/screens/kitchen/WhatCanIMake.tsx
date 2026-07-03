// "What can I make with…" (P3, docs/42 §3 + docs/38 Loop C) — three ways in:
//   1. A DETERMINISTIC coverage ranking of the library from a few on-hand ingredients
//      ("7 of 9 on hand"; pantry staples always count) — the always-works default, no AI.
//   2. A tap-to-add ingredient PALETTE (sourced from the library's own ingredients, most-
//      frequent first, blended with a curated Spanish-kitchen fallback) so you don't have
//      to type — chips toggle on/off. Inline on desktop; behind a disclosure on mobile.
//   3. An AI QUESTION box (Intelligence-gated) for free-form asks ("a nice recipe for
//      healthy pizzas with veggie dough") → cited library recipes + fresh off-library
//      ideas. Fails SOFT to a hint when Intelligence is off.
// Shared by the Cooking screen (desktop + mobile) and the kiosk kitchen tab (kiosk prop) —
// never tablet-only (standing rule).

import { useMemo, useState, type CSSProperties } from 'react';
import { Badge, Button, Icon } from '../../components/ui';
import { api } from '../../lib/api';
import type { Recipe, WhatCanIMakeResult } from '../../lib/types';
import { RecipePhoto } from './shared';
import { buildPalette, normalizeIngredientText, SECTION_ORDER, type PaletteSection } from './ingredientPalette';

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
  const [busy, setBusy] = useState<'rank' | 'ideas' | 'answer' | null>(null);
  // Palette collapses behind a disclosure on mobile so it doesn't dominate; open on desktop.
  const [paletteOpen, setPaletteOpen] = useState(wide);
  // AI question box (Feature 1b).
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<{ libraryIds: string[]; ideas: Array<{ title: string; note: string }> } | null>(null);
  const [answerNote, setAnswerNote] = useState<string | null>(null);

  const byId = useMemo(() => new Map(recipes.map((r) => [r.id, r])), [recipes]);
  const palette = useMemo(() => buildPalette(recipes), [recipes]);
  // Normalised keys of the current chips → drives palette selected state.
  const chipKeys = useMemo(() => new Set(chips.map((c) => normalizeIngredientText(c))), [chips]);

  const addChip = () => {
    const v = draft.trim().toLowerCase();
    if (v && !chips.includes(v)) setChips([...chips, v]);
    setDraft('');
  };

  const togglePalette = (label: string) => {
    const key = normalizeIngredientText(label);
    if (chipKeys.has(key)) {
      setChips(chips.filter((c) => normalizeIngredientText(c) !== key));
    } else {
      setChips([...chips, label.toLowerCase()]);
    }
  };

  const search = async (terms: string[]) => {
    if (!terms.length) return;
    setBusy('rank');
    setNote(null);
    setIdeas(null);
    try {
      const r = await api.kitchen.whatCanIMake(terms);
      setResults(r.results);
      if (!r.results.length) setNote('No library matches — try “More ideas”, the question box, or fewer ingredients.');
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

  const askQuestion = async () => {
    const q = question.trim();
    if (!q) return;
    setBusy('answer');
    setAnswerNote(null);
    setAnswer(null);
    try {
      const r = await api.kitchen.whatCanIMakeAnswer(q, chips);
      if (r.ok && (r.libraryIds.length || r.ideas.length)) {
        setAnswer({ libraryIds: r.libraryIds, ideas: r.ideas });
      } else if (r.reason === 'intelligence-off') {
        setAnswerNote('Enable Intelligence in Settings ▸ Intelligence to ask free-form recipe questions.');
      } else {
        setAnswerNote('No answer this time — try rephrasing, or use the ingredient search above.');
      }
    } catch {
      setAnswerNote('The question box is unavailable right now — the ingredient search above still works.'); // fail soft
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

  const paletteChip = (selected: boolean): CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    minHeight: kiosk ? 40 : 28,
    padding: kiosk ? '6px 13px' : '4px 11px',
    borderRadius: 999,
    border: `1px solid ${selected ? 'var(--battery)' : 'var(--border-1)'}`,
    background: selected ? 'var(--battery-wash)' : 'var(--surface-1)',
    color: selected ? 'var(--battery)' : 'var(--text-2)',
    fontSize: kiosk ? 13 : 11.5,
    fontWeight: selected ? 600 : 400,
    cursor: 'pointer',
  });

  const inputStyle: CSSProperties = {
    background: 'var(--surface-2)',
    border: '1px solid var(--border-1)',
    borderRadius: 999,
    padding: kiosk ? '9px 14px' : '5px 12px',
    fontSize: kiosk ? 13.5 : 12,
    color: 'var(--text-1)',
    outline: 'none',
    minHeight: kiosk ? 40 : undefined,
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
          style={{ ...inputStyle, width: chips.length ? 110 : 220 }}
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

      {/* Tap-to-add ingredient palette (Feature 1a). Inline on desktop; disclosure on mobile. */}
      {palette.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {!wide && (
            <button
              type="button"
              onClick={() => setPaletteOpen((o) => !o)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                alignSelf: 'flex-start',
                background: 'transparent',
                border: 'none',
                color: 'var(--text-2)',
                fontSize: kiosk ? 13 : 12,
                fontWeight: 600,
                cursor: 'pointer',
                padding: kiosk ? '6px 2px' : '2px',
                minHeight: kiosk ? 40 : undefined,
              }}
              aria-expanded={paletteOpen}
            >
              <Icon name={paletteOpen ? 'chevron-down' : 'chevron-right'} size={14} />
              {paletteOpen ? 'Hide ingredients' : '＋ Add ingredients'}
            </button>
          )}
          {paletteOpen &&
            SECTION_ORDER.map((section) => {
              const items = palette.filter((p) => p.section === (section as PaletteSection));
              if (!items.length) return null;
              return (
                <div key={section} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  <span style={{ fontSize: 10, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text-3)' }}>{section}</span>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {items.map((it) => {
                      // Selected state keys off the LABEL (what togglePalette adds as a
                      // chip), not it.key — a library item is keyed by its Spanish name
                      // ("cebolla") while the chip carries the English label ("onion").
                      const selected = chipKeys.has(normalizeIngredientText(it.label));
                      return (
                        <button
                          key={it.key}
                          type="button"
                          aria-pressed={selected}
                          style={paletteChip(selected)}
                          onClick={() => togglePalette(it.label)}
                        >
                          {selected && <Icon name="check" size={11} />}
                          {it.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
        </div>
      )}

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

      {/* Claude free-form ideas (from "More ideas", Intelligence-gated, fail-soft). */}
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

      {/* AI question box (Feature 1b) — the headline free-form ask. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 2, paddingTop: 10, borderTop: '1px solid var(--border-1)' }}>
        <span style={{ fontSize: 10.5, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text-3)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Icon name="wand-sparkles" size={12} color="var(--battery)" /> Ask for a recipe idea
        </span>
        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && aiOn) {
                e.preventDefault();
                void askQuestion();
              }
            }}
            placeholder="e.g. healthy pizzas with veggie dough"
            style={{ ...inputStyle, flex: 1, minWidth: 200, borderRadius: 'var(--radius-md)' }}
          />
          <Button
            size={kiosk ? 'md' : 'sm'}
            variant="secondary"
            loading={busy === 'answer'}
            disabled={!aiOn || !question.trim()}
            iconLeft={<Icon name="sparkles" size={13} />}
            onClick={() => void askQuestion()}
          >
            Ask
          </Button>
        </div>
        {!aiOn && (
          <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
            Enable Intelligence in Settings ▸ Intelligence to ask free-form recipe questions.
          </span>
        )}
        {answerNote && <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{answerNote}</span>}
        {answer && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {answer.libraryIds.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontSize: 10.5, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text-3)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <Icon name="book-open" size={12} color="var(--battery)" /> From your library
                </span>
                {answer.libraryIds.map((id) => {
                  const r = byId.get(id);
                  if (!r) return null;
                  return (
                    <button
                      key={id}
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
                        <span style={{ display: 'block', fontSize: kiosk ? 12 : 11, color: 'var(--text-3)', marginTop: 2 }}>{r.prepMin + r.cookMin} min</span>
                      </span>
                      <Icon name="chevron-right" size={16} color="var(--text-3)" />
                    </button>
                  );
                })}
              </div>
            )}
            {answer.ideas.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, borderLeft: '2px solid var(--solar-dim, var(--solar))', paddingLeft: 12 }}>
                <span style={{ fontSize: 10.5, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--solar)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <Icon name="lightbulb" size={12} /> Fresh ideas
                </span>
                {answer.ideas.map((idea, i) => (
                  <div key={i} style={{ fontSize: wide ? 13 : 12.5 }}>
                    <b style={{ fontWeight: 600 }}>{idea.title}</b>
                    {idea.note && <span style={{ color: 'var(--text-2)' }}> — {idea.note}</span>}
                  </div>
                ))}
                <span style={{ fontSize: 10.5, color: 'var(--text-3)' }}>Off-library — cook freestyle, or import a recipe URL to keep one.</span>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
