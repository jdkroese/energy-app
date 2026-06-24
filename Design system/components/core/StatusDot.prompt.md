**StatusDot** — a small colored dot with an optional label and live pulse, for connection / activity states.

```jsx
<StatusDot tone="solar" live>Producing</StatusDot>
<StatusDot tone="battery" live>Charging</StatusDot>
<StatusDot tone="offline">Inverter offline</StatusDot>
```

Tones: `solar | battery | grid | home | danger | offline`. Set `live` for the pulsing halo on active states.
