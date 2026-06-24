**Input** — single-line text/number field with optional label, leading icon, unit suffix, hint and error; use `mono` for numeric config values so digits stay tabular.

```jsx
<Input label="System name" placeholder="Home" icon={<i data-lucide="home" />} />
<Input label="Export limit" mono suffix="kW" defaultValue="5.0" />
<Input label="Tariff" error="Required" />
```
