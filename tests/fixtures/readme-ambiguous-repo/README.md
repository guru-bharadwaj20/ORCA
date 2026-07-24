# Project Aurora

Aurora is an experimental data pipeline we put together over a weekend. It reads events
off a queue, enriches them, and writes the results somewhere useful.

## Philosophy

We believe tooling should get out of your way. There is no build step to speak of, and
you should be able to get going in about five minutes on any reasonably modern laptop.

## Setup

Getting set up is mostly a matter of having the right things on your PATH. You will need
a recent toolchain, some environment variables pointing at your queue, and credentials
with read access. Ask someone on the team for the shared development credentials — they
rotate weekly, so anything written down here would be out of date by the time you read
it.

Once that is sorted, the usual entrypoint should just work. If it does not, check that
your environment variables are exported in the current shell and that the queue is
reachable from your network.

## Configuration

Settings live in `aurora.toml`:

```toml
[server]
host = "0.0.0.0"
port = 7777

[queue]
depth = 128
```

The equivalent as environment variables:

```yaml
server:
  host: 0.0.0.0
  port: 7777
queue:
  depth: 128
```

## Notes

Some shell housekeeping you might find useful:

```bash
git clone https://github.com/example/aurora.git
cd aurora
export AURORA_ENV=dev
source ./secrets.env
curl -s https://example.com/health
```

## Troubleshooting

If nothing happens, it is almost always the queue connection. Check the logs.
