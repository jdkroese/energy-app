// Groceries — the Kitchen Hub order builder (docs/38 D4, docs/39 P1; screens per the
// approved docs/mockups/kitchen-hub-v4.html). Desktop ≥768px: smart-suggestions card
// (P1 renders only the auto-applied pack merges) + three columns (recipes · staples ·
// basket). Mobile <768px: segmented Recipes/Staples/Basket tabs + a sticky total footer.
// "Fill Mercadona cart" renders DISABLED ("coming in the next update") until P2; the M0
// "Send as checklist" flow works today. Unmapped ingredients get the cyan pick-once
// product search that writes the mapping memory.

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { ShellContext } from '../../components/shell/AppShell';
import { Badge, Button, Card, Icon, LoadingState, Modal, SegmentedControl } from '../../components/ui';
import { api } from '../../lib/api';
import { usePolling } from '../../lib/usePolling';
import type { KitchenProductHit, OrderDraft, OrderHistoryEntry, OrderLine, StaplesItem } from '../../lib/types';
import { MobileHeader } from '../_shared';
import { fmtEur, fmtQty } from './shared';

const DELIVERY_MIN_EUR = 50; // Mercadona home-delivery minimum

const checkboxStyle = (on: boolean): CSSProperties => ({
  width: 20,
  height: 20,
  minWidth: 20,
  borderRadius: 6,
  border: `1px solid ${on ? 'var(--solar)' : 'var(--border-2)'}`,
  background: on ? 'var(--solar-wash)' : 'transparent',
  color: 'var(--solar)',
  display: 'grid',
  placeItems: 'center',
  cursor: 'pointer',
  padding: 0,
});

function LineCheckbox({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button type="button" role="checkbox" aria-checked={on} style={checkboxStyle(on)} onClick={onToggle}>
      {on && <Icon name="check" size={13} />}
    </button>
  );
}

function submitByLabel(draft: OrderDraft): string | null {
  if (!draft.submitBy) return null;
  const d = new Date(draft.submitBy);
  return `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${String(d.getHours()).padStart(2, '0')}:00`;
}

export function Groceries({ ctx }: { ctx: ShellContext }) {
  const wide = ctx.desktop;
  const [tab, setTab] = useState('Recipes');
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [picker, setPicker] = useState<OrderLine | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [checklist, setChecklist] = useState<string | null>(null);

  const { data: draftResp, refetch: refetchDraft } = usePolling(api.kitchen.orderDraft, 0);
  const { data: staplesResp, refetch: refetchStaples } = usePolling(api.kitchen.staples, 0);
  const draft = draftResp?.draft ?? null;
  const staples = staplesResp?.staples ?? [];

  const linked = useMemo(() => Boolean(draft?.lines.some((l) => l.priceEur != null)), [draft]);

  const saveLines = async (lines: OrderLine[]) => {
    setBusy('lines');
    try {
      await api.kitchen.setOrderDraft({ lines });
      await refetchDraft();
    } catch {
      setNote('Save failed — try again');
    } finally {
      setBusy(null);
    }
  };

  const toggleLine = (line: OrderLine) => {
    if (!draft) return;
    void saveLines(draft.lines.map((l) => (l.id === line.id ? { ...l, checked: !l.checked } : l)));
  };

  const setQty = (line: OrderLine, qty: number) => {
    if (!draft) return;
    void saveLines(draft.lines.map((l) => (l.id === line.id ? { ...l, qty: Math.max(1, qty) } : l)));
  };

  const sendChecklist = async () => {
    setBusy('checklist');
    try {
      const r = await api.kitchen.sendChecklist();
      setChecklist(r.text);
      await refetchDraft();
    } catch (e) {
      setNote((e as Error).message || 'Checklist failed');
    } finally {
      setBusy(null);
    }
  };

  const addStaple = async (name: string) => {
    if (!name.trim()) return;
    const next: StaplesItem[] = [
      ...staples,
      { id: '', name: name.trim(), defaultQty: 1, cadence: 'weekly', lastOrderedAt: null, priceEur: null },
    ];
    try {
      await api.kitchen.setStaples(next);
      await refetchStaples();
    } catch {
      setNote('Could not add the staple');
    }
  };

  if (!draft) {
    return (
      <>
        <MobileHeader eyebrow="Kitchen" title="Groceries" />
        <LoadingState label="Loading the order draft…" />
      </>
    );
  }

  const recipeLines = draft.lines.filter((l) => l.source === 'recipe');
  const stapleLines = draft.lines.filter((l) => l.source === 'staple');
  const manualLines = draft.lines.filter((l) => l.source === 'manual' || l.source === 'tablet');
  const checkedCount = draft.lines.filter((l) => l.checked).length;
  const autoSuggestions = draft.suggestions.filter((s) => s.auto);
  const minMet = draft.totalEur >= DELIVERY_MIN_EUR;

  // ---- Line rows -----------------------------------------------------------------------

  function IngredientRow({ line, last }: { line: OrderLine; last?: boolean }) {
    if (line.needsMapping) {
      return (
        <div
          role="button"
          tabIndex={0}
          onClick={() => setPicker(line)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') setPicker(line);
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '9px 12px',
            margin: '2px 0',
            borderRadius: 'var(--radius-md)',
            background: 'var(--battery-wash)',
            cursor: 'pointer',
            minHeight: 46,
          }}
        >
          <Icon name="search" size={15} color="var(--battery)" />
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ fontSize: 12.5, color: 'var(--battery)', fontWeight: 600 }}>
              {line.label}
              {line.unit !== 'to taste' && ` · ${fmtQty(line.qty, line.unit)}`} — pick the product
            </span>
            <small style={{ display: 'block', fontSize: 10.5, color: 'var(--text-2)' }}>one-time · remembered for every future order</small>
          </span>
          <Icon name="chevron-right" size={15} color="var(--battery)" />
        </div>
      );
    }
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 2px',
          borderBottom: last ? 'none' : '1px solid var(--border-1)',
          opacity: line.checked ? 1 : 0.55,
          minHeight: 46,
        }}
      >
        <LineCheckbox on={line.checked} onToggle={() => toggleLine(line)} />
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 12.5, color: 'var(--text-1)' }}>
            {line.label}
            {line.unit !== 'to taste' && line.qty > 0 && (
              <span style={{ color: 'var(--text-2)' }}>
                {' '}
                · {fmtQty(line.qty, line.unit)}
                {(line.recipeIds?.length ?? 0) > 1 && ` across ${line.recipeIds!.length} recipes`}
              </span>
            )}
          </span>
          {line.coverageNote && <small style={{ display: 'block', fontSize: 10.5, color: 'var(--battery)' }}>→ {line.coverageNote}</small>}
          {line.pantry && <small style={{ display: 'block', fontSize: 10.5, color: 'var(--text-3)' }}>Pantry staple — pre-unchecked</small>}
        </span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-2)', flex: 'none' }}>{fmtEur(line.priceEur)}</span>
      </div>
    );
  }

  function StapleRow({ line, last }: { line: OrderLine; last?: boolean }) {
    const staple = staples.find((s) => `staple:${s.id}` === line.ingredientKey);
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          padding: '8px 2px',
          borderBottom: last ? 'none' : '1px solid var(--border-1)',
          opacity: line.checked ? 1 : 0.55,
          minHeight: 46,
        }}
      >
        <LineCheckbox on={line.checked} onToggle={() => toggleLine(line)} />
        <span style={{ flex: 1, minWidth: 0, fontSize: 12.5 }}>
          {line.label}
          {line.pantry && <small style={{ display: 'block', fontSize: 10.5, color: 'var(--text-3)' }}>Not due yet</small>}
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <button type="button" aria-label="Less" style={{ ...stepBtn }} onClick={() => setQty(line, line.qty - 1)}>
            <Icon name="minus" size={12} />
          </button>
          <b style={{ fontFamily: 'var(--font-mono)', fontSize: 12, minWidth: 14, textAlign: 'center' }}>{line.qty}</b>
          <button type="button" aria-label="More" style={{ ...stepBtn }} onClick={() => setQty(line, line.qty + 1)}>
            <Icon name="plus" size={12} />
          </button>
        </span>
        {staple && <span style={{ fontSize: 10, color: 'var(--text-3)', flex: 'none', width: 26 }}>{staple.cadence === 'weekly' ? 'wk' : staple.cadence === 'biweekly' ? '2wk' : 'mo'}</span>}
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-2)', flex: 'none' }}>{fmtEur(line.priceEur)}</span>
      </div>
    );
  }

  const stepBtn: CSSProperties = {
    width: 24,
    height: 24,
    borderRadius: 7,
    display: 'grid',
    placeItems: 'center',
    background: 'var(--surface-3)',
    border: '1px solid var(--border-2)',
    color: 'var(--text-2)',
    cursor: 'pointer',
    padding: 0,
  };

  // ---- Cards ----------------------------------------------------------------------------

  const suggestionsCard = autoSuggestions.length > 0 && (
    <Card
      title="Smart suggestions"
      icon={<Icon name="sparkles" size={15} color="var(--battery)" />}
      actions={<span style={{ fontSize: 11, color: 'var(--text-3)' }}>{autoSuggestions.length} auto-applied · interactive nudges arrive with cart fill (P2)</span>}
      accent="battery"
    >
      <div style={{ padding: '2px 16px 12px' }}>
        {autoSuggestions.map((s, i) => (
          <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '7px 0', borderBottom: i < autoSuggestions.length - 1 ? '1px solid var(--border-1)' : 'none', fontSize: 12.5, color: 'var(--text-2)' }}>
            <Icon name="package" size={14} color="var(--battery)" />
            <span style={{ flex: 1 }}>{s.text}</span>
            <Badge tone="solar">auto-applied ✓</Badge>
          </div>
        ))}
      </div>
    </Card>
  );

  const recipesCard = (
    <Card
      title="From this week’s recipes"
      actions={
        <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
          {recipeLines.filter((l) => l.checked).length} need · {recipeLines.filter((l) => !l.checked).length} pantry
        </span>
      }
      accent="grid"
    >
      <div style={{ padding: '2px 16px 12px' }}>
        {recipeLines.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--text-3)', padding: '12px 0' }}>
            No recipe lines yet — build the week on Cooking, then “Add week to Groceries”.
          </div>
        )}
        {recipeLines.map((l, i) => (
          <IngredientRow key={l.id} line={l} last={i === recipeLines.length - 1} />
        ))}
        {manualLines.length > 0 && (
          <>
            <div style={{ fontSize: 10.5, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text-3)', padding: '10px 0 2px' }}>Added by hand</div>
            {manualLines.map((l, i) => (
              <IngredientRow key={l.id} line={l} last={i === manualLines.length - 1} />
            ))}
          </>
        )}
      </div>
    </Card>
  );

  const staplesCard = (
    <Card
      title="Staples due"
      actions={<span style={{ fontSize: 11, color: 'var(--text-3)' }}>{stapleLines.filter((l) => l.checked).length} of {staples.length}</span>}
      accent="solar"
    >
      <div style={{ padding: '2px 16px 12px' }}>
        {stapleLines.map((l, i) => (
          <StapleRow key={l.id} line={l} last={i === stapleLines.length - 1 && staples.length > 0} />
        ))}
        {stapleLines.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--text-3)', padding: '10px 0' }}>
            Staples appear here when the draft is built from a week plan.
          </div>
        )}
        <AddStaple onAdd={(name) => void addStaple(name)} />
      </div>
    </Card>
  );

  const basketCard = (
    <Card title="Basket" actions={<span style={{ fontSize: 11, color: 'var(--text-3)' }}>{checkedCount} items</span>} accent="solar">
      <div style={{ padding: '4px 16px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {(
          [
            ['Recipe items', recipeLines, 'var(--grid)'],
            ['Staples', stapleLines, 'var(--solar)'],
            ['Added by hand', manualLines, 'var(--home)'],
          ] as Array<[string, OrderLine[], string]>
        ).map(([label, lines, color]) => {
          const on = lines.filter((l) => l.checked);
          if (!on.length) return null;
          const sum = on.reduce((s, l) => s + (l.priceEur ?? 0), 0);
          return (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--text-2)' }}>
              <span style={{ width: 8, height: 8, borderRadius: 999, background: color, flex: 'none' }} />
              {label} ×{on.length}
              <div style={{ flex: 1 }} />
              <span style={{ fontFamily: 'var(--font-mono)' }}>{fmtEur(sum)}</span>
            </div>
          );
        })}
        <div style={{ borderTop: '1px solid var(--border-1)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 9 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span style={{ fontSize: 12, color: 'var(--text-3)' }}>Total (incl. IVA)</span>
            <b style={{ fontFamily: 'var(--font-mono)', fontSize: 22 }}>{fmtEur(draft.totalEur)}</b>
          </div>
          <div style={{ height: 5, borderRadius: 999, background: 'var(--surface-3)', overflow: 'hidden' }}>
            <div style={{ width: `${Math.min(100, (draft.totalEur / DELIVERY_MIN_EUR) * 100)}%`, height: '100%', background: minMet ? 'var(--solar)' : 'var(--grid)' }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, color: 'var(--text-3)' }}>
            <span>{minMet ? 'Delivery minimum met ✓' : `Delivery minimum ${DELIVERY_MIN_EUR} € — ${fmtEur(DELIVERY_MIN_EUR - draft.totalEur)} to go`}</span>
            <span style={{ fontFamily: 'var(--font-mono)' }}>{linked ? 'alc1 · Jávea' : 'prices unavailable'}</span>
          </div>
          {draft.targetSlot && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: 'var(--text-2)', flexWrap: 'wrap' }}>
              <Icon name="truck" size={15} color="var(--solar)" />
              <span>
                Target slot <b style={{ color: 'var(--text-1)' }}>{draft.targetSlot.window}</b>
                {draft.submitBy && (
                  <>
                    {' '}
                    · submit by <b style={{ color: 'var(--text-1)' }}>{submitByLabel(draft)}</b>
                  </>
                )}
              </span>
              <Badge tone="solar" icon={<Icon name="bell" size={11} />}>
                reminder set
              </Badge>
            </div>
          )}
          {/* P2 seam: cart fill renders DISABLED until the token bootstrap ships. */}
          <span title="Cart link coming in the next update">
            <Button variant="primary" size="lg" block disabled iconLeft={<Icon name="shopping-basket" size={16} />}>
              Fill Mercadona cart
            </Button>
          </span>
          <Button variant="ghost" block loading={busy === 'checklist'} onClick={() => void sendChecklist()}>
            Send as checklist instead
          </Button>
          <span style={{ fontSize: 10, color: 'var(--text-3)', lineHeight: 1.5 }}>
            Cart fill arrives in the next update (one-time Mercadona link, spend cap, human checkout — this app never checks out).
            The checklist works today: your priced list, ready to shop from.
          </span>
        </div>
      </div>
    </Card>
  );

  const header = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
        Order {draft.status}
        {draft.weekStart ? ` · from week of ${new Date(`${draft.weekStart}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}` : ''}
      </span>
      <div style={{ flex: 1 }} />
      <Badge tone={linked ? 'solar' : 'neutral'}>
        <span style={{ width: 7, height: 7, borderRadius: 999, background: linked ? 'var(--solar)' : 'var(--text-3)', display: 'inline-block' }} />
        Mercadona · {linked ? 'linked' : 'prices unavailable'}
      </Badge>
      <Button size="sm" variant="ghost" iconLeft={<Icon name="clock" size={13} />} onClick={() => setHistoryOpen(true)}>
        {wide ? 'Order history' : 'History'}
      </Button>
    </div>
  );

  const overlays = (
    <>
      {picker && (
        <ProductPicker
          desktop={wide}
          line={picker}
          onClose={() => setPicker(null)}
          onPicked={() => {
            setPicker(null);
            void refetchDraft();
          }}
        />
      )}
      {historyOpen && <HistoryModal desktop={wide} onClose={() => setHistoryOpen(false)} />}
      {checklist != null && <ChecklistModal desktop={wide} text={checklist} onClose={() => setChecklist(null)} />}
    </>
  );

  const noteBanner = note && (
    <div style={{ fontSize: 12, color: 'var(--grid)', background: 'var(--grid-wash)', borderRadius: 'var(--radius-md)', padding: '8px 12px' }} onClick={() => setNote(null)}>
      {note}
    </div>
  );

  if (wide) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 1280, margin: '0 auto' }}>
        {header}
        {noteBanner}
        {suggestionsCard}
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.35fr) minmax(0, 1fr) minmax(0, 1fr)', gap: 14, alignItems: 'start' }}>
          {recipesCard}
          {staplesCard}
          {basketCard}
        </div>
        {overlays}
      </div>
    );
  }

  // ---- Mobile (<768px) ---------------------------------------------------------------
  return (
    <>
      <MobileHeader eyebrow="Kitchen" title="Groceries" right={<Badge tone={linked ? 'solar' : 'neutral'}>Mercadona</Badge>} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 14px 10px' }}>
        {noteBanner}
        <SegmentedControl
          block
          options={[`Recipes · ${recipeLines.length}`, `Staples · ${stapleLines.length}`, `Basket · ${checkedCount}`]}
          value={tab.startsWith('Recipes') ? `Recipes · ${recipeLines.length}` : tab.startsWith('Staples') ? `Staples · ${stapleLines.length}` : `Basket · ${checkedCount}`}
          onChange={(v: string) => setTab(v.split(' ·')[0])}
        />
        {tab.startsWith('Recipes') && (
          <>
            {suggestionsCard}
            {recipesCard}
          </>
        )}
        {tab.startsWith('Staples') && staplesCard}
        {tab.startsWith('Basket') && basketCard}
      </div>
      <div style={{ position: 'sticky', bottom: 0, padding: '8px 14px calc(12px + env(safe-area-inset-bottom))', background: 'linear-gradient(transparent, var(--bg-0) 40%)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8, fontSize: 11.5, color: 'var(--text-2)' }}>
          <span>
            {checkedCount} items · min {minMet ? '✓' : '✗'}
            {draft.submitBy && (
              <>
                {' '}
                · submit by <b style={{ color: 'var(--text-1)' }}>{submitByLabel(draft)}</b>
              </>
            )}
          </span>
          <b style={{ fontFamily: 'var(--font-mono)', fontSize: 18, color: 'var(--text-1)' }}>{fmtEur(draft.totalEur)}</b>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <span title="Cart link coming in the next update" style={{ flex: 1.4, display: 'flex' }}>
            <Button variant="primary" size="lg" block disabled iconLeft={<Icon name="shopping-basket" size={16} />}>
              Fill Mercadona cart
            </Button>
          </span>
          <Button variant="secondary" size="lg" loading={busy === 'checklist'} onClick={() => void sendChecklist()}>
            Checklist
          </Button>
        </div>
      </div>
      {overlays}
    </>
  );
}

// ---- Add a staple (inline) ---------------------------------------------------------------

function AddStaple({ onAdd }: { onAdd: (name: string) => void }) {
  const [draft, setDraft] = useState('');
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', paddingTop: 8 }}>
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && draft.trim()) {
            onAdd(draft);
            setDraft('');
          }
        }}
        placeholder="＋ Add a staple (milk, eggs, fruit…)"
        style={{ flex: 1, background: 'var(--surface-2)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', padding: '8px 11px', fontSize: 12, color: 'var(--text-1)', outline: 'none', minHeight: 38 }}
      />
      <Button
        size="sm"
        variant="secondary"
        disabled={!draft.trim()}
        onClick={() => {
          onAdd(draft);
          setDraft('');
        }}
      >
        Add
      </Button>
    </div>
  );
}

// ---- Pick-once product search (writes the mapping memory) ----------------------------------

function ProductPicker({
  desktop,
  line,
  onClose,
  onPicked,
}: {
  desktop: boolean;
  line: OrderLine;
  onClose: () => void;
  onPicked: () => void;
}) {
  const [q, setQ] = useState(line.label);
  const [results, setResults] = useState<KitchenProductHit[] | null>(null);
  const [available, setAvailable] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const search = useCallback(async (term: string) => {
    setBusy('search');
    try {
      const r = await api.kitchen.searchProducts(term.trim());
      setResults(r.products);
      setAvailable(r.available);
    } catch {
      setResults([]);
      setAvailable(false);
    } finally {
      setBusy(null);
    }
  }, []);

  // First search on open (the ingredient's own name).
  useEffect(() => {
    void search(line.label);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pick = async (p: KitchenProductHit) => {
    setBusy(p.id);
    try {
      await api.kitchen.pickProduct(line.ingredientKey, p.id);
      onPicked();
    } catch {
      setBusy(null);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Pick the product once"
      subtitle={`“${line.label}${line.unit !== 'to taste' ? ` · ${fmtQty(line.qty, line.unit)}` : ''}” — remembered for every future order`}
      icon="search"
      tone="battery"
      size="lg"
      placement={desktop ? 'center' : 'sheet'}
      wideViewport={desktop}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void search(q);
            }}
            placeholder="Search Mercadona…"
            style={{ flex: 1, background: 'var(--surface-2)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', padding: '9px 12px', fontSize: 13, color: 'var(--text-1)', outline: 'none' }}
          />
          <Button variant="secondary" loading={busy === 'search'} onClick={() => void search(q)}>
            Search
          </Button>
        </div>
        {!available && (
          <div style={{ fontSize: 12, color: 'var(--text-2)', background: 'var(--grid-wash)', borderRadius: 'var(--radius-md)', padding: '9px 12px' }}>
            Mercadona is unreachable right now — the list still works, prices show “—” until it’s back.
          </div>
        )}
        {results?.map((p) => (
          <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', padding: '8px 10px' }}>
            {p.photo ? (
              <img src={p.photo} alt="" style={{ width: 42, height: 42, borderRadius: 8, objectFit: 'cover', flex: 'none' }} />
            ) : (
              <span style={{ width: 42, height: 42, borderRadius: 8, background: 'var(--surface-3)', display: 'grid', placeItems: 'center', flex: 'none' }}>
                <Icon name="package" size={16} color="var(--text-3)" />
              </span>
            )}
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ fontSize: 12.5, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
              <small style={{ fontSize: 10.5, color: 'var(--text-3)' }}>
                {p.packSizeDisplay ?? ''}
                {p.referencePrice ? ` · ${p.referencePrice}` : ''}
              </small>
            </span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, flex: 'none' }}>{fmtEur(p.unitPrice)}</span>
            <Button size="sm" variant="secondary" loading={busy === p.id} onClick={() => void pick(p)}>
              Pick
            </Button>
          </div>
        ))}
        {results && results.length === 0 && available && (
          <div style={{ fontSize: 12, color: 'var(--text-3)', padding: '8px 0' }}>No matches — try a simpler Spanish name (e.g. “arroz”).</div>
        )}
      </div>
    </Modal>
  );
}

// ---- Order history --------------------------------------------------------------------------

function HistoryModal({ desktop, onClose }: { desktop: boolean; onClose: () => void }) {
  const { data } = usePolling(api.kitchen.orderHistory, 0);
  const history: OrderHistoryEntry[] = data?.history ?? [];
  return (
    <Modal open onClose={onClose} title="Order history" icon="clock" placement={desktop ? 'center' : 'sheet'} wideViewport={desktop}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {history.length === 0 && <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>No orders yet — send your first checklist and it lands here.</div>}
        {history.map((h) => (
          <div key={h.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', padding: '10px 12px', fontSize: 12.5 }}>
            <span>
              {new Date(h.date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
              <small style={{ color: 'var(--text-3)' }}> · {h.lines.length} items</small>
            </span>
            <b style={{ fontFamily: 'var(--font-mono)' }}>{fmtEur(h.totalEur)}</b>
          </div>
        ))}
      </div>
    </Modal>
  );
}

// ---- Checklist result (M0) --------------------------------------------------------------------

function ChecklistModal({ desktop, text, onClose }: { desktop: boolean; text: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => {});
  };
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  return (
    <Modal
      open
      onClose={onClose}
      title="Your shopping checklist"
      subtitle="Shop from your phone, or type it into mercadona.es"
      icon="list-checks"
      placement={desktop ? 'center' : 'sheet'}
      wideViewport={desktop}
      footer={
        <>
          {canShare && (
            <Button variant="secondary" iconLeft={<Icon name="share-2" size={14} />} onClick={() => void navigator.share({ title: 'Groceries', text }).catch(() => {})}>
              Share
            </Button>
          )}
          <Button variant="primary" iconLeft={<Icon name={copied ? 'check' : 'copy'} size={14} />} onClick={copy}>
            {copied ? 'Copied' : 'Copy list'}
          </Button>
        </>
      }
    >
      <pre style={{ fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.7, whiteSpace: 'pre-wrap', margin: 0, color: 'var(--text-2)' }}>{text}</pre>
    </Modal>
  );
}
