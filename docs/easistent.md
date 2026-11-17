# Verified eAsistent public timetable structure

This document describes only the requests and HTML structure that this project actually uses. Everything below was verified on November 17, 2026 against the public Gimnazija Kranj timetable:

```text
https://urniki.easistent.com/urniki/56149a5b3eb5cbefdaf9c9ded39a80c8c31d8f33/razredi/748283
```

## Requests

The API sends ordinary `GET` requests for public HTML pages with these headers:

```http
Accept: text/html
User-Agent: ProsteUcilnice/1.0
```

The following paths are used:

```text
/urniki/{40-character-school-token}/razredi/{class-id}
/urniki/{40-character-school-token}/ucilnice
/urniki/{40-character-school-token}/ucilnice/{classroom-id}
```

The selected week is retrieved as an HTML fragment through this path:

```text
/urniki/ajax_urnik/{school_token}/{id_razred}/{id_profesor}/{id_dijak}/{id_ucilnica}/{week}/{id_interesna_dejavnost}/{qversion}
```

### `ajax_urnik` path segments

Segment order matters. All eight `ajax_urnik` values are path segments, not query parameters:

| Position | Name | Verified meaning |
| --- | --- | --- |
| 1 | `school_token` | The 40-character hexadecimal school token from the public URL |
| 2 | `id_razred` | Internal ID of the selected class, or `0` |
| 3 | `id_profesor` | Internal ID of the selected teacher, or `0` |
| 4 | `id_dijak` | Internal ID of the selected student, or `0` |
| 5 | `id_ucilnica` | Internal ID of the selected classroom, or `0` |
| 6 | `week` | Sequential school-week number |
| 7 | `id_interesna_dejavnost` | Internal extracurricular-activity ID, or `0` |
| 8 | `qversion` | Query version; `1` on the verified pages |

The project accepts `week` values from 1 through 60. Week 1 is the Monday-to-Sunday week containing September 1. For example, `2026-11-27` is in school week 13 even though it is in ISO calendar week 48.

A verified class request for school week 13 had this form:

```text
/urniki/ajax_urnik/56149a5b3eb5cbefdaf9c9ded39a80c8c31d8f33/815595/0/0/0/13/0/1
```

The same structure for a classroom with internal ID `9123` is:

```text
/urniki/ajax_urnik/56149a5b3eb5cbefdaf9c9ded39a80c8c31d8f33/0/0/0/9123/13/0/1
```

The internal class ID `815595` is not the same as the public class ID `748283`. Likewise, a classroom's public ID in `/ucilnice/{public-id}` is not necessarily its `id_ucilnica`. The API does not guess or convert these values.

### Discovering internal values

The project discovers the configuration directly from the public class or classroom page HTML in one of two verified ways:

1. It finds an already assembled `/urniki/ajax_urnik/...` path. Before searching, it converts the JavaScript escape `\/` back to `/`, verifies the school token, and replaces only the `week` segment.
2. If no assembled path exists, it reads the numeric JavaScript values `id_razred`, `id_profesor`, `id_dijak`, `id_ucilnica`, `id_interesna_dejavnost`, and `qversion`, then builds the path in the order shown above. A missing filter ID becomes `0`, and a missing `qversion` becomes `1`.

A class page must provide `id_razred`, while an individual classroom page must provide `id_ucilnica`. At least one of the first four internal IDs must be different from `0`. A token discovered in the page must match the token from the public source page or the path is rejected.

### HTTP request

The fragment request also includes these headers:

```http
GET /urniki/ajax_urnik/{school_token}/{id_razred}/{id_profesor}/{id_dijak}/{id_ucilnica}/{week}/{id_interesna_dejavnost}/{qversion} HTTP/1.1
Accept: text/html
User-Agent: ProsteUcilnice/1.0
Referer: https://urniki.easistent.com/urniki/{school_token}/...
X-Requested-With: XMLHttpRequest
```

This is a bodyless `GET` request. Authentication, session cookies, the `Tab-Unique-Name` header, the `_` parameter, and other query parameters are not used. Before sending the request, the project removes any query string or fragment from a discovered AJAX URL.

### Response and errors

The response is an HTML fragment (`Content-Type: text/html`), not JSON. It contains the same period-header and timetable-cell structure as the public page: `th#urnik-ura-{period}` and `td#ednevnik-seznam_ur_teden-td-{period}-{YYYY-MM-DD}`. The project first verifies that the requested date and period exist in the fragment, then checks the matching cell for each classroom for occupancy blocks.

Transient network failures and HTTP 429, 502, 503, or 504 responses are retried three times after 250 ms, 500 ms, and 1,000 ms. HTTP 404 and 410 responses are not retried. Each attempt has a ten-second timeout. At most three redirects and 2 MiB of HTML are accepted. Every redirect must remain on an allowed eAsistent host, use HTTPS, retain the `ajax_urnik` path structure, and use the same school token.

## Request flow

1. The class page provides the school name, currently displayed dates, periods, and internal request configuration.
2. The `/ucilnice` collection page provides the complete classroom list.
3. The requested date is converted to the sequential school week; the week containing September 1 is week 1.
4. The class fragment confirms that the requested date and period exist in the target week.
5. For each classroom, the API discovers its internal ID from its public page and retrieves the target-week fragment, with at most six classroom requests running concurrently.
6. If the internal configuration is missing, the current week can still use the public page HTML.
7. Results are cached in memory for five minutes. The cache holds at most 500 pages.

The live test found 43 classrooms on the collection page and successfully retrieved all 43 classroom pages.

## HTML elements used

School name:

```css
.urnik_title
```

Classrooms are options in the `#id_parameter` selector. An option's value is its numeric ID and its text is the displayed classroom name:

```css
#id_parameter option
```

A period header has the ID `urnik-ura-{number}`. Its `.potek-ure` element contains a time range in the form `HH:MM - HH:MM`:

```css
th[id^="urnik-ura-"] .potek-ure
```

A classroom timetable cell is identified by period and date:

```text
ednevnik-seznam_ur_teden-td-{period-number}-{YYYY-MM-DD}
```

Elements matching `.ednevnik-seznam_ur_teden-blok-wrap` inside the cell represent occupancy. A cell without such elements is available. A missing cell has an unknown state and is never reported as available.

## Verified result example

For `2026-11-17` and period 4, the live test returned:

- 43 classrooms in total,
- 11 available,
- 32 occupied,
- 0 with an unknown state.

These are test results, not permanent timetable data.

## Features not used by this project

The project does not use authentication, cookies, private user data, or a JSON endpoint. It uses only public HTML pages and the public HTML fragment described above. This structure is not an officially versioned API contract, so compatibility must be rechecked after deployment by running the test suite and checking the health endpoint.
