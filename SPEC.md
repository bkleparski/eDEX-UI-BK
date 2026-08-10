# eDEX-UI-BK — specyfikacja projektu

Samodzielny, autorski terminal na macOS (Apple Silicon, natywny arm64) w stylu wizualnym
i funkcjonalnym eDEX-UI / Tron: Legacy. Kod pisany od zera — bez kopiowania źródeł
oryginalnego eDEX-UI, tylko inspiracja stylem i zestawem funkcji.

## Stack techniczny

- **Electron** (najnowszy stabilny) — natywny arm64, okno bez ramki (frameless), fullscreen.
- **xterm.js** — renderer terminala w warstwie UI.
- **node-pty** — prawdziwa powłoka (zsh) w tle, rebuild pod arm64.
- **systeminformation** (npm) — CPU/RAM/sieć/dysk do paneli monitoringu.
- Czysty **HTML/CSS/JS** (bez frameworka UI) — pełna kontrola nad stylem HUD.
- Build/packaging: `electron-builder`, target `dmg`/`zip` arm64.

## Paleta i styl (Tron: Legacy / GRID)

- Tło: `#000000` / `#02080a`
- Cyjan podstawowy: `#00e5ff`
- Cyjan jasny (glow/hover): `#8ff8ff`
- Cyjan przygaszony (ramki, tekst drugorzędny): `#087f9c`
- Akcent ostrzegawczy: pomarańcz `#ff9f1c` (jak "recognizers" w filmie)
- Font: Monaspace Neon NF (terminal), Orbitron lub podobny geometryczny font do nagłówków/HUD
- Efekty: `text-shadow`/`box-shadow` glow, cienkie linie obwodów (SVG/CSS) jako dekoracja
  paneli, narożniki "HUD corner brackets", subtelny scanline overlay (opcjonalnie, z
  przełącznikiem wł/wył — może obciążać GPU i pogarszać czytelność).

## Układ interfejsu

┌─────────────────────────────────────────────────────────────┐
│  HUD TOP: hostname · data/godzina · uptime · status sieci     │
├───────────────┬─────────────────────────────┬─────────────────┤
│  PANEL LEWY   │      TERMINAL (xterm.js)      │   PANEL PRAWY   │
│  CPU / RAM    │      pełnoprawna powłoka zsh  │   sieć / dysk   │
│  wykresy      │                               │   procesy       │
├───────────────┴─────────────────────────────┴─────────────────┤
│  HUD DOLNY: skróty klawiszowe / status                         │
└─────────────────────────────────────────────────────────────┘

## Zakres funkcji (fazy)

**Faza 0 — szkielet**
- Electron boot, frameless fullscreen window
- xterm.js + node-pty: działająca prawdziwa powłoka zsh
- Podstawowy ciemny theme (bez glow) żeby potwierdzić, że terminal działa

**Faza 1 — styl Tron**
- Paleta kolorów, font, glow, HUD corner brackets, ramki paneli
- Boot/intro animacja (krótka, pomijalna klawiszem)

**Faza 2 — panele monitoringu**
- Lewy panel: CPU (wykres na żywo), RAM
- Prawy panel: sieć (up/down), dysk, lista top procesów
- Odświeżanie przez `systeminformation`, ok. 1s interwał

**Faza 3 — HUD i dopracowanie**
- Górny/dolny pasek HUD: zegar, hostname, uptime, status
- Skróty klawiszowe (nowa zakładka terminala, przełącz panele)

**Faza 4 — ekstra (jeśli starczy czasu/chęci)**
- Dźwięki klawiszy w stylu Tron (przełączalne)
- Kilka zakładek/splitów terminala
- Mini file-browser panel

## Kryterium ukończenia MVP

Aplikacja uruchamia się jako natywny .app na Apple Silicon, w pełnoekranowym oknie
z prawdziwą działającą powłoką zsh, w estetyce Tron (Faza 0+1), z co najmniej jednym
panelem monitoringu (Faza 2 częściowo). Fazy 3-4 to rozszerzenia po MVP.

## Role w zespole

- **Claude (planista)** — pilnuje architektury, dzieli pracę na kroki, odbiera i ocenia
  postępy, koordynuje między Codex a OpenCode.
- **Codex** — implementuje kod, commituje, raportuje postępy i problemy.
- **OpenCode (Kimi K3)** — konsultacje wizualne/GUI: ocena CSS, układu, palety,
  alternatywne pomysły na styl HUD.
