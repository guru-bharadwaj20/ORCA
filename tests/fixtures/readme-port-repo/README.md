# Invoices API

An Express service. There is no Dockerfile in this repo — the README is the only place
that says which port the service listens on.

## Run it with Docker

```bash
docker run -p 8080:8080 invoices-api:latest
```

## Run it locally

```bash
npm install
PORT=8080 npm start
```
