# Proste učilnice

Preprosta spletna stran za iskanje prostih učilnic v javnem urniku eAsistent. Brskalnik kliče lasten Fastify API na isti domeni, API pa prebere javne strani urnika. Tako brskalnik ne potrebuje neposrednega CORS-dostopa do `urniki.easistent.com`.

Preverjena struktura javnih zahtev in HTML-ja je opisana v [docs/easistent.md](docs/easistent.md).

## Lokalno preverjanje

Zahtevana sta Node.js 22 ali novejši in npm.

```sh
npm --prefix api ci
npm test
```

Ukaz preveri JavaScript odjemalca, prevede TypeScript API in požene teste razčlenjevalnika ter HTTP endpointov.

Celotno spletno stran lokalno zaženeš z:

```sh
npm run dev
```

Odpri `http://localhost:8080`. En proces na istih vratih servira mapo `dist` in API-poti `/api`. Docker in Nginx za lokalni razvoj nista potrebna.

## API

Vsi odgovori so JSON. Omejitev je 30 zahtev na minuto za posamezen IP.

### Seznam šol

`GET /api/v1/schools`

Vrne skupni seznam šol, ki jih je strežnik že uspešno preveril. Ob uspešni poizvedbi se nova šola shrani po žetonu, njen osnovni URL pa se sestavi kot `https://urniki.easistent.com/urniki/TOKEN`. Podvojeni žetoni se ne dodajajo. Dokončno nedosegljiva šola se odstrani samo ob odgovoru 404 ali 410 na njen osnovni URL; začasne omrežne napake je ne izbrišejo.

### Pregled šole

`POST /api/v1/schools/inspect`

```json
{
  "timetableUrl": "https://urniki.easistent.com/urniki/TOKEN"
}
```

Vrne normalizirano šolo, razpoložljive datume in šolske ure ter število najdenih učilnic.

### Proste učilnice

`POST /api/v1/availability`

```json
{
  "timetableUrl": "https://urniki.easistent.com/urniki/TOKEN",
  "date": "2026-11-17",
  "period": 4
}
```

Vrne potrjeno proste učilnice, učilnice z neznanim stanjem in število zasedenih učilnic. Datum je lahko katerikoli veljaven dan trenutnega šolskega leta; API iz njega sestavi eAsistentov zaporedni šolski teden. Neznano stanje se namenoma ne šteje kot prosto.

Pri začasni omrežni napaki, timeoutu ali odgovoru HTTP 429/502/503/504 API zahtevo ponovi trikrat z zamiki 250 ms, 500 ms in 1.000 ms. Odgovorov 404 in 410 ne ponavlja.

## Preverjanje združljivosti

Repozitorij vsebuje teste z lokalnimi HTML vzorci in teste celotnih API endpointov. Poleg tega sta bila 17. novembra 2026 zagnana oba endpointa proti navedenemu živemu urniku Gimnazije Kranj: pregled je našel 43 učilnic, izračun razpoložljivosti pa je brez neznanih rezultatov preveril vseh 43 strani učilnic.

Javni HTML ni uradno opisan API in se lahko spremeni. Po vsaki namestitvi zato poženi teste in preveri `/api/v1/health`.
