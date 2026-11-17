# Preverjena struktura javnega urnika eAsistent

Ta dokument opisuje samo zahteve in HTML-strukturo, ki jih ta projekt dejansko uporablja. Vse spodaj je bilo preverjeno 17. novembra 2026 na javnem urniku Gimnazije Kranj:

```text
https://urniki.easistent.com/urniki/56149a5b3eb5cbefdaf9c9ded39a80c8c31d8f33/razredi/748283
```

## Zahteve

API pošilja običajne `GET` zahteve za HTML z glavama:

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

Vse zahteve uporabljajo HTTPS in gostitelja `urniki.easistent.com`. API sprejme največ tri preusmeritve in vsako ciljno povezavo ponovno preveri, preden ji sledi. Posamezna zahteva ima desetsekundno omejitev, HTML-odgovor pa je omejen na 2 MiB.

## Potek

1. Stran razreda poda ime šole, datume in šolske ure.
2. Zbirna stran `/ucilnice` poda popoln seznam učilnic.
3. Za izbrani datum in uro API prebere stran vsake učilnice, največ šest hkrati.
4. Rezultati strani se pet minut hranijo v pomnilniku. Predpomnilnik vsebuje največ 500 strani.

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

Projekt ne uporablja prijave, piškotkov, zasebnih uporabniških podatkov ali nedokumentiranega JSON endpointa. Odvisen je samo od javno dostopnih HTML-strani zgoraj. Ker HTML ni uradno verzionirana API-pogodba, je treba združljivost po namestitvi ponovno preveriti z ukazi v glavnem README-ju.
