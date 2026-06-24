**RadialGauge** — a 270° arc gauge for bounded values: battery state-of-charge, EV charge level, self-sufficiency %. The arc fills with the energy tone and carries a soft glow.

```jsx
<RadialGauge value={78} tone="battery" label="Battery" />
<RadialGauge value={64} tone="solar" label="Self-suff." size={150} />
```

Tones: `solar | battery | grid | home | ev | accent`. Set `valueText` to show something other than the rounded number.
