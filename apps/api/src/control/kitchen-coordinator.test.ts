// Unit tests for the kitchen reminders coordinator (docs/39 acceptance #7): the tick's
// decision function takes an injected clock + data fixture, so we can assert the
// plan-week and submit nudges fire (and dedupe) without touching notify/event I/O.
// Run with the Node built-in test runner via tsx:
//   node --import tsx --test src/control/kitchen-coordinator.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateNudges } from './kitchen-coordinator';
import { defaultHousehold, defaultReminders, emptyDraft } from '../kitchen/store';
import type { KitchenData, MealPlan } from '../kitchen/types';

function fixture(overrides: Partial<KitchenData> = {}): KitchenData {
  return {
    recipes: [],
    productMap: {},
    staples: [],
    plans: {},
    orderDraft: emptyDraft(),
    orderHistory: [],
    household: defaultHousehold(),
    reminders: defaultReminders(),
    suggestionMutes: {},
    seededAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function planWithDays(weekStart: string, planned: number): MealPlan {
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(`${weekStart}T12:00:00`);
    d.setDate(d.getDate() + i);
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    days.push({ date, recipeId: i < planned ? `r${i}` : null, servings: 4 });
  }
  return { weekStart, days };
}

// 2026-07-05 is a Sunday; the surrounding week is Mon 2026-06-29 … Sun 2026-07-05,
// and "next week" is Mon 2026-07-06.
const SUNDAY_1830 = new Date(2026, 6, 5, 18, 30); // after the 18:00 plan moment
const SUNDAY_1900 = new Date(2026, 6, 5, 19, 0); // inside the submit window (22:00 − 4h)
const SATURDAY_NOON = new Date(2026, 6, 4, 12, 0);

test('plan-week nudge fires Sunday evening when next week has <3 planned days', () => {
  const data = fixture({ plans: { '2026-07-06': planWithDays('2026-07-06', 1) } });
  const nudges = evaluateNudges(data, SUNDAY_1830);
  assert.equal(nudges.filter((n) => n.kind === 'plan-week').length, 1);
});

test('plan-week nudge does NOT fire when next week is already planned (≥3 days)', () => {
  const data = fixture({ plans: { '2026-07-06': planWithDays('2026-07-06', 5) } });
  const nudges = evaluateNudges(data, SUNDAY_1830);
  assert.equal(nudges.filter((n) => n.kind === 'plan-week').length, 0);
});

test('plan-week nudge does NOT fire before the configured moment (Saturday noon)', () => {
  const data = fixture({ plans: { '2026-07-06': planWithDays('2026-07-06', 0) } });
  const nudges = evaluateNudges(data, SATURDAY_NOON);
  assert.equal(nudges.filter((n) => n.kind === 'plan-week').length, 0);
});

test('plan-week nudge dedupes — a fired week never re-fires', () => {
  const data = fixture({ plans: { '2026-07-06': planWithDays('2026-07-06', 0) } });
  data.reminders.lastPlanNudgeWeek = '2026-06-29'; // this week's key
  const nudges = evaluateNudges(data, SUNDAY_1830);
  assert.equal(nudges.filter((n) => n.kind === 'plan-week').length, 0);
});

test('submit nudge fires inside deadline − 4h when the draft is unsubmitted', () => {
  const draft = emptyDraft();
  draft.lines = [
    { id: 'l1', source: 'recipe', ingredientKey: 'arroz redondo', label: 'Arroz redondo', qty: 900, unit: 'g', checked: true, priceEur: 1.1 },
  ];
  draft.totalEur = 1.1;
  const data = fixture({ orderDraft: draft, plans: { '2026-07-06': planWithDays('2026-07-06', 7) } });
  const nudges = evaluateNudges(data, SUNDAY_1900);
  assert.equal(nudges.filter((n) => n.kind === 'submit-order').length, 1);
  assert.match(nudges.find((n) => n.kind === 'submit-order')!.body, /22:00/);
});

test('submit nudge does NOT fire once the draft is submitted', () => {
  const draft = emptyDraft();
  draft.lines = [
    { id: 'l1', source: 'recipe', ingredientKey: 'arroz redondo', label: 'Arroz redondo', qty: 900, unit: 'g', checked: true },
  ];
  draft.status = 'submitted';
  const data = fixture({ orderDraft: draft });
  const nudges = evaluateNudges(data, SUNDAY_1900);
  assert.equal(nudges.filter((n) => n.kind === 'submit-order').length, 0);
});

test('submit nudge does NOT fire outside the 4h window (Saturday noon)', () => {
  const draft = emptyDraft();
  draft.lines = [
    { id: 'l1', source: 'recipe', ingredientKey: 'arroz redondo', label: 'Arroz redondo', qty: 900, unit: 'g', checked: true },
  ];
  const data = fixture({ orderDraft: draft });
  const nudges = evaluateNudges(data, SATURDAY_NOON);
  assert.equal(nudges.filter((n) => n.kind === 'submit-order').length, 0);
});

test('submit nudge dedupes per week', () => {
  const draft = emptyDraft();
  draft.lines = [
    { id: 'l1', source: 'recipe', ingredientKey: 'arroz redondo', label: 'Arroz redondo', qty: 900, unit: 'g', checked: true },
  ];
  const data = fixture({ orderDraft: draft });
  data.reminders.lastSubmitNudgeWeek = '2026-06-29';
  const nudges = evaluateNudges(data, SUNDAY_1900);
  assert.equal(nudges.filter((n) => n.kind === 'submit-order').length, 0);
});
