// Groceries — the Kitchen Hub order builder (docs/38 D4, docs/39 P1, docs/41 P2;
// screens per the approved docs/mockups/kitchen-hub-v4.html). Desktop ≥768px:
// smart-suggestions strip (auto pack merges + interactive Confirm/Ignore nudges) +
// three columns (recipes · staples · basket). Mobile <768px: segmented tabs + a
// sticky total footer. P2 wires "Fill Mercadona cart" for real: explicit confirm
// modal → server-side spend cap → ONE batched cart write (dry-run returns the exact
// payload without sending) → "in your cart — open Mercadona to pick a slot and pay";
// checkout stays 100% human. Real delivery slots + order status ride the linked
// account; "Send as checklist" remains the always-works fallback.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { ShellContext } from '../../components/shell/AppShell';
import { Badge, Button, Card, Icon, LoadingState, Modal, SegmentedControl } from '../../components/ui';
import { api } from '../../lib/api';
import { usePolling } from '../../lib/usePolling';
import type {
  FillCartResponse,
  KitchenProductHit,
  KitchenRegularHit,
  MercadonaAccountStatus,
  MercadonaSlot,
  OrderDraft,
  OrderHistoryEntry,
  OrderLine,
  OrderSuggestion,
  StaplesItem,
} from '../../lib/types';
import { MobileHeader } from '../_shared';
import { clientIngredientKey, fmtEur, fmtQty } from './shared';

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

// 1-click remove (owner ask) — distinct from the include/exclude checkbox. Muted by
// default, danger tint on hover/focus, ≥44px touch target, stops row-click propagation.
function TrashButton({ label, onDelete, disabled }: { label: string; onDelete: () => void; disabled?: boolean }) {
  const [hot, setHot] = useState(false);
  return (
    <button
      type="button"
      aria-label={`Remove ${label}`}
      title={`Remove ${label}`}
      disabled={disabled}
      onMouseEnter={() => setHot(true)}
      onMouseLeave={() => setHot(false)}
      onFocus={() => setHot(true)}
      onBlur={() => setHot(false)}
      onClick={(e) => {
        e.stopPropagation();
        onDelete();
      }}
      style={{
        width: 44,
        height: 44,
        minWidth: 44,
        borderRadius: 8,
        border: 'none',
        background: hot ? 'var(--danger-wash)' : 'transparent',
        color: hot ? 'var(--danger)' : 'var(--text-3)',
        display: 'grid',
        placeItems: 'center',
        cursor: disabled ? 'default' : 'pointer',
        flex: 'none',
        padding: 0,
        opacity: disabled ? 0.4 : 1,
        transition: 'background .12s, color .12s',
      }}
    >
      <Icon name="trash-2" size={15} />
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
  // Single-level undo for the last 1-click delete (restores the draft line + any staple def).
  const [undo, setUndo] = useState<{ label: string; run: () => Promise<void> } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [picker, setPicker] = useState<OrderLine | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [checklist, setChecklist] = useState<string | null>(null);
  const [confirmFill, setConfirmFill] = useState(false);
  const [fillResult, setFillResult] = useState<FillCartResponse | null>(null);
  const [regularsOpen, setRegularsOpen] = useState(false);
  const [slots, setSlots] = useState<MercadonaSlot[] | null>(null);

  const { data: draftResp, refetch: refetchDraft } = usePolling(api.kitchen.orderDraft, 0);
  const { data: staplesResp, refetch: refetchStaples } = usePolling(api.kitchen.staples, 0);
  const { data: accountResp } = usePolling(api.kitchen.mercadonaAccount, 0);
  const { data: historyResp, refetch: refetchHistory } = usePolling(api.kitchen.orderHistory, 0);
  const draft = draftResp?.draft ?? null;
  const staples = staplesResp?.staples ?? [];
  const account: MercadonaAccountStatus | null = accountResp?.account ?? null;
  /** Delivery window of the latest order detected on the account (status card). */
  const deliveryWindow = historyResp?.history.find((h) => h.source === 'mercadona')?.slot ?? null;

  const linked = useMemo(() => Boolean(draft?.lines.some((l) => l.priceEur != null)), [draft]);
  const accountLinked = Boolean(account?.linked);

  // P2: real delivery slots once the account is linked (READ only — booking stays human).
  useEffect(() => {
    if (!accountLinked) return;
    api.kitchen
      .orderSlots()
      .then((r) => setSlots(r.available ? r.slots : null))
      .catch(() => setSlots(null));
  }, [accountLinked]);

  // P2: a 'filled' draft means the human still has to check out — poll the account's
  // orders ONCE per screen open so filled → submitted follows reality.
  const syncedRef = useRef(false);
  useEffect(() => {
    if (!draft || draft.status !== 'filled' || !accountLinked || syncedRef.current) return;
    syncedRef.current = true;
    api.kitchen
      .syncOrderStatus()
      .then((r) => {
        if (r.matched) {
          void refetchDraft();
          void refetchHistory();
        }
      })
      .catch(() => {});
  }, [draft, accountLinked, refetchDraft, refetchHistory]);

  const suggestionAction = async (s: OrderSuggestion, action: 'confirm' | 'ignore') => {
    setBusy(`sugg-${s.id}-${action}`);
    try {
      const r = await api.kitchen.suggestionAction(s.id, action);
      if (action === 'ignore' && r.suppressed) setNote('Got it — that suggestion won’t come back.');
      await refetchDraft();
    } catch (e) {
      setNote((e as Error).message || 'Suggestion update failed');
    } finally {
      setBusy(null);
    }
  };

  const runFillCart = async () => {
    setBusy('fill');
    try {
      const r = await api.kitchen.fillCart();
      setConfirmFill(false);
      setFillResult(r);
      await refetchDraft();
    } catch (e) {
      setConfirmFill(false);
      setNote((e as Error).message || 'Cart fill failed');
    } finally {
      setBusy(null);
    }
  };

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

  // 1-click delete (owner ask): remove a line from the list immediately. For STAPLE lines
  // also drop the underlying staple definition — otherwise it reappears on the next
  // "Add week to Groceries" rebuild. Offers a single-level Undo that restores both.
  const deleteLine = async (line: OrderLine) => {
    if (!draft) return;
    const removedStaple =
      line.source === 'staple' ? staples.find((s) => `staple:${s.id}` === line.ingredientKey) ?? null : null;
    const nextLines = draft.lines.filter((l) => l.id !== line.id);
    const nextStaples = removedStaple ? staples.filter((s) => s.id !== removedStaple.id) : null;

    setBusy('lines');
    try {
      if (nextStaples) {
        await api.kitchen.setStaples(nextStaples);
        await refetchStaples();
      }
      await api.kitchen.setOrderDraft({ lines: nextLines });
      await refetchDraft();
      setUndo({
        label: line.label,
        run: async () => {
          // Restore the staple definition first (so the rebuilt line can resolve it), then
          // the draft lines exactly as they were before the delete.
          if (removedStaple) {
            await api.kitchen.setStaples([...staples]);
            await refetchStaples();
          }
          await api.kitchen.setOrderDraft({ lines: draft.lines });
          await refetchDraft();
        },
      });
      setNote(`Removed ${line.label}`);
    } catch {
      setNote('Could not remove that item — try again');
    } finally {
      setBusy(null);
    }
  };

  const runUndo = async () => {
    if (!undo) return;
    const u = undo;
    setUndo(null);
    setNote(null);
    setBusy('lines');
    try {
      await u.run();
    } catch {
      setNote('Undo failed — refresh and try again');
    } finally {
      setBusy(null);
    }
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
  const regularLines = draft.lines.filter((l) => l.source === 'regular');
  const checkedCount = draft.lines.filter((l) => l.checked).length;
  const autoSuggestions = draft.suggestions.filter((s) => s.auto);
  const openSuggestions = draft.suggestions.filter((s) => !s.auto && s.state === 'open');
  const minMet = draft.totalEur >= DELIVERY_MIN_EUR;
  const fillableCount = draft.lines.filter((l) => l.checked && l.productId).length;
  const unmappedChecked = draft.lines.filter((l) => l.checked && !l.productId).length;
  const filled = draft.status === 'filled';
  const submitted = draft.status === 'submitted';

  // The next bookable delivery slot (real cutoff surface — docs/41 §4).
  const nextSlot = slots?.find((s) => s.available) ?? null;
  const slotLabel = (s: MercadonaSlot): string => {
    const day = s.day ? new Date(`${s.day}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' }) : '';
    const window = s.start && s.end ? `${s.start.includes('T') ? s.start.slice(11, 16) : s.start}–${s.end.includes('T') ? s.end.slice(11, 16) : s.end}` : '';
    return [day, window].filter(Boolean).join(' ') || 'slot available';
  };

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
          <TrashButton label={line.label} disabled={busy === 'lines'} onDelete={() => void deleteLine(line)} />
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
          {line.incomparable && (
            <small style={{ display: 'block', fontSize: 10.5, color: 'var(--solar)' }}>
              <Icon name="triangle-alert" size={10} /> check quantity — recipes used mixed units for this one
            </small>
          )}
          {line.pantry && <small style={{ display: 'block', fontSize: 10.5, color: 'var(--text-3)' }}>Pantry staple — pre-unchecked</small>}
        </span>
        <LinePrice line={line} />
        <TrashButton label={line.label} disabled={busy === 'lines'} onDelete={() => void deleteLine(line)} />
      </div>
    );
  }

  // Price cell for a line — shows a muted "est." marker when the price is a preserved
  // last-known estimate (live re-check unavailable) rather than live-confirmed.
  function LinePrice({ line }: { line: OrderLine }) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 3, flex: 'none' }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-2)' }}>{fmtEur(line.priceEur)}</span>
        {line.priceEst && line.priceEur != null && (
          <span style={{ fontSize: 10, color: 'var(--text-3)' }} title="Priced from last-known — Mercadona was flaky">est.</span>
        )}
      </span>
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
        <LinePrice line={line} />
        <TrashButton label={line.label} disabled={busy === 'lines'} onDelete={() => void deleteLine(line)} />
      </div>
    );
  }

  // Editable regulars row — mirrors StapleRow (checkbox · qty −/+ stepper · price ·
  // trash) WITHOUT the staple cadence tag. Keeps regulars adjustable in place.
  function RegularRow({ line, last }: { line: OrderLine; last?: boolean }) {
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
        <span style={{ flex: 1, minWidth: 0, fontSize: 12.5 }}>{line.label}</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <button type="button" aria-label="Less" style={{ ...stepBtn }} onClick={() => setQty(line, line.qty - 1)}>
            <Icon name="minus" size={12} />
          </button>
          <b style={{ fontFamily: 'var(--font-mono)', fontSize: 12, minWidth: 14, textAlign: 'center' }}>{line.qty}</b>
          <button type="button" aria-label="More" style={{ ...stepBtn }} onClick={() => setQty(line, line.qty + 1)}>
            <Icon name="plus" size={12} />
          </button>
        </span>
        <LinePrice line={line} />
        <TrashButton label={line.label} disabled={busy === 'lines'} onDelete={() => void deleteLine(line)} />
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

  // P2 (docs/41 §3): the interactive strip — Confirm applies the change to the draft,
  // Ignore counts against the (kind, subject); twice → permanently suppressed.
  const SUGG_ICON: Record<OrderSuggestion['kind'], string> = { pack: 'package', merge: 'carrot', cadence: 'clock' };
  const SUGG_ACTION: Record<OrderSuggestion['kind'], string> = { pack: 'Switch', merge: 'Merge', cadence: 'Add' };

  const suggestionsCard = (autoSuggestions.length > 0 || openSuggestions.length > 0) && (
    <Card
      title="Smart suggestions"
      icon={<Icon name="sparkles" size={15} color="var(--battery)" />}
      actions={
        <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
          {openSuggestions.length} open · {autoSuggestions.length} auto-applied
        </span>
      }
      accent="battery"
    >
      <div style={{ padding: '2px 16px 12px' }}>
        {openSuggestions.map((s, i) => (
          <div
            key={s.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 9,
              padding: '8px 0',
              borderBottom: i < openSuggestions.length - 1 || autoSuggestions.length > 0 ? '1px solid var(--border-1)' : 'none',
              fontSize: 12.5,
              color: 'var(--text-2)',
              flexWrap: wide ? 'nowrap' : 'wrap',
            }}
          >
            <Icon name={SUGG_ICON[s.kind]} size={14} color="var(--battery)" />
            <span style={{ flex: 1, minWidth: wide ? 0 : '70%' }}>{s.text}</span>
            <span style={{ display: 'flex', gap: 6, flex: 'none', marginLeft: 'auto' }}>
              <Button size="sm" variant="secondary" loading={busy === `sugg-${s.id}-confirm`} onClick={() => void suggestionAction(s, 'confirm')}>
                {SUGG_ACTION[s.kind]}
              </Button>
              <Button size="sm" variant="ghost" loading={busy === `sugg-${s.id}-ignore`} onClick={() => void suggestionAction(s, 'ignore')}>
                Ignore
              </Button>
            </span>
          </div>
        ))}
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
        {regularLines.length > 0 && (
          <>
            <div style={{ fontSize: 10.5, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text-3)', padding: '10px 0 2px' }}>From your regulars</div>
            {regularLines.map((l, i) => (
              <RegularRow key={l.id} line={l} last={i === regularLines.length - 1} />
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
            ['From your regulars', regularLines, 'var(--battery)'],
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
            <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
              Total (incl. IVA)
              {draft.lines.some((l) => l.checked && l.priceEst && l.priceEur != null) && (
                <span style={{ color: 'var(--text-3)' }}> · incl. estimates</span>
              )}
            </span>
            <b style={{ fontFamily: 'var(--font-mono)', fontSize: 22 }}>{fmtEur(draft.totalEur)}</b>
          </div>
          <div style={{ height: 5, borderRadius: 999, background: 'var(--surface-3)', overflow: 'hidden' }}>
            <div style={{ width: `${Math.min(100, (draft.totalEur / DELIVERY_MIN_EUR) * 100)}%`, height: '100%', background: minMet ? 'var(--solar)' : 'var(--grid)' }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, color: 'var(--text-3)' }}>
            <span>{minMet ? 'Delivery minimum met ✓' : `Delivery minimum ${DELIVERY_MIN_EUR} € — ${fmtEur(DELIVERY_MIN_EUR - draft.totalEur)} to go`}</span>
            <span style={{ fontFamily: 'var(--font-mono)' }}>{linked ? 'alc1 · Jávea' : 'prices unavailable'}</span>
          </div>
          {/* Order status strip (P2): draft → in cart → order placed. */}
          {(filled || submitted) && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 11.5,
                borderRadius: 'var(--radius-md)',
                padding: '9px 12px',
                background: submitted ? 'var(--solar-wash)' : 'var(--battery-wash)',
                color: submitted ? 'var(--solar)' : 'var(--battery)',
                flexWrap: 'wrap',
              }}
            >
              <Icon name={submitted ? 'circle-check-big' : 'shopping-basket'} size={15} />
              <span style={{ flex: 1, minWidth: 0 }}>
                {submitted ? (
                  <>
                    Order placed ✓
                    {deliveryWindow?.start && (
                      <> · delivery <b>{deliveryWindow.start.includes('T') ? deliveryWindow.start.slice(0, 16).replace('T', ' ') : deliveryWindow.start}</b></>
                    )}
                  </>
                ) : (
                  <>In your Mercadona cart — open Mercadona to pick a slot and pay. This app never checks out.</>
                )}
              </span>
              {filled && (
                <a href="https://tienda.mercadona.es" target="_blank" rel="noreferrer" style={{ color: 'inherit', fontWeight: 600, whiteSpace: 'nowrap' }}>
                  Open Mercadona <Icon name="external-link" size={11} />
                </a>
              )}
            </div>
          )}
          {draft.targetSlot && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: 'var(--text-2)', flexWrap: 'wrap' }}>
              <Icon name="truck" size={15} color="var(--solar)" />
              <span>
                {nextSlot ? (
                  <>
                    Next slot <b style={{ color: 'var(--text-1)' }}>{slotLabel(nextSlot)}</b>
                    {slots && <> · {slots.filter((s) => s.available).length} open</>}
                  </>
                ) : (
                  <>
                    Target slot <b style={{ color: 'var(--text-1)' }}>{draft.targetSlot.window}</b>
                  </>
                )}
                {draft.submitBy && (
                  <>
                    {' '}
                    · submit by <b style={{ color: 'var(--text-1)' }}>{submitByLabel(draft)}</b>
                  </>
                )}
              </span>
              <Badge tone="solar" icon={<Icon name="bell" size={11} />}>
                {nextSlot ? 'live slots' : 'reminder set'}
              </Badge>
            </div>
          )}
          <Button
            variant="primary"
            size="lg"
            block
            disabled={fillableCount === 0}
            loading={busy === 'fill'}
            iconLeft={<Icon name="shopping-basket" size={16} />}
            onClick={() => setConfirmFill(true)}
          >
            {filled ? 'Refill Mercadona cart' : 'Fill Mercadona cart'}
          </Button>
          <Button variant="ghost" block loading={busy === 'checklist'} onClick={() => void sendChecklist()}>
            Send as checklist instead
          </Button>
          <span style={{ fontSize: 10, color: 'var(--text-3)', lineHeight: 1.5 }}>
            {accountLinked ? (
              <>
                Fills your real cart ({fillableCount} items). You pick the slot &amp; pay in Mercadona — this app never
                checks out. Spend cap {account?.spendCapEur ?? 150} €{account?.dryRun ? ' · dry-run mode is ON (nothing is sent)' : ''}.
              </>
            ) : (
              <>
                No Mercadona account linked yet — the button previews the exact cart payload (dry run, nothing is sent).
                Link your account in Settings ▸ Connections ▸ Mercadona to fill the real cart. Human checkout, always.
              </>
            )}
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
      {accountLinked && (
        <Button size="sm" variant="ghost" iconLeft={<Icon name="sparkles" size={13} />} onClick={() => setRegularsOpen(true)}>
          {wide ? 'Add from your regulars' : 'Regulars'}
        </Button>
      )}
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
      {confirmFill && (
        <ConfirmFillModal
          desktop={wide}
          draft={draft}
          account={account}
          fillableCount={fillableCount}
          unmappedChecked={unmappedChecked}
          busy={busy === 'fill'}
          onConfirm={() => void runFillCart()}
          onClose={() => setConfirmFill(false)}
        />
      )}
      {fillResult && <FillResultModal desktop={wide} result={fillResult} onClose={() => setFillResult(null)} />}
      {regularsOpen && (
        <RegularsModal
          desktop={wide}
          draft={draft}
          onClose={() => setRegularsOpen(false)}
          onAdded={(n) => {
            setRegularsOpen(false);
            void refetchDraft();
            setNote(`Added ${n} item${n === 1 ? '' : 's'} from your regulars ✓`);
          }}
        />
      )}
    </>
  );

  const noteBanner = note && (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        fontSize: 12,
        color: 'var(--grid)',
        background: 'var(--grid-wash)',
        borderRadius: 'var(--radius-md)',
        padding: '8px 12px',
      }}
    >
      <span style={{ flex: 1, cursor: 'pointer' }} onClick={() => { setNote(null); setUndo(null); }}>
        {note}
      </span>
      {undo && (
        <button
          type="button"
          onClick={() => void runUndo()}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--grid)',
            fontWeight: 700,
            cursor: 'pointer',
            fontSize: 12,
            padding: '2px 4px',
            minHeight: 32,
            whiteSpace: 'nowrap',
          }}
        >
          Undo
        </button>
      )}
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
        {accountLinked && (
          <Button size="sm" variant="ghost" block iconLeft={<Icon name="sparkles" size={13} />} onClick={() => setRegularsOpen(true)}>
            Add from your regulars
          </Button>
        )}
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
          <span style={{ flex: 1.4, display: 'flex' }}>
            <Button
              variant="primary"
              size="lg"
              block
              disabled={fillableCount === 0}
              loading={busy === 'fill'}
              iconLeft={<Icon name="shopping-basket" size={16} />}
              onClick={() => setConfirmFill(true)}
            >
              {filled ? 'Refill cart' : 'Fill Mercadona cart'}
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '16px 18px' }}>
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '16px 18px' }}>
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
      <pre style={{ fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.7, whiteSpace: 'pre-wrap', margin: 0, padding: '16px 18px', color: 'var(--text-2)' }}>{text}</pre>
    </Modal>
  );
}

// ---- P2: explicit cart-fill confirm (docs/41 §2 — "32 items · 87,40 € → your cart") ----------

function ConfirmFillModal({
  desktop,
  draft,
  account,
  fillableCount,
  unmappedChecked,
  busy,
  onConfirm,
  onClose,
}: {
  desktop: boolean;
  draft: OrderDraft;
  account: MercadonaAccountStatus | null;
  fillableCount: number;
  unmappedChecked: number;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const dryRun = !account?.linked || Boolean(account?.dryRun);
  const cap = account?.spendCapEur ?? 150;
  const overCap = draft.totalEur > cap;
  // Mirror of the server rule: a REAL fill refuses when any item has no live price
  // (the spend cap can't judge what it can't see); dry-run stays available.
  const unpricedFillable = draft.lines.filter((l) => l.checked && l.productId && l.priceEur == null).length;
  const blockedUnpriced = !dryRun && unpricedFillable > 0;
  // Non-blocking: lines whose price is a preserved last-known estimate (Mercadona was
  // flaky). These keep a price, so the cap still judges a real total — the fill is
  // allowed; we just say the cap was judged on the estimate.
  const estimatedFillable = draft.lines.filter((l) => l.checked && l.productId && l.priceEst && l.priceEur != null).length;
  return (
    <Modal
      open
      onClose={onClose}
      title={dryRun ? 'Preview the cart payload (dry run)' : 'Fill your Mercadona cart?'}
      subtitle={`${fillableCount} items · ${fmtEur(draft.totalEur)} → ${dryRun ? 'nothing is sent' : 'your Mercadona cart'}`}
      icon="shopping-basket"
      tone="solar"
      placement={desktop ? 'center' : 'sheet'}
      wideViewport={desktop}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={(overCap || blockedUnpriced) && !dryRun}
            onClick={onConfirm}
            iconLeft={<Icon name={dryRun ? 'flask-conical' : 'shopping-basket'} size={14} />}
          >
            {dryRun ? 'Build the payload' : `Fill cart · ${fmtEur(draft.totalEur)}`}
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '16px 18px', fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.55 }}>
        <div>
          {dryRun ? (
            <>
              Dry-run mode: the app builds and validates the <b>exact batched payload</b> it would send to Mercadona and
              shows it to you — <b>nothing leaves the house</b>.
              {!account?.linked && ' Link your account in Settings ▸ Connections ▸ Mercadona to fill the real cart.'}
            </>
          ) : (
            <>
              One batched write adds these items to the cart of <b>{account?.label ?? 'your linked account'}</b>. You still
              pick the delivery slot and pay in Mercadona yourself — <b>this app never checks out</b>. Unlinking the
              account in Settings kills this instantly.
            </>
          )}
        </div>
        {unmappedChecked > 0 && (
          <div style={{ background: 'var(--grid-wash)', borderRadius: 'var(--radius-md)', padding: '8px 11px', color: 'var(--grid)', fontSize: 12 }}>
            {unmappedChecked} checked line{unmappedChecked > 1 ? 's have' : ' has'} no product picked yet — they will be
            skipped. Use the cyan “pick the product” rows first to include them.
          </div>
        )}
        {overCap && (
          <div style={{ background: 'var(--grid-wash)', borderRadius: 'var(--radius-md)', padding: '8px 11px', color: 'var(--grid)', fontSize: 12 }}>
            {fmtEur(draft.totalEur)} is over the {cap} € spend cap — the server will refuse. Raise the cap in Settings ▸
            Connections ▸ Mercadona or uncheck some lines.
          </div>
        )}
        {blockedUnpriced && (
          <div style={{ background: 'var(--grid-wash)', borderRadius: 'var(--radius-md)', padding: '8px 11px', color: 'var(--grid)', fontSize: 12 }}>
            {unpricedFillable} item{unpricedFillable > 1 ? 's have' : ' has'} no live price (Mercadona unreachable), so the
            spend cap can’t judge this fill — the server refuses real fills until prices are back. Try again later, or send
            as checklist.
          </div>
        )}
        {estimatedFillable > 0 && (
          <div style={{ background: 'var(--surface-3)', borderRadius: 'var(--radius-md)', padding: '8px 11px', color: 'var(--text-2)', fontSize: 12, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <Icon name="info" size={14} color="var(--text-3)" />
            <span>
              {estimatedFillable} item{estimatedFillable > 1 ? 's are' : ' is'} priced from last-known (Mercadona flaky) — the
              spend cap is judged on the estimate.
            </span>
          </div>
        )}
        <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
          Spend cap {cap} € (server-enforced) · batched write · no checkout, payment or slot booking — ever.
        </div>
      </div>
    </Modal>
  );
}

// ---- P2: fill result — dry-run payload preview or the real-fill hand-off ----------------------

function FillResultModal({ desktop, result, onClose }: { desktop: boolean; result: FillCartResponse; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const payloadJson = result.payload ? JSON.stringify(result.payload, null, 2) : null;
  return (
    <Modal
      open
      onClose={onClose}
      title={result.dryRun ? 'Dry run — this is the exact payload' : 'In your Mercadona cart ✓'}
      subtitle={
        result.dryRun
          ? `${result.items.length} products · ${fmtEur(result.totalEur)} · nothing was sent`
          : `${result.items.length} products · ${fmtEur(result.totalEur)} — open Mercadona to pick a slot and pay`
      }
      icon={result.dryRun ? 'flask-conical' : 'circle-check-big'}
      tone="solar"
      placement={desktop ? 'center' : 'sheet'}
      wideViewport={desktop}
      footer={
        <>
          {result.dryRun && payloadJson && (
            <Button
              variant="secondary"
              iconLeft={<Icon name={copied ? 'check' : 'copy'} size={14} />}
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(payloadJson)
                  .then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1600);
                  })
                  .catch(() => {});
              }}
            >
              {copied ? 'Copied' : 'Copy payload'}
            </Button>
          )}
          {!result.dryRun && (
            <Button
              variant="primary"
              iconLeft={<Icon name="external-link" size={14} />}
              onClick={() => window.open(result.cartUrl ?? 'https://tienda.mercadona.es', '_blank', 'noreferrer')}
            >
              Open Mercadona
            </Button>
          )}
          <Button variant={result.dryRun ? 'primary' : 'ghost'} onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '16px 18px' }}>
        {result.skipped.length > 0 && (
          <div style={{ fontSize: 12, color: 'var(--grid)', background: 'var(--grid-wash)', borderRadius: 'var(--radius-md)', padding: '8px 11px' }}>
            Skipped (no product picked): {result.skipped.map((s) => s.label).join(', ')}
          </div>
        )}
        {result.unpricedCount > 0 && (
          <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
            {result.unpricedCount} item{result.unpricedCount > 1 ? 's' : ''} had no live price (Mercadona unreachable) — the
            spend cap judged the known total only.
          </div>
        )}
        {result.estimatedCount > 0 && (
          <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
            {result.estimatedCount} item{result.estimatedCount > 1 ? 's were' : ' was'} priced from last-known estimates.
          </div>
        )}
        <div style={{ border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', padding: '4px 12px 8px' }}>
          {result.items.map((it, i) => (
            <div key={it.product_id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '6px 0', borderBottom: i < result.items.length - 1 ? '1px solid var(--border-1)' : 'none', fontSize: 12.5 }}>
              <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-3)', flex: 'none', width: 26, textAlign: 'right' }}>{it.quantity}×</span>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.label}</span>
              <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 3, flex: 'none' }}>
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-2)' }}>{fmtEur(it.priceEur)}</span>
                {it.estimated && it.priceEur != null && <span style={{ fontSize: 10, color: 'var(--text-3)' }}>est.</span>}
              </span>
            </div>
          ))}
        </div>
        {result.dryRun && payloadJson && (
          <pre style={{ fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1.6, whiteSpace: 'pre-wrap', margin: 0, color: 'var(--text-2)', background: 'var(--surface-2)', borderRadius: 'var(--radius-md)', padding: '10px 12px', maxHeight: 220, overflow: 'auto' }}>
            {payloadJson}
          </pre>
        )}
      </div>
    </Modal>
  );
}

// ---- Regulars browser (docs/43 — browse-and-add-to-order, decoupled from staples) --------------
// Mercadona "my regulars" is the whole 131-item repeat-purchase history. It is NOT the
// weekly-staples list (that mistake dumped all 131 into staples). Here it's a search-and-add
// surface: tap items → append them as order-draft lines (source:'regular'). Nothing is
// pre-selected; items already in the draft show greyed and aren't re-addable.

function RegularsModal({
  desktop,
  draft,
  onClose,
  onAdded,
}: {
  desktop: boolean;
  draft: OrderDraft;
  onClose: () => void;
  onAdded: (count: number) => void;
}) {
  const [products, setProducts] = useState<KitchenRegularHit[] | null>(null);
  const [available, setAvailable] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.kitchen
      .regulars()
      .then((r) => {
        setAvailable(r.available);
        setProducts(r.products);
        // NO pre-selection — the whole 131-item history must not default to "selected".
      })
      .catch(() => {
        setAvailable(false);
        setProducts([]);
      });
  }, []);

  const toggle = (id: string) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const filtered = useMemo(() => {
    if (!products) return [];
    const q = query.trim().toLowerCase();
    if (!q) return products;
    return products.filter((p) => p.name.toLowerCase().includes(q));
  }, [products, query]);

  const addSelected = async () => {
    if (!products) return;
    const chosen = products.filter((p) => selected.has(p.id) && !p.inDraft);
    if (!chosen.length) return;
    setBusy(true);
    try {
      // Mirror the tablet quickAdd line shape: a mapped, checked, priced order line.
      const newLines: OrderLine[] = chosen.map((p) => {
        const qty = p.recommendedQty || 1;
        return {
          id: '', // server assigns
          source: 'regular',
          productId: p.id,
          ingredientKey: clientIngredientKey(p.name),
          label: p.name,
          qty,
          unit: 'count',
          checked: true,
          ...(p.unitPrice != null ? { priceEur: Math.round(p.unitPrice * qty * 100) / 100 } : {}),
        };
      });
      await api.kitchen.setOrderDraft({ lines: [...draft.lines, ...newLines] });
      onAdded(chosen.length);
    } catch {
      setBusy(false);
    }
  };

  const addable = products?.filter((p) => selected.has(p.id) && !p.inDraft).length ?? 0;

  // Select-all master toggle — acts on the currently-visible, still-addable rows
  // (respects the search filter; items already in the order are excluded).
  const selectable = filtered.filter((p) => !p.inDraft);
  const allSelected = selectable.length > 0 && selectable.every((p) => selected.has(p.id));
  const toggleAll = () =>
    setSelected((cur) => {
      const next = new Set(cur);
      const everyOn = selectable.every((p) => next.has(p.id));
      for (const p of selectable) {
        if (everyOn) next.delete(p.id);
        else next.add(p.id);
      }
      return next;
    });

  return (
    <Modal
      open
      onClose={onClose}
      title="Your Mercadona regulars"
      subtitle="Tap to add to this week’s order."
      icon="sparkles"
      tone="battery"
      size="lg"
      placement={desktop ? 'center' : 'sheet'}
      wideViewport={desktop}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={addable === 0} onClick={() => void addSelected()}>
            Add {addable} to order
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '16px 18px' }}>
        {products !== null && available && products.length > 0 && (
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your regulars…"
            style={{
              width: '100%',
              boxSizing: 'border-box',
              background: 'var(--surface-1)',
              border: '1px solid var(--border-1)',
              borderRadius: 'var(--radius-md)',
              padding: '9px 11px',
              fontSize: 12.5,
              color: 'var(--text-1)',
            }}
          />
        )}
        {products !== null && available && selectable.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 10px 2px' }}>
            <LineCheckbox on={allSelected} onToggle={toggleAll} />
            <span onClick={toggleAll} style={{ fontSize: 12.5, color: 'var(--text-2)', cursor: 'pointer', userSelect: 'none' }}>
              {allSelected ? 'Clear all' : `Select all${query.trim() ? ' matching' : ''}`}
              <span style={{ color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}> · {selectable.length}</span>
            </span>
          </div>
        )}
        {products === null && <LoadingState label="Reading your regulars…" />}
        {products !== null && !available && (
          <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
            Mercadona didn’t answer (or exposes no regulars yet) — try again later.
          </div>
        )}
        {products !== null && available && products.length === 0 && (
          <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>No regulars on this account yet.</div>
        )}
        {products !== null && available && products.length > 0 && filtered.length === 0 && (
          <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>No regulars match “{query.trim()}”.</div>
        )}
        {filtered.map((p) => (
          <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', padding: '8px 10px', opacity: p.inDraft ? 0.5 : 1 }}>
            <LineCheckbox on={p.inDraft || selected.has(p.id)} onToggle={() => !p.inDraft && toggle(p.id)} />
            {p.photo ? (
              <img src={p.photo} alt="" style={{ width: 38, height: 38, borderRadius: 8, objectFit: 'cover', flex: 'none' }} />
            ) : (
              <span style={{ width: 38, height: 38, borderRadius: 8, background: 'var(--surface-3)', display: 'grid', placeItems: 'center', flex: 'none' }}>
                <Icon name="package" size={15} color="var(--text-3)" />
              </span>
            )}
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ fontSize: 12.5, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {p.name}
                {p.recommendedQty > 1 && (
                  <span style={{ color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}> · ×{p.recommendedQty}</span>
                )}
              </span>
              <small style={{ fontSize: 10.5, color: 'var(--text-3)' }}>
                {p.packSizeDisplay ?? ''}
                {p.inDraft ? ' · in your order' : ''}
              </small>
            </span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, flex: 'none' }}>{fmtEur(p.unitPrice)}</span>
          </div>
        ))}
      </div>
    </Modal>
  );
}
