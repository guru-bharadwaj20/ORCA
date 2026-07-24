# Widget API

A small service for managing widgets. Built by the team during a hackathon, so the
setup is a little rough around the edges — sorry about that.

## Getting started

First clone the repo and move into it:

```bash
git clone https://github.com/example/widget-api.git
cd widget-api
```

Then install the dependencies and start the dev server:

```bash
npm install
npm run dev
```

Once it boots, open http://localhost:4000 in your browser.

## Running the worker

The background worker is a separate process:

```sh
$ python worker.py
```

## Configuration

The service reads its settings from `config.json`:

```json
{
  "retries": 3,
  "timeout": 5000,
  "port": 9999
}
```

And the client is configured in code:

```js
const client = new WidgetClient({ port: 1234, host: 'example.com' });
```

## Docker

If you would rather not install Node locally:

```
docker run -p 8080:4000 widget-api:latest
```
