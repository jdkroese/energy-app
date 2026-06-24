**Slider** — continuous value control for charge limits, battery reserve %, and optimization thresholds; the filled track uses the solar accent.

```jsx
const [reserve, setReserve] = React.useState(20);
<Slider label="Battery reserve" unit="%" value={reserve} onChange={setReserve} />
```

`onChange(value, event)` returns a number. Use `formatValue` for custom readouts.
