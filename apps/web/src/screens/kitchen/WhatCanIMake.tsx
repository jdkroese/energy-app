// "Find or invent a recipe" (docs/43, evolving docs/42 §3) — the DISCOVERY front door.
// Three ways in, deterministic path always free/offline:
//   1. A tap-to-add ingredient PALETTE (from the library's own ingredients, most-frequent
//      first, blended with a curated Spanish-kitchen fallback) + free-text chips.
//   2. Two actions on the ingredient set: "Search cookbook" (DETERMINISTIC coverage rank —
//      no AI, always works) and "Invent recipes" (AI GENERATES complete candidate recipes
//      from those ingredients).
//   3. A QUESTION box (the primary "ask for a couple of nice recipes" entry) → AI generates
//      candidates from the question (+ any selected ingredients).
// Results render in TWO clearly-labelled groups of consistent recipe cards: "From your
// cookbook" (deterministic matches → open the existing quick-view) and "Fresh ideas — tap
// to keep" (AI candidates → a candidate quick-view with Save / Add to week / Cook now; a
// candidate is marked "not saved yet" until saved). AI actions fail SOFT to a hint when
// Intelligence is off. Shared by the Cooking screen (desktop + mobile) and the kiosk tab
// (kiosk prop) — never tablet-only (standing rule); kiosk keeps generation as keep-only.

import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { Badge, Button, Icon } from '../../components/ui';
import { api } from '../../lib/api';
import type { Recipe, RecipeSlim, WhatCanIMakeResult } from '../../lib/types';
import { RecipePhoto, RecipeQuickView } from './shared';
import { buildPalette, normalizeIngredientText, SECTION_ORDER, type PaletteSection } from './ingredientPalette';

export function WhatCanIMake({
  recipes,
  aiOn,
  wide,
  kiosk = false,
  onOpenRecipe,
  showNutrition = true,
  onSaveCandidate,
  onSaveAndPlan,
  onSaveAndCook,
}: {
  recipes: RecipeSlim[];
  /** Intelligence master + recipe-generation feature both on (drives Invent/ask). */
  aiOn: boolean;
  wide: boolean;
  kiosk?: boolean;
  /** Cookbook results are RecipeSlim; AI candidates are full Recipe — only `.id` is needed
   *  here (the caller re-fetches the full recipe by id, docs/46 §2a P2). */
  onOpenRecipe: (r: Pick<Recipe, 'id'>) => void;
  showNutrition?: boolean;
  /** Save an AI candidate into the library → returns the saved recipe (refetches upstream). */
  onSaveCandidate?: (r: Recipe) => Promise<Recipe>;
  /** Save + plan into the first open day of the current week (Cooking only). */
  onSaveAndPlan?: (r: Pick<Recipe, 'id'>) => Promise<void>;
  /** Save + open cooking mode (Cooking only; kiosk navigates via onOpenRecipe). */
  onSaveAndCook?: (r: Pick<Recipe, 'id'>) => Promise<void>;
}) {
  const [chips, setChips] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [results, setResults] = useState<WhatCanIMakeResult[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<'rank' | 'invent' | 'ask' | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(wide);
  const [question, setQuestion] = useState('');

  // AI candidates (unsaved). `savedIds` maps a candidate id → its saved library id so a
  // re-open shows the saved recipe / hides the "not saved yet" marker.
  const [candidates, setCandidates] = useState<Recipe[] | null>(null);
  const [candidateNote, setCandidateNote] = useState<string | null>(null);
  const [savedIds, setSavedIds] = useState<Record<string, string>>({});
  // The full saved Recipe (with steps) keyed by the candidate's temp gen_<n> id — byId only
  // has the slim library index (docs/46 §2a P2), so re-opening an already-saved candidate
  // in the same session needs its own cache to keep steps/ingredients available.
  const [savedRecipes, setSavedRecipes] = useState<Record<string, Recipe>>({});
  const [openCandidate, setOpenCandidate] = useState<Recipe | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  const byId = useMemo(() => new Map(recipes.map((r) => [r.id, r])), [recipes]);
  const palette = useMemo(() => buildPalette(recipes), [recipes]);
  const chipKeys = useMemo(() => new Set(chips.map((c) => normalizeIngredientText(c))), [chips]);

  const collectTerms = (): string[] => {
    const pending = draft.trim().toLowerCase();
    if (pending && !chips.includes(pending)) {
      const next = [...chips, pending];
      setChips(next);
      setDraft('');
      return next;
    }
    return chips;
  };

  const togglePalette = (label: string) => {
    const key = normalizeIngredientText(label);
    if (chipKeys.has(key)) setChips(chips.filter((c) => normalizeIngredientText(c) !== key));
    else setChips([...chips, label.toLowerCase()]);
  };

  const searchCookbook = async (terms: string[]) => {
    if (!terms.length) return;
    setBusy('rank');
    setNote(null);
    try {
      const r = await api.kitchen.whatCanIMake(terms);
      setResults(r.results);
      if (!r.results.length) setNote('No cookbook matches — try “Invent recipes”, the question box, or fewer ingredients.');
    } catch {
      setNote('Search failed — try again');
    } finally {
      setBusy(null);
    }
  };

  const generate = async (which: 'invent' | 'ask') => {
    const q = which === 'ask' ? question.trim() : '';
    const terms = which === 'invent' ? collectTerms() : chips;
    if (which === 'ask' && !q) return;
    if (which === 'invent' && !terms.length) return;
    setBusy(which);
    setCandidateNote(null);
    setCandidates(null);
    try {
      const r = await api.kitchen.generateRecipes({
        ...(q ? { question: q } : {}),
        ...(terms.length ? { ingredients: terms } : {}),
      });
      if (r.ok && r.recipes.length) {
        setCandidates(r.recipes);
        setSavedIds({});
      } else if (r.reason === 'intelligence-off') {
        setCandidateNote('Enable Intelligence in Settings ▸ Intelligence to invent fresh recipes. Cookbook search still works.');
      } else {
        setCandidateNote('No fresh ideas this time — try rephrasing, or search the cookbook above.');
      }
    } catch {
      setCandidateNote('Recipe generation is unavailable right now — the cookbook search still works.'); // fail soft
    } finally {
      setBusy(null);
    }
  };

  // Save a candidate; keep the quick-view open on the SAVED recipe so the follow-on
  // actions (Add to week / Cook now) act on a real library id.
  const saveCandidate = async (cand: Recipe): Promise<Recipe | null> => {
    if (!onSaveCandidate) return null;
    if (savedIds[cand.id]) return savedRecipes[cand.id] ?? cand;
    setSavingId(cand.id);
    try {
      const saved = await onSaveCandidate(cand);
      setSavedIds((m) => ({ ...m, [cand.id]: saved.id }));
      setSavedRecipes((m) => ({ ...m, [cand.id]: saved }));
      return saved;
    } catch {
      setCandidateNote('Could not save that recipe — try again.');
      return null;
    } finally {
      setSavingId(null);
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

  const hasIngredients = chips.length > 0 || draft.trim().length > 0;

  // A consistent recipe card used by both result groups + candidates.
  const recipeCard = (r: RecipeSlim, opts: { onClick: () => void; right?: ReactNode; subtitle?: string }) => (
    <button
      key={r.id}
      type="button"
      onClick={opts.onClick}
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
        width: '100%',
      }}
    >
      <RecipePhoto recipe={r} height={kiosk ? 48 : 42} radius="var(--radius-md)" style={{ width: kiosk ? 48 : 42 }} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: kiosk ? 14.5 : 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {r.title}
        </span>
        <span style={{ display: 'block', fontSize: kiosk ? 12 : 11, color: 'var(--text-3)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {opts.subtitle ?? `${r.prepMin + r.cookMin} min`}
        </span>
      </span>
      {opts.right}
    </button>
  );

  const sectionHeading = (icon: string, color: string, label: string) => (
    <span style={{ fontSize: 10.5, letterSpacing: '.08em', textTransform: 'uppercase', color, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <Icon name={icon} size={12} color={color} /> {label}
    </span>
  );

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icon name="wand-sparkles" size={16} color="var(--battery)" />
        <h2 style={{ margin: 0, fontSize: 12, fontWeight: 700, color: 'var(--text-3)', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
          Find or invent a recipe
        </h2>
      </div>

      {/* Question box — the primary "ask for a couple of nice recipes" entry. */}
      <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && aiOn) {
              e.preventDefault();
              void generate('ask');
            }
          }}
          placeholder="Ask for a few recipe ideas — e.g. healthy pizzas with veggie dough"
          style={{ ...inputStyle, flex: 1, minWidth: 200, borderRadius: 'var(--radius-md)' }}
        />
        <Button
          size={kiosk ? 'md' : 'sm'}
          variant="primary"
          loading={busy === 'ask'}
          disabled={!aiOn || !question.trim()}
          iconLeft={<Icon name="sparkles" size={13} />}
          onClick={() => void generate('ask')}
        >
          Invent recipes
        </Button>
      </div>

      {/* On-hand input: chips + free text + the palette. */}
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
              const v = draft.trim().toLowerCase();
              if (v && !chips.includes(v)) setChips([...chips, v]);
              setDraft('');
            }
          }}
          placeholder={chips.length ? '＋ add' : 'or list what’s on hand — chicken, courgette, rice…'}
          style={{ ...inputStyle, width: chips.length ? 110 : 260 }}
        />
        <Button
          size={kiosk ? 'md' : 'sm'}
          variant="secondary"
          loading={busy === 'rank'}
          disabled={!hasIngredients}
          iconLeft={<Icon name="book-open" size={13} />}
          onClick={() => void searchCookbook(collectTerms())}
        >
          Search cookbook
        </Button>
        <Button
          size={kiosk ? 'md' : 'sm'}
          variant="ghost"
          loading={busy === 'invent'}
          disabled={!aiOn || !hasIngredients}
          iconLeft={<Icon name="sparkles" size={13} />}
          onClick={() => void generate('invent')}
        >
          Invent from these
        </Button>
      </div>

      {/* Tap-to-add ingredient palette. Inline on desktop; disclosure on mobile. */}
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
                      const selected = chipKeys.has(normalizeIngredientText(it.label));
                      return (
                        <button key={it.key} type="button" aria-pressed={selected} style={paletteChip(selected)} onClick={() => togglePalette(it.label)}>
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

      {!aiOn && (
        <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
          Enable Intelligence in Settings ▸ Intelligence to invent recipes. The cookbook search works without it.
        </span>
      )}
      {note && <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{note}</div>}
      {candidateNote && <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{candidateNote}</div>}

      {/* From your cookbook — deterministic coverage ranking. */}
      {results && results.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {sectionHeading('book-open', 'var(--battery)', 'From your cookbook')}
          {results.map((res) => {
            const r = byId.get(res.recipeId);
            if (!r) return null;
            const subtitle =
              `${r.prepMin + r.cookMin} min` +
              (res.missing.length > 0 ? ` · missing: ${res.missing.slice(0, 3).join(', ')}${res.missing.length > 3 ? '…' : ''}` : ' · everything on hand');
            return recipeCard(r, {
              onClick: () => onOpenRecipe(r),
              subtitle,
              right: (
                <Badge tone={res.have === res.total ? 'solar' : 'neutral'}>
                  {res.have} of {res.total} on hand
                </Badge>
              ),
            });
          })}
        </div>
      )}

      {/* Fresh ideas — tap to keep (AI candidates). */}
      {candidates && candidates.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {sectionHeading('sparkles', 'var(--solar)', 'Fresh ideas — tap to keep')}
          {candidates.map((cand) => {
            const savedId = savedIds[cand.id];
            const saved = savedId ? savedRecipes[cand.id] ?? cand : cand;
            return recipeCard(cand, {
              onClick: () => setOpenCandidate(saved),
              subtitle: `${cand.prepMin + cand.cookMin} min · ${cand.ingredients.length} ingredients`,
              right: savedId ? (
                <Badge tone="solar">
                  <Icon name="check" size={12} /> Saved
                </Badge>
              ) : (
                <Badge tone="neutral">Not saved yet</Badge>
              ),
            });
          })}
          <span style={{ fontSize: 10.5, color: 'var(--text-3)' }}>
            Fresh from AI — open one to see the full recipe, then keep it in your cookbook.
          </span>
        </div>
      )}

      {/* Candidate quick-view: full recipe + Save / Add to week / Cook now. */}
      {openCandidate && (
        <CandidateQuickView
          candidate={openCandidate}
          desktop={wide}
          showNutrition={showNutrition}
          savedId={savedIds[openCandidate.id]}
          saving={savingId === openCandidate.id}
          kiosk={kiosk}
          canPlan={Boolean(onSaveAndPlan)}
          canCook={Boolean(onSaveAndCook) || kiosk}
          onClose={() => setOpenCandidate(null)}
          onSave={async () => {
            const saved = await saveCandidate(openCandidate);
            if (saved) setOpenCandidate(saved);
          }}
          onAddToWeek={async () => {
            const saved = await saveCandidate(openCandidate);
            if (saved && onSaveAndPlan) {
              await onSaveAndPlan(saved);
              setOpenCandidate(null);
            }
          }}
          onCookNow={async () => {
            const saved = await saveCandidate(openCandidate);
            if (!saved) return;
            if (onSaveAndCook) await onSaveAndCook(saved);
            else onOpenRecipe(saved); // kiosk: navigate to cook
            setOpenCandidate(null);
          }}
        />
      )}
    </section>
  );
}

// The AI-candidate quick-view: the full generated recipe with keep-first actions. Reuses
// the shared RecipeQuickView; wires Save / Add to this week / Cook now onto it.
function CandidateQuickView({
  candidate,
  desktop,
  showNutrition,
  savedId,
  saving,
  kiosk,
  canPlan,
  canCook,
  onClose,
  onSave,
  onAddToWeek,
  onCookNow,
}: {
  candidate: Recipe;
  desktop: boolean;
  showNutrition: boolean;
  savedId?: string;
  saving: boolean;
  kiosk: boolean;
  canPlan: boolean;
  canCook: boolean;
  onClose: () => void;
  onSave: () => void;
  onAddToWeek: () => void;
  onCookNow: () => void;
}) {
  const isSaved = Boolean(savedId);
  return (
    <RecipeQuickView
      recipe={candidate}
      desktop={desktop}
      servings={candidate.servingsBase}
      showNutrition={showNutrition}
      onClose={onClose}
      statusBadge={
        isSaved ? (
          <Badge tone="solar">
            <Icon name="check" size={12} /> In your cookbook
          </Badge>
        ) : (
          <Badge tone="neutral">
            <Icon name="sparkles" size={12} /> AI idea · not saved yet
          </Badge>
        )
      }
      actionsLabel={isSaved ? 'In your cookbook' : 'Keep this recipe'}
      onPlan={undefined}
      extraActions={
        <>
          {!isSaved && (
            <Button variant="primary" style={{ flex: 1.2 }} loading={saving} iconLeft={<Icon name="bookmark-plus" size={15} />} onClick={onSave}>
              Save to cookbook
            </Button>
          )}
          {canPlan && (
            <Button variant="secondary" style={{ flex: 1 }} loading={saving} iconLeft={<Icon name="calendar-plus" size={15} />} onClick={onAddToWeek}>
              Add to this week
            </Button>
          )}
          {canCook && (
            <Button variant={kiosk ? 'primary' : 'secondary'} style={{ flex: 1 }} loading={saving} iconLeft={<Icon name="play" size={15} />} onClick={onCookNow}>
              Cook now
            </Button>
          )}
        </>
      }
    />
  );
}
