**SegmentedControl** — pick one of a few mutually-exclusive options; the workhorse for time ranges (Day/Week/Month/Year) and view switches.

```jsx
const [range, setRange] = React.useState('week');
<SegmentedControl
  options={['Day', 'Week', 'Month', 'Year']}
  value={range}
  onChange={setRange}
/>
```

Options can be strings or `{ value, label, icon }`. Use `size="sm"` in toolbars, `block` to fill width.
