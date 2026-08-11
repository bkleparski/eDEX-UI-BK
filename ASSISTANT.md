# Asystent AI w eDEX-UI BK

## Providery

- Ollama: `http://127.0.0.1:11434`, lokalny, dostępny w HUD i terminalu.
- LM Studio: `http://127.0.0.1:1234/v1`, lokalny, dostępny w HUD i terminalu.
- OpenRouter: provider chmurowy, dostępny wyłącznie w HUD.
- OpenCode Go: provider chmurowy, dostępny wyłącznie w HUD.

Modele są pobierane dynamicznie z katalogu każdego providera. Routing protokołów OpenCode Go jest jawnie mapowany w `src/main/assistant/opencode-go-provider.js`; model bez znanego protokołu jest widoczny, ale wyłączony.

## Ustawienia

Panel `SETTINGS` zapisuje wybór providera, modele i klucze w `config.json` katalogu Electron `userData`. Plik ma prawa `0600`, ale klucze pozostają plaintext zgodnie z zaakceptowaną polityką. Renderer otrzymuje tylko informację, czy klucz jest skonfigurowany.

Zmiana providera lub modelu w HUD rozpoczyna nowy kontekst rozmowy. Historia istnieje wyłącznie w pamięci procesu i nie jest zapisywana na dysku.

## Terminal

```text
ai <prompt>             Ollama
ai --lms <prompt>       LM Studio
search <query>          Brave Search + Ollama
search --lms <query>    Brave Search + LM Studio
```

Terminal nie ma dostępu do providerów chmurowych. Komendy komunikują się z main process przez chroniony Unix socket; odpowiedzi są oczyszczane z sekwencji ANSI i znaków sterujących.

## Testy

```text
npm run test:unit
npm run test:providers:local
npm run test:cli:local
npm run test:providers:cloud
npm run test:smoke
npm run test:assistant-ui
npm run test:visual
npm run dist
```

`test:providers:cloud` wymaga `OPENROUTER_API_KEY` i `OPENCODE_GO_API_KEY` wyłącznie w środowisku procesu. Żaden skrypt testowy nie zawiera ani nie zapisuje kluczy.
