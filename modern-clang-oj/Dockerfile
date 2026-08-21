# Reproducible build container for the Modern C/C++ browser engine.
# The digest is retained even when the image is supplied from the local cache.
FROM emscripten/emsdk:5.0.2@sha256:559781dfc5570c6670d74930a04dfe131cff611b4088761662493d537b87976d

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git cmake ninja-build make python3 perl file xz-utils \
    bzip2 tar unzip rsync pkg-config && \
    rm -rf /var/lib/apt/lists/*

ENV LC_ALL=C TZ=UTC SOURCE_DATE_EPOCH=1770336000
ENV PATH=/emsdk:/emsdk/upstream/emscripten:/emsdk/node/22.16.0_64bit/bin:${PATH}
WORKDIR /work
