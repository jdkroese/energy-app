**Button** — the primary action control; solar-green `primary` fill is reserved for the single most important action on a surface, everything else is `secondary` or `ghost`.

```jsx
<Button variant="primary" iconLeft={<i data-lucide="zap" />}>Optimize now</Button>
<Button variant="secondary">Cancel</Button>
<Button variant="ghost" size="sm">Details</Button>
<Button variant="danger">Disconnect</Button>
<Button loading>Saving</Button>
```

Variants: `primary` (glowing solar fill), `secondary` (dark panel + hairline), `ghost` (text-only), `danger`. Sizes `sm | md | lg`. Use `block` for full-width, `iconLeft`/`iconRight` for Lucide icons, `loading` for async actions. Never put two `primary` buttons next to each other.
