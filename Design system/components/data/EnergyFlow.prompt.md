**EnergyFlow** — the signature live diagram and the hero of every overview screen. A central hub links Solar, Battery, Grid and Home; power animates along each line in its real-world direction.

```jsx
<EnergyFlow
  solar={{ kw: 4.2 }}
  battery={{ kw: 1.1, dir: 'charging', soc: 78 }}
  grid={{ kw: 0.8, dir: 'exporting' }}
  home={{ kw: 2.3 }}
/>
```

Direction rules: solar always flows into the hub when producing; home always draws from the hub; `battery.dir` is `charging` (hub→battery) / `discharging` (battery→hub); `grid.dir` is `importing` (grid→hub) / `exporting` (hub→grid). A node lights up only when its flow is live. **Requires Lucide** (`<script src=".../lucide">`) on the page — icons use `data-lucide`.
