# SPICE model library

Fetched from [KiCad-Spice-Library](https://github.com/kicad-spice-library/KiCad-Spice-Library) (originally aggregated from ngspice model collections and vendor libraries).

```bash
npm run fetch-spice-models
```

- `models/` — `.lib` / `.mod` files by category (Diode, Transistor, Digital Logic, …). Downloaded; replaced on every fetch.
- `bundled/` — our own vendor models (TI SN74HCxx gates) plus `bundled/catalog.json`. Kept across fetches; catalog `lib` paths for these start with `bundled/`.
- `catalog.json` — index of `.model` / `.subckt` names → library path (fetched index + `bundled/catalog.json` merged).

**Offline:** served from `/spice/models/` and `/spice/bundled/`; the ngspice worker inlines `.include` files from these folders.
