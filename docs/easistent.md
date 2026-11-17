# Preverjena struktura javnega urnika eAsistent

Ta dokument opisuje samo zahteve in HTML-strukturo, ki jih ta projekt dejansko uporablja. Vse spodaj je bilo preverjeno 17. novembra 2026 na javnem urniku Gimnazije Kranj:

```text
https://urniki.easistent.com/urniki/56149a5b3eb5cbefdaf9c9ded39a80c8c31d8f33/razredi/748283
```

## Zahteve

API pošilja običajne `GET` zahteve za javne HTML-strani z glavama:

```http
Accept: text/html
User-Agent: ProsteUcilnice/1.0
```

Uporabljene poti so:

```text
/urniki/{40-znakovni-žeton-šole}/razredi/{id-razreda}
/urniki/{40-znakovni-žeton-šole}/ucilnice
/urniki/{40-znakovni-žeton-šole}/ucilnice/{id-učilnice}
```

Izbrani teden pridobi kot HTML-fragment prek poti:

```text
/urniki/ajax_urnik/{žeton}/{id_razred}/{id_profesor}/{id_dijak}/{id_ucilnica}/{teden}/{id_interesna_dejavnost}/{qversion}
```

### Segmenti poti `ajax_urnik`

Vrstni red segmentov je pomemben; vseh osem vrednosti za `ajax_urnik` je del poti in ne query stringa:

| Položaj | Ime | Preverjen pomen |
| --- | --- | --- |
| 1 | `žeton` | 40-mestni šestnajstiški žeton šole iz javnega URL-ja |
| 2 | `id_razred` | notranji ID izbranega razreda ali `0` |
| 3 | `id_profesor` | notranji ID izbranega profesorja ali `0` |
| 4 | `id_dijak` | notranji ID izbranega dijaka ali `0` |
| 5 | `id_ucilnica` | notranji ID izbrane učilnice ali `0` |
| 6 | `teden` | zaporedna številka tedna šolskega leta |
| 7 | `id_interesna_dejavnost` | notranji ID interesne dejavnosti ali `0` |
| 8 | `qversion` | različica poizvedbe, na preverjenih straneh `1` |

Projekt sprejme `teden` od 1 do 60. Teden 1 je ponedeljek–nedelja, ki vsebuje 1. september. Zato je na primer `2026-11-27` v šolskem tednu 13, čeprav je to 48. koledarski ISO-teden.

Preverjena zahteva za razred in 13. šolski teden je imela obliko:

```text
/urniki/ajax_urnik/56149a5b3eb5cbefdaf9c9ded39a80c8c31d8f33/815595/0/0/0/13/0/1
```

Za učilnico z notranjim ID-jem `9123` je ista struktura:

```text
/urniki/ajax_urnik/56149a5b3eb5cbefdaf9c9ded39a80c8c31d8f33/0/0/0/9123/13/0/1
```

Notranji ID razreda `815595` ni enak javnemu ID-ju razreda `748283`; enako javni ID učilnice v poti `/ucilnice/{javni-id}` ni nujno njen `id_ucilnica`. API teh vrednosti ne ugiba ali pretvarja.

### Odkritje notranjih vrednosti

Projekt konfiguracijo odkrije neposredno v HTML-ju javne strani razreda ali učilnice na enega od dveh preverjenih načinov:

1. Poišče že sestavljeno pot `/urniki/ajax_urnik/...`. Pred iskanjem pretvori JavaScript zapis `\/` nazaj v `/`, preveri žeton šole in zamenja samo segment `teden`.
2. Če sestavljene poti ni, prebere številske JavaScript vrednosti `id_razred`, `id_profesor`, `id_dijak`, `id_ucilnica`, `id_interesna_dejavnost` in `qversion`, nato pot sestavi v vrstnem redu iz zgornje tabele. Manjkajoči ID filtra postane `0`, manjkajoči `qversion` pa `1`.

Pri strani razreda mora biti prisoten `id_razred`, pri posamezni strani učilnice pa `id_ucilnica`. Vsaj eden od prvih štirih notranjih ID-jev mora biti različen od `0`. Žeton v odkriti poti se mora ujemati z žetonom iz javne izvorne strani, sicer se pot zavrne.

### HTTP zahteva

Zahteva za fragment dodatno vsebuje:

```http
GET /urniki/ajax_urnik/{žeton}/{id_razred}/{id_profesor}/{id_dijak}/{id_ucilnica}/{teden}/{id_interesna_dejavnost}/{qversion} HTTP/1.1
Accept: text/html
User-Agent: ProsteUcilnice/1.0
Referer: https://urniki.easistent.com/urniki/{žeton}/...
X-Requested-With: XMLHttpRequest
```

Gre za `GET` brez telesa. Prijava, sejni piškotek, glava `Tab-Unique-Name`, parameter `_` in drugi query parametri niso uporabljeni. Pred pošiljanjem projekt odstrani morebiten query string in fragment iz odkrite AJAX povezave.

### Odgovor in napake

Odgovor je HTML-fragment (`Content-Type: text/html`), ne JSON. Vsebuje isto strukturo glav ur in celic kot javna stran: `th#urnik-ura-{ura}` ter `td#ednevnik-seznam_ur_teden-td-{ura}-{YYYY-MM-DD}`. Projekt najprej preveri, ali zahtevani datum in ura v fragmentu obstajata, nato v ustrezni celici vsake učilnice išče bloke zasedenosti.

Začasne omrežne napake in odgovore 429, 502, 503 ali 504 ponovi trikrat po 250 ms, 500 ms in 1.000 ms. Odgovorov 404 in 410 ne ponavlja. Posamezen poskus ima desetsekundno omejitev; sprejeti so največ trije preusmeritveni koraki in največ 2 MiB HTML-ja. Vsaka preusmeritev mora ostati na dovoljenem eAsistent gostitelju, uporabljati HTTPS, ohraniti obliko `ajax_urnik` in isti žeton šole.

## Potek

1. Stran razreda poda ime šole, trenutno prikazane datume, šolske ure in notranjo konfiguracijo zahteve.
2. Zbirna stran `/ucilnice` poda popoln seznam učilnic.
3. Datum se pretvori v zaporedni teden šolskega leta; teden, ki vsebuje 1. september, je teden 1.
4. Fragment razreda potrdi, da izbrani datum in ura v ciljnem tednu obstajata.
5. Za vsako učilnico API iz njene javne strani odkrije notranji ID in prebere fragment ciljnega tedna, največ šest hkrati.
6. Če notranja konfiguracija manjka, lahko trenutni teden še vedno uporabi HTML javne strani.
7. Rezultati se pet minut hranijo v pomnilniku. Predpomnilnik vsebuje največ 500 strani.

Živi preizkus je na zbirni strani našel 43 učilnic in nato uspešno prebral vseh 43 strani učilnic.

## Uporabljeni deli HTML-ja

Ime šole:

```css
.urnik_title
```

Učilnice so možnosti v izbirniku `#id_parameter`. Vrednost možnosti je številski ID, besedilo pa prikazano ime učilnice:

```css
#id_parameter option
```

Glava šolske ure ima ID `urnik-ura-{številka}`. Časovni razpon je besedilo v njenem elementu `.potek-ure` in ima obliko `HH:MM - HH:MM`:

```css
th[id^="urnik-ura-"] .potek-ure
```

Celica urnika za učilnico je določena z uro in datumom:

```text
ednevnik-seznam_ur_teden-td-{številka-ure}-{YYYY-MM-DD}
```

Elementi `.ednevnik-seznam_ur_teden-blok-wrap` v tej celici predstavljajo zasedenost. Celica brez takih elementov je prosta; manjkajoča celica ima neznano stanje in se nikoli ne prikaže kot prosta.

## Preverjen primer rezultata

Za datum `2026-11-17` in 4. šolsko uro je živi preizkus vrnil:

- 43 učilnic skupaj,
- 11 prostih,
- 32 zasedenih,
- 0 z neznanim stanjem.

To so podatki preizkusa, ne trajen podatek o urniku.

## Česa projekt ne uporablja

Projekt ne uporablja prijave, piškotkov, zasebnih uporabniških podatkov ali JSON endpointa. Uporablja samo javne HTML-strani in javni HTML-fragment zgoraj. Ker struktura ni uradno verzionirana API-pogodba, je treba združljivost po namestitvi ponovno preveriti z ukazi v glavnem README-ju.
