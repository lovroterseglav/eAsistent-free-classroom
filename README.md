# Free Classrooms

A small website for finding available classrooms in a public eAsistent timetable. FastAPI serves the existing browser interface and reads eAsistent's public timetable pages asynchronously, so the browser never needs direct CORS access to `urniki.easistent.com`.

The verified public request and HTML structure is documented in [docs/easistent.md](docs/easistent.md).

## Local development

Python 3.11 or newer is required.

```sh
python3 -m venv venv
venv/bin/pip install -r requirements.txt
./dev.sh
```

Open `http://127.0.0.1:8080`. The single FastAPI process serves both the website and `/api` routes; Docker and Nginx are not needed for development.

Run the tests with:

```sh
venv/bin/python -m unittest discover -s tests -v
```

## Production

Install dependencies in a virtual environment, set `SCHOOL_CATALOG_PATH` to a persistent writable file, and run one async worker:

```sh
SCHOOL_CATALOG_PATH=/opt/fileserver/eAsistent-free-classroom/schools.json \
venv/bin/gunicorn --bind 127.0.0.1:3100 --workers 1 \
  --worker-class uvicorn_worker.UvicornWorker --timeout 90 web:app
```

Use a reverse proxy for public HTTPS. Keep one worker because admission control, caches, and the school catalog are process-local. One worker admits up to 25 simultaneous availability searches, runs at most 32 eAsistent requests globally, and runs at most six classroom requests for each search.

After the systemd service has been configured, update the checked-out repository and restart the service with:

```sh
./deploy.sh
```

The default service is `easistent-free-classroom.service`. Pass a different unit name as the first argument when needed, for example `./deploy.sh proste-ucilnice.service`.

The server accepts these optional environment variables:

- `SCHOOL_CATALOG_PATH`: persistent school-catalog file; defaults to `.data/schools.json`.
- `HOST` and `PORT`: development-server address used by `dev.sh`; defaults to `127.0.0.1:8080`.

## API

All API errors use the JSON envelope `{ "v": 1, "error": { "code": "...", "message": "..." } }`. Non-health API requests are limited to 30 per minute for each IP address.

### School catalog

`GET /api/v1/schools`

Returns schools bundled with the project and schools that the server has successfully verified. A new school is stored by token, with its root URL constructed as `https://urniki.easistent.com/urniki/TOKEN`. A permanently unavailable school is removed only after a 404 or 410 response; transient failures do not remove it.

### Inspect a school

`POST /api/v1/schools/inspect`

```json
{
  "timetableUrl": "https://urniki.easistent.com/urniki/TOKEN"
}
```

Returns the normalized school, available dates and periods, and discovered classroom count.

### Available classrooms

`POST /api/v1/availability`

```json
{
  "timetableUrl": "https://urniki.easistent.com/urniki/TOKEN",
  "date": "2026-11-17",
  "period": 4
}
```

Returns confirmed available classrooms, classrooms whose state could not be verified, and the occupied count. Dates use ISO `YYYY-MM-DD` in the API; the interface displays `DD/MM/YYYY`. Unknown classrooms are never reported as available.

For a transient network failure, timeout, or HTTP 429/502/503/504 response, the service retries three times after 250 ms, 500 ms, and 1,000 ms. It does not retry HTTP 404 or 410.

## Compatibility verification

The test suite covers parsing, request construction, retries, classroom concurrency, the 25-search admission limit, catalog persistence, and HTTP endpoints using local fixtures. On November 17, 2026, the implementation was also checked against the listed Gimnazija Kranj timetable: inspection found 43 classrooms and availability checked all 43 without unknown results.

The public HTML is not an officially documented API and may change. Run the tests after every deployment and verify `GET /api/v1/health`.
