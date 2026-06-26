import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { MapContainer, TileLayer, Marker, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { api, ApiError } from '../lib/api';
import type { IntegrationsConfig, ProbeResult } from '../lib/types';
import { Card, Input, Button, Icon } from './ui';
import { useAuth } from '../auth/AuthProvider';

/** Jávea (Xàbia) — the default site, mirrors the API config fallback. */
const DEFAULT_POS = { lat: 38.79, lon: 0.17 };

/** Power-styled map pin (a glowing solar dot). Using a DivIcon also sidesteps
 *  Leaflet's default marker-image asset paths, which break under Vite. */
const PIN = L.divIcon({
  className: 'pwr-map-pin',
  html: '<span class="pwr-map-pin__dot"></span>',
  iconSize: [22, 22],
  iconAnchor: [11, 11],
});

type Pos = { lat: number; lon: number };
type GeoHit = { display_name: string; lat: string; lon: string };

const fmt = (n: number) => Number(n.toFixed(5));
const cfgDesc: CSSProperties = { fontSize: 13, color: 'var(--text-2)', lineHeight: 1.5 };

/** Captures clicks on the map and reports the lat/lon back. */
function ClickCapture({ onPick }: { onPick: (lat: number, lon: number) => void }) {
  useMapEvents({
    click(e) {
      onPick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

/**
 * SiteLocationCard — interactive map pin + browser geolocation + address search
 * that all resolve to the site's lat/lon. Saves through the existing weather
 * endpoint (Open-Meteo probe validates before persisting). Admin-only editing.
 */
export function SiteLocationCard() {
  const { user } = useAuth();
  const editable = user?.role === 'admin';

  const mapRef = useRef<L.Map | null>(null);
  const [cfg, setCfg] = useState<IntegrationsConfig | null>(null);
  const [pos, setPos] = useState<Pos | null>(null);
  const [latText, setLatText] = useState('');
  const [lonText, setLonText] = useState('');

  const [address, setAddress] = useState<string | null>(null);
  const [addrBusy, setAddrBusy] = useState(false);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GeoHit[]>([]);
  const [searchBusy, setSearchBusy] = useState(false);
  const [showResults, setShowResults] = useState(false);

  const [geoBusy, setGeoBusy] = useState(false);
  const [geoErr, setGeoErr] = useState<string | null>(null);

  const [saveBusy, setSaveBusy] = useState(false);
  const [res, setRes] = useState<ProbeResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Load the current configured coordinates once.
  useEffect(() => {
    let live = true;
    api.integrations
      .config()
      .then((c) => {
        if (!live) return;
        setCfg(c);
        const p = { lat: c.weather.lat, lon: c.weather.lon };
        setPos(p);
        setLatText(String(fmt(p.lat)));
        setLonText(String(fmt(p.lon)));
      })
      .catch(() => {
        if (!live) return;
        setPos(DEFAULT_POS);
        setLatText(String(DEFAULT_POS.lat));
        setLonText(String(DEFAULT_POS.lon));
      });
    return () => {
      live = false;
    };
  }, []);

  /** Move pin + text + (optionally) recenter the map. Used by map/search/geo. */
  const applyPos = (lat: number, lon: number, recenter = false) => {
    const p = { lat: fmt(lat), lon: fmt(lon) };
    setPos(p);
    setLatText(String(p.lat));
    setLonText(String(p.lon));
    setRes(null);
    setErr(null);
    if (recenter && mapRef.current) {
      mapRef.current.setView([p.lat, p.lon], Math.max(mapRef.current.getZoom() ?? 13, 15));
    }
  };

  // Reverse-geocode the current pin into a human address (debounced).
  useEffect(() => {
    if (!pos) return;
    const ctrl = new AbortController();
    setAddrBusy(true);
    const t = setTimeout(() => {
      fetch(
        `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${pos.lat}&lon=${pos.lon}&accept-language=en`,
        { signal: ctrl.signal, headers: { Accept: 'application/json' } },
      )
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { display_name?: string } | null) => {
          setAddress(d?.display_name ?? null);
          setAddrBusy(false);
        })
        .catch((e) => {
          if ((e as Error).name !== 'AbortError') setAddrBusy(false);
        });
    }, 700);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [pos?.lat, pos?.lon]);

  // Forward-geocode the search box (debounced).
  useEffect(() => {
    const q = query.trim();
    if (!editable || q.length < 3) {
      setResults([]);
      return;
    }
    const ctrl = new AbortController();
    setSearchBusy(true);
    const t = setTimeout(() => {
      fetch(
        `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&accept-language=en&q=${encodeURIComponent(q)}`,
        { signal: ctrl.signal, headers: { Accept: 'application/json' } },
      )
        .then((r) => (r.ok ? r.json() : []))
        .then((d: GeoHit[]) => {
          setResults(Array.isArray(d) ? d : []);
          setShowResults(true);
          setSearchBusy(false);
        })
        .catch((e) => {
          if ((e as Error).name !== 'AbortError') setSearchBusy(false);
        });
    }, 600);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [query, editable]);

  const pickResult = (h: GeoHit) => {
    setQuery(h.display_name);
    setShowResults(false);
    setResults([]);
    applyPos(Number(h.lat), Number(h.lon), true);
  };

  const onLatText = (v: string) => {
    setLatText(v);
    const n = Number(v);
    if (v.trim() !== '' && Number.isFinite(n) && n >= -90 && n <= 90 && pos) {
      setPos({ lat: fmt(n), lon: pos.lon });
    }
  };
  const onLonText = (v: string) => {
    setLonText(v);
    const n = Number(v);
    if (v.trim() !== '' && Number.isFinite(n) && n >= -180 && n <= 180 && pos) {
      setPos({ lat: pos.lat, lon: fmt(n) });
    }
  };

  const useMyLocation = () => {
    setGeoErr(null);
    if (!('geolocation' in navigator)) {
      setGeoErr('Geolocation not supported on this device.');
      return;
    }
    setGeoBusy(true);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setGeoBusy(false);
        applyPos(p.coords.latitude, p.coords.longitude, true);
      },
      (e) => {
        setGeoBusy(false);
        setGeoErr(e.code === e.PERMISSION_DENIED ? 'Location permission denied.' : 'Could not get your location.');
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  const save = async () => {
    if (!pos) return;
    setSaveBusy(true);
    setErr(null);
    setRes(null);
    try {
      const r = await api.integrations.setWeather(pos.lat, pos.lon);
      setRes({ ok: r.ok, detail: r.detail });
      setCfg(r.config);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not save — try again');
    } finally {
      setSaveBusy(false);
    }
  };

  const dirty =
    !!pos && !!cfg && (fmt(pos.lat) !== fmt(cfg.weather.lat) || fmt(pos.lon) !== fmt(cfg.weather.lon));

  return (
    <Card title="Site location" style={{ padding: 0 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 16px 16px' }}>
        <div style={cfgDesc}>
          Drop the pin on the property — it sets the coordinates that drive the solar &amp; weather
          forecast. Search an address, drag the pin, or use your current location.
        </div>

        {editable && (
          <div style={{ position: 'relative' }}>
            <label className="pwr-input-field">
              <span className="pwr-input-field__label">Search address</span>
              <span style={{ position: 'relative', display: 'block' }}>
                <input
                  className="pwr-input"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onFocus={() => results.length && setShowResults(true)}
                  placeholder="e.g. Calle… Jávea, Spain"
                  style={{ paddingRight: 34 }}
                />
                <span style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)', display: 'grid', placeItems: 'center' }}>
                  <Icon name={searchBusy ? 'loader' : 'search'} size={16} />
                </span>
              </span>
            </label>
            {showResults && results.length > 0 && (
              <div
                style={{
                  position: 'absolute',
                  top: '100%',
                  left: 0,
                  right: 0,
                  zIndex: 1200,
                  marginTop: 4,
                  background: 'var(--surface-3)',
                  border: '1px solid var(--border-1)',
                  borderRadius: 10,
                  overflow: 'hidden',
                  boxShadow: '0 10px 30px rgba(0,0,0,.45)',
                }}
              >
                {results.map((h, i) => (
                  <button
                    key={`${h.lat},${h.lon},${i}`}
                    onClick={() => pickResult(h)}
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      padding: '9px 12px',
                      fontSize: 12.5,
                      lineHeight: 1.4,
                      color: 'var(--text-1)',
                      background: 'none',
                      border: 'none',
                      borderTop: i === 0 ? 'none' : '1px solid var(--border-1)',
                      cursor: 'pointer',
                    }}
                  >
                    {h.display_name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="pwr-map">
          {pos && (
            <MapContainer
              ref={mapRef}
              center={[pos.lat, pos.lon]}
              zoom={15}
              scrollWheelZoom
              style={{ height: '100%', width: '100%' }}
            >
              <TileLayer
                url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
                maxZoom={20}
              />
              {editable && <ClickCapture onPick={(la, lo) => applyPos(la, lo, false)} />}
              <Marker
                position={[pos.lat, pos.lon]}
                draggable={editable}
                icon={PIN}
                eventHandlers={{
                  dragend(e) {
                    const ll = (e.target as L.Marker).getLatLng();
                    applyPos(ll.lat, ll.lng, false);
                  },
                }}
              />
            </MapContainer>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.45 }}>
          <span style={{ color: 'var(--solar)', flex: 'none', marginTop: 1 }}>
            <Icon name="map-pin" size={15} />
          </span>
          <span>{addrBusy ? 'Locating…' : address || 'Address unavailable for this point'}</span>
        </div>

        {editable ? (
          <div style={{ display: 'flex', gap: 8 }}>
            <Input label="Latitude" inputMode="decimal" value={latText} onChange={(e) => onLatText(e.target.value)} placeholder="38.79" />
            <Input label="Longitude" inputMode="decimal" value={lonText} onChange={(e) => onLonText(e.target.value)} placeholder="0.17" />
          </div>
        ) : (
          <div style={{ fontSize: 12.5, fontFamily: 'var(--font-mono)', color: 'var(--text-2)' }}>
            {pos ? `${fmt(pos.lat)}, ${fmt(pos.lon)}` : '—'}
          </div>
        )}

        {geoErr && <div style={{ fontSize: 11.5, color: 'var(--danger)' }}>{geoErr}</div>}
        {err && <div style={{ fontSize: 11.5, color: 'var(--danger)' }}>{err}</div>}
        {res && <div style={{ fontSize: 11.5, color: res.ok ? 'var(--solar)' : 'var(--danger)' }}>{res.ok ? '✓ ' : ''}{res.detail}</div>}

        {editable ? (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button size="sm" variant="secondary" loading={geoBusy} iconLeft={<Icon name="crosshair" size={15} />} onClick={useMyLocation}>
              Use my location
            </Button>
            <Button size="sm" variant="primary" loading={saveBusy} disabled={!dirty} onClick={() => void save()}>
              Save location
            </Button>
          </div>
        ) : (
          <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>Only an admin can change this.</div>
        )}
      </div>
    </Card>
  );
}
