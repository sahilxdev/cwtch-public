# Cwtch relay

Run `npm ci && npm start` here, or use `npm ci --prefix relay && npm start` from the repository root.

The Dockerfile requires the **repository root** as build context because the relay imports the shared protocol from `extension/shared/`:

```sh
docker build -f relay/Dockerfile -t cwtch-relay .
```

See the root README and `docs/OPERATIONS.md` for TLS, origins, limits, monitoring, and deployment acceptance.
