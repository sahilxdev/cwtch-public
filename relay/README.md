# Cwtch relay container

Build from this directory or set this directory as your container build context.
The image listens on `0.0.0.0:$PORT` (default `8787`) and exposes `/health`.
It requires no credentials. Configure the environment variables documented in
`../README.md` when deploying.
