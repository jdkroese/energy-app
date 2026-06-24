**Sparkline** — a compact axis-less trend line + gradient area, for embedding inside StatTiles, list rows, and tooltips.

```jsx
<Sparkline data={[3,5,4,8,7,11,9,14]} tone="solar" width={140} height={40} />
<StatTile label="Solar today" value="28.4" unit="kWh" tone="solar">
  <Sparkline data={hourly} tone="solar" width={180} height={36} showDot />
</StatTile>
```

Tones match the energy palette. Turn off `area` for a bare line.
