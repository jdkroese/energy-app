**StatTile** — the core readout that appears across every dashboard: a big mono value + unit, an uppercase label, an optional energy-tone icon chip, and a delta vs a comparison period.

```jsx
<StatTile label="Solar today" value="28.4" unit="kWh" tone="solar"
  icon={<i data-lucide="sun" />} delta={12} footnote="vs yesterday" />

<StatTile label="Grid import" value="3.1" unit="kW" tone="grid" size="xl"
  delta={-8} footnote="vs last hour" />
```

Tones: `solar | battery | grid | home | ev | neutral`. Sizes `sm | md | xl`. `delta` as a number auto-renders ±% with a colored arrow (up = green/good). Drop a `<Sparkline>` in as children for a trend.
