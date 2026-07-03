// TabletKitchen — the kiosk chef-hat tab (P3, docs/42 §1 + docs/38 §12): tonight's
// recipe detail with the cooking-mode entry, the week strip, and "what can I make
// with…". The Tonight card itself ALSO lives on the kiosk home (owner decision) —
// this tab adds the detail: rescaled ingredients + tools for tonight. Kiosk
// authority: cooking, quick-add and timers only — no cart/account/settings here.

import { useNavigate } from 'react-router-dom';
import { Icon } from '../../components/ui';
import { usePolling } from '../../lib/usePolling';
import { api } from '../../lib/api';
import { fmtQty } from '../kitchen/shared';
import { WhatCanIMake } from '../kitchen/WhatCanIMake';
import { OrderStatusCard, TonightCard, WeekStrip, useTonight } from './kitchenWidgets';

export function TabletKitchen() {
  const navigate = useNavigate();
  const t = useTonight();
  const { data: intelResp } = usePolling(api.kitchen.intelligence, 0);
  const aiOn = Boolean(
    intelResp?.intelligence.enabled && intelResp.intelligence.configured && intelResp.intelligence.features.cookingSuggestions,
  );

  const scale = t.recipe && t.day ? t.day.servings / t.recipe.servingsBase : 1;

  return (
    <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'flex', gap: 18, alignItems: 'stretch', flexWrap: 'wrap' }}>
        <div style={{ flex: '1.3 1 360px', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <TonightCard t={t} />
        </div>
        <div style={{ flex: '1 1 300px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <WeekStrip t={t} />
          {t.recipe && (
            <div style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '11px 14px', borderBottom: '1px solid var(--border-1)' }}>
                <Icon name="carrot" size={15} color="var(--grid)" />
                <span style={{ fontSize: 12.5, fontWeight: 600, flex: 1 }}>
                  Tonight’s ingredients{t.day ? ` · ${t.day.servings} servings` : ''}
                </span>
                <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{t.recipe.ingredients.length} items</span>
              </div>
              <div style={{ padding: '4px 14px 8px', maxHeight: 240, overflowY: 'auto' }}>
                {t.recipe.ingredients.map((ing, i) => (
                  <div
                    key={i}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: 10,
                      padding: '7px 0',
                      borderBottom: i < t.recipe!.ingredients.length - 1 ? '1px solid var(--border-1)' : 'none',
                      fontSize: 13,
                    }}
                  >
                    <span style={{ color: ing.pantryStaple ? 'var(--text-3)' : 'var(--text-1)' }}>{ing.name}</span>
                    <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-2)', flex: 'none' }}>
                      {ing.qty != null ? fmtQty(ing.qty * scale, ing.unit) : 'to taste'}
                    </span>
                  </div>
                ))}
              </div>
              {t.recipe.tools.length > 0 && (
                <div style={{ padding: '9px 14px 12px', fontSize: 11.5, color: 'var(--text-3)', borderTop: '1px solid var(--border-1)' }}>
                  <b style={{ color: 'var(--text-2)', fontWeight: 600 }}>Tools · </b>
                  {t.recipe.tools.join(' · ')}
                </div>
              )}
            </div>
          )}
          <OrderStatusCard />
        </div>
      </div>

      {/* Off-plan cooking: on-hand ingredients → coverage-ranked library (+ AI ideas). */}
      <WhatCanIMake recipes={t.recipes} aiOn={aiOn} wide kiosk onOpenRecipe={(r) => navigate(`/cook/${r.id}`)} />
    </div>
  );
}
