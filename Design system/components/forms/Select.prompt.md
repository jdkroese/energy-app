**Select** — native dropdown styled to the system, for config choices (charge mode, tariff plan, device type).

```jsx
<Select
  label="Charge mode"
  options={['Self-use', 'Time-of-use', 'Backup', 'Manual']}
  value={mode}
  onChange={(e) => setMode(e.target.value)}
/>
```

Options can be strings or `{ value, label }`.
