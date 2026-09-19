# GitHub's runner image, pinned to the verified 2.337.0 multi-platform digest.
FROM ghcr.io/actions/actions-runner:2.337.0@sha256:e5496277be5d09bc968b3d64911b74e219ac4a3f2edce956a3ecf9271bea1ef4
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential python3 gh zip zstd fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*
COPY --chmod=755 start-linux.sh /usr/local/bin/start-linux-runner
USER runner
ENTRYPOINT ["/usr/local/bin/start-linux-runner"]
