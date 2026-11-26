# The resident Sunspot prover (sunspotd/main.go), built inside the pinned Sunspot module so it
# reads keys and witnesses with the same gnark the verifier programs were generated with.
FROM golang:1.24-bookworm AS sunspotd
ARG SUNSPOT_COMMIT=0a9f7d01070cfb8b34cbfa77e4782e18adacc096
RUN git clone --quiet https://github.com/reilabs/sunspot.git /sunspot \
 && git -C /sunspot checkout --quiet ${SUNSPOT_COMMIT}
COPY sunspotd/main.go /sunspot/go/cmd/sunspotd/main.go
RUN cd /sunspot/go && go build -o /out/sunspotd ./cmd/sunspotd

FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# Barretenberg prover, pinned to the version the circuit was built with
RUN curl -fsSL https://raw.githubusercontent.com/AztecProtocol/aztec-packages/master/barretenberg/bbup/install | bash \
 && /root/.bb/bbup -v 5.0.0
ENV BB_BIN=/root/.bb/bb
COPY --from=sunspotd /out/sunspotd /usr/local/bin/sunspotd
ENV SUNSPOTD_BIN=/usr/local/bin/sunspotd
WORKDIR /app
COPY package.json yarn.lock ./
RUN corepack enable && yarn install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
COPY circuit ./circuit
RUN yarn build
ENV CIRCUIT_JSON=/app/circuit/pvium_identity.json VK_PATH=/app/circuit/vk WORK_DIR=/dev/shm PORT=8787 DB_PATH=/app/data/prover.db \
    SUNSPOT_ACIR_PATH=/app/circuit/pvium_identity.sunspot.json
# The outbox (undelivered callback jobs + their attestations) must outlive the container: mount a
# persistent volume at /app/data (Railway: a Railway Volume; docker run: -v prover-data:/app/data).
# Solana proving is off until the environment names its keys: SUNSPOT_PK_URL + SUNSPOT_PK_SHA256
# (the 2.6 GB proving key is fetched once onto the volume, under /app/data/sunspot, and re-checked
# on every start) and SUNSPOT_VK_URL + SUNSPOT_VK_SHA256. The constraint system is compiled on the
# first start and cached beside the key on the volume (276 MB). sunspotd then holds the key resident:
# give the container about 8 GB of memory for Solana, 3 GB per concurrent Ethereum prove otherwise.
# Size the volume for the key, the cache, a re-fetch in progress and the outbox: 6 GB or more.
EXPOSE 8787
CMD ["node", "dist/server.js"]
