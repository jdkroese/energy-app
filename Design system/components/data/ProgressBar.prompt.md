**ProgressBar** — a linear level indicator for charge progress, capacity, and goal completion; pass `segments` for a stacked energy-mix bar.

```jsx
<ProgressBar label="EV charge" value={62} tone="ev" showValue glow />

<ProgressBar height={10} segments={[
  { value: 54, tone: 'solar', label: 'Solar' },
  { value: 28, tone: 'battery', label: 'Battery' },
  { value: 18, tone: 'grid', label: 'Grid' },
]} />
```

Tones match the energy palette. `glow` adds an emitting shadow for live/active bars.
