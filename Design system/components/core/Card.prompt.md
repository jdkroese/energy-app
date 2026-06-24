**Card** — the canonical dark panel that holds nearly all content; a flat surface with a hairline border and deep soft shadow. Glow and the top accent rail are opt-in for live/energy data.

```jsx
<Card title="Solar production" subtitle="Today" accent="solar"
      icon={<i data-lucide="sun" />}
      actions={<IconButton label="Expand"><i data-lucide="maximize-2" /></IconButton>}>
  …content…
</Card>

<Card glow accent="battery">…live battery panel…</Card>
<Card interactive>…clickable tile…</Card>
```

Use `accent` to tie a panel to an energy node (solar/battery/grid/home/ev), `glow` for the live/active panel, `interactive` for clickable cards. Bare `<Card>` with no header auto-pads its body.
