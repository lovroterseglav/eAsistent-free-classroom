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

## Namestitev na Hetzner

Na strežniku potrebuješ Node.js 22 ali novejši, npm in Nginx. Docker ni potreben.

1. Kopiraj repozitorij v `/opt/proste-ucilnice`, namesti odvisnosti in prevedi API:

   ```sh
   cd /opt/proste-ucilnice
   sudo npm --prefix api ci
   sudo npm --prefix api run build
   sudo npm --prefix api prune --omit=dev
   ```

2. Namesti produkcijske nastavitve. Datoteko lahko pozneje spremeniš brez urejanja systemd enote:

   ```sh
   sudo install -d -m 0750 -o root -g deploy /opt/config/proste-ucilnice
   sudo install -m 0640 -o root -g deploy \
     deploy/proste-ucilnice.env.example /opt/config/proste-ucilnice/env
   ```

3. Namesti in zaženi systemd storitev:

   ```sh
   sudo cp deploy/proste-ucilnice.service.example /etc/systemd/system/proste-ucilnice.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now proste-ucilnice
   curl http://127.0.0.1:3100/api/v1/health
   ```

   Storitev teče kot uporabnik `deploy`, posluša samo na `127.0.0.1:3100`, se po napaki samodejno ponovno zažene in hrani naučeni seznam šol v `/var/lib/proste-ucilnice/schools.json`.

4. Objavi statične datoteke:

   ```sh
   sudo mkdir -p /var/www/proste-ucilnice
   sudo cp -a dist/. /var/www/proste-ucilnice/
   ```

5. Kopiraj `deploy/nginx.conf.example` v `/etc/nginx/sites-available/proste-ucilnice`, zamenjaj `classrooms.example.com` s svojo domeno in omogoči konfiguracijo:

   ```sh
   sudo ln -s /etc/nginx/sites-available/proste-ucilnice /etc/nginx/sites-enabled/proste-ucilnice
   sudo nginx -t
   sudo systemctl reload nginx
   ```

6. Pred uporabo preveri oba javna endpointa:

   ```sh
   curl https://TVOJA-DOMENA/api/v1/health
   curl -X POST https://TVOJA-DOMENA/api/v1/schools/inspect \
     -H 'content-type: application/json' \
     --data '{"timetableUrl":"https://urniki.easistent.com/urniki/56149a5b3eb5cbefdaf9c9ded39a80c8c31d8f33"}'
   ```

HTTPS nastavi v Nginxu za svojo domeno, preden stran ponudiš uporabnikom. Ker odjemalec uporablja relativne poti `/api/...`, posebna nastavitev naslova API ni potrebna.

## Preverjanje združljivosti

Repozitorij vsebuje teste z lokalnimi HTML vzorci in teste celotnih API endpointov. Poleg tega sta bila 17. novembra 2026 zagnana oba endpointa proti navedenemu živemu urniku Gimnazije Kranj: pregled je našel 43 učilnic, izračun razpoložljivosti pa je brez neznanih rezultatov preveril vseh 43 strani učilnic.

Javni HTML ni uradno opisan API in se lahko spremeni. Po vsaki namestitvi zato poženi oba `curl` ukaza iz prejšnjega razdelka.
