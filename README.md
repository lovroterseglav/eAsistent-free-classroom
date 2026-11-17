# Free Classrooms

A simple website for finding available classrooms in a public eAsistent timetable. The browser calls the project's Fastify API on the same domain, and the API reads the public timetable pages. This means the browser does not need direct CORS access to `urniki.easistent.com`.

The verified public request and HTML structure is documented in [docs/easistent.md](docs/easistent.md).

## Local development and testing

Node.js 22 or newer and npm are required.

```sh
npm --prefix api ci
npm test
```

This checks the JavaScript client, compiles the TypeScript API, and runs the parser and HTTP endpoint tests.

Start the complete website locally with:

```sh
npm run dev
```

Open `http://localhost:8080`. A single process serves the `dist` directory and the `/api` routes on the same port. Docker and Nginx are not required for local development.

## API

All responses are JSON. Requests are limited to 30 per minute for each IP address.

### School catalog

`GET /api/v1/schools`

Returns the combined list of schools that the server has successfully verified. After a successful request, a new school is stored by its token and its root URL is constructed as `https://urniki.easistent.com/urniki/TOKEN`. Duplicate tokens are not added. A permanently unavailable school is removed only after a 404 or 410 response from its root URL; transient network failures do not remove it.

### Inspect a school

`POST /api/v1/schools/inspect`

```json
{
  "timetableUrl": "https://urniki.easistent.com/urniki/TOKEN"
}
```

Returns the normalized school, available dates and periods, and the number of discovered classrooms.

### Available classrooms

`POST /api/v1/availability`

```json
{
  "timetableUrl": "https://urniki.easistent.com/urniki/TOKEN",
  "date": "2026-11-17",
  "period": 4
}
```

Returns confirmed available classrooms, classrooms with an unknown state, and the number of occupied classrooms. The date may be any valid day in the current school year; the API converts it into eAsistent's sequential school-week number. An unknown state is intentionally never counted as available.

For a transient network failure, timeout, or HTTP 429/502/503/504 response, the API retries the request three times after delays of 250 ms, 500 ms, and 1,000 ms. It does not retry 404 or 410 responses.

## Compatibility verification

The repository contains tests based on local HTML fixtures and tests for the complete API endpoints. On November 17, 2026, both endpoints were also run against the listed live Gimnazija Kranj timetable: inspection found 43 classrooms, and the availability calculation checked all 43 classroom pages without unknown results.

The public HTML is not an officially documented API and may change. Run the tests after every deployment and verify `/api/v1/health`.
